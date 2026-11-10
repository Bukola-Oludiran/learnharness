/**
 * Syllabus service (fork, phase 4b — see FORK.md): a course's books and
 * its syllabus.
 *
 *   books     shared from the library: a course lists book ids; the book
 *             itself belongs to no course and may serve several.
 *   build     runs only when the learner asks (owner, 2026-11-10), in this
 *             process, announced through `courses-changed`. A build in
 *             flight lives in a globalThis registry (the turn-liveness
 *             idiom); a restart mid-build leaves the syllabus as it was.
 *   rebuild   replaces the draft; units already covered are kept.
 *   edits     rename, move, skip, delete — synchronous read-modify-write.
 */

import { randomBytes } from "node:crypto";
import { emit } from "../core/events.ts";
import type { CourseRecord, MaterialRecord } from "../core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { buildBlocker, cleanSyllabusNote, deleteUnit, moveUnit, renameUnit, setUnitSkipped, syllabusFromDraft, withoutBook } from "../core/syllabus.ts";
import { stores, type Stores } from "./stores.ts";
import { createSyllabusBuilder, type SyllabusBuilder } from "./syllabus-builder.ts";

export type SyllabusOutcome =
	| { ok: true; course: CourseRecord }
	| { ok: false; status: 400 | 404 | 409; code: string; error: string };

export interface SyllabusDeps {
	stores: Pick<Stores, "courseStore" | "materialStore">;
	build: SyllabusBuilder;
}

interface LhSyllabusGlobal {
	__lhSyllabusBuilds?: Map<string, AbortController>;
}
function builds(): Map<string, AbortController> {
	const g = globalThis as typeof globalThis & LhSyllabusGlobal;
	return (g.__lhSyllabusBuilds ??= new Map());
}

const NO_COURSE = { ok: false, status: 404, code: "course_not_found", error: "No such course" } as const;
const NO_UNIT = { ok: false, status: 404, code: "unit_not_found", error: "No such unit, or the change does not apply to it." } as const;

function failureMessage(error: unknown): string {
	if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError) return error.envelope.error;
	return error instanceof Error && error.message ? error.message : "The syllabus could not be drafted. Retry.";
}

export function createSyllabusService(deps: SyllabusDeps) {
	const { courseStore, materialStore } = deps.stores;

	const readyBooks = (course: CourseRecord): MaterialRecord[] =>
		(course.bookIds ?? [])
			.map((id) => materialStore.getMaterial(id))
			.filter((book): book is MaterialRecord => book !== null && book.kind === "book" && book.status === "ready");

	/** Read-modify-write on the freshest record: a build may land between a
	 *  request's read and its write. Null when the course is gone. */
	function change(courseId: string, edit: (course: CourseRecord) => CourseRecord): CourseRecord | null {
		const course = courseStore.getCourse(courseId);
		if (!course) return null;
		const next = edit(course);
		if (next !== course) courseStore.saveCourse(next);
		return next;
	}

	function edit(courseId: string, apply: (course: CourseRecord) => CourseRecord | null): SyllabusOutcome {
		const course = courseStore.getCourse(courseId);
		if (!course) return NO_COURSE;
		const next = apply(course);
		if (!next) return NO_UNIT;
		courseStore.saveCourse(next);
		return { ok: true, course: next };
	}

	return {
		/** Whether a build is running for the course. */
		isBuilding(courseId: string): boolean {
			return builds().has(courseId);
		},

		/** Add a library book to the course. */
		addBook(courseId: string, materialId: unknown): SyllabusOutcome {
			const course = courseStore.getCourse(courseId);
			if (!course) return NO_COURSE;
			const book = typeof materialId === "string" ? materialStore.getMaterial(materialId) : null;
			if (!book || book.kind !== "book") return { ok: false, status: 404, code: "book_not_found", error: "No such book in the library." };
			if ((course.bookIds ?? []).includes(book.id)) return { ok: true, course };
			const next = { ...course, bookIds: [...(course.bookIds ?? []), book.id] };
			courseStore.saveCourse(next);
			return { ok: true, course: next };
		},

		/** Take a book out of the course (it stays in the library); its
		 *  sections leave the syllabus units that used them. */
		removeBook(courseId: string, materialId: string): SyllabusOutcome {
			const course = courseStore.getCourse(courseId);
			if (!course) return NO_COURSE;
			if (!(course.bookIds ?? []).includes(materialId)) return { ok: false, status: 404, code: "book_not_found", error: "That book is not in this course." };
			const next: CourseRecord = {
				...course,
				bookIds: (course.bookIds ?? []).filter((id) => id !== materialId),
				...(course.syllabus ? { syllabus: withoutBook(course.syllabus, materialId) } : {}),
			};
			courseStore.saveCourse(next);
			return { ok: true, course: next };
		},

		/** Start drafting the syllabus. Returns at once; the result (or the
		 *  reason it failed) lands on the course record. */
		startBuild(courseId: string, note: unknown): SyllabusOutcome {
			const course = courseStore.getCourse(courseId);
			if (!course) return NO_COURSE;
			if (builds().has(courseId)) return { ok: false, status: 409, code: "already_building", error: "The syllabus is already being built." };
			const books = readyBooks(course);
			const blocker = buildBlocker(course, books.length);
			if (blocker) return { ok: false, status: 400, code: "not_ready", error: blocker };
			const cleanedNote = cleanSyllabusNote(note);
			const covered = (course.syllabus?.units ?? []).filter((unit) => unit.status === "covered");
			const controller = new AbortController();
			builds().set(courseId, controller);
			const cleared = change(courseId, (c) => (c.syllabusError === undefined ? c : { ...c, syllabusError: undefined })) ?? course;
			void (async () => {
				try {
					const draft = await deps.build({ title: course.title, goal: course.goal, books, ...(cleanedNote ? { note: cleanedNote } : {}), covered }, controller.signal);
					if (controller.signal.aborted) return;
					// Covered units are re-read at landing: one may have been covered while the builder ran.
					change(courseId, (c) => ({
						...c,
						syllabus: syllabusFromDraft(draft, (c.syllabus?.units ?? []).filter((unit) => unit.status === "covered"), new Date().toISOString(), cleanedNote, () => `unit_${randomBytes(5).toString("hex")}`),
					}));
				} catch (error) {
					if (!controller.signal.aborted) {
						console.error(`[syllabus ${courseId}]`, error);
						change(courseId, (c) => ({ ...c, syllabusError: failureMessage(error) }));
					}
				} finally {
					if (builds().get(courseId) === controller) builds().delete(courseId);
					// The registry entry is part of what the page shows.
					emit("courses-changed", {});
				}
			})();
			return { ok: true, course: cleared };
		},

		/** Stop a build in flight (the course was deleted). */
		cancelBuild(courseId: string): void {
			builds().get(courseId)?.abort();
			builds().delete(courseId);
		},

		renameUnit(courseId: string, unitId: string, title: unknown): SyllabusOutcome {
			return edit(courseId, (course) => {
				const next = course.syllabus ? renameUnit(course.syllabus, unitId, title) : null;
				return next ? { ...course, syllabus: next } : null;
			});
		},
		moveUnit(courseId: string, unitId: string, direction: unknown): SyllabusOutcome {
			if (direction !== "up" && direction !== "down") return NO_UNIT;
			return edit(courseId, (course) => {
				const next = course.syllabus ? moveUnit(course.syllabus, unitId, direction) : null;
				return next ? { ...course, syllabus: next } : null;
			});
		},
		setUnitSkipped(courseId: string, unitId: string, skipped: unknown): SyllabusOutcome {
			return edit(courseId, (course) => {
				const next = course.syllabus ? setUnitSkipped(course.syllabus, unitId, skipped === true) : null;
				return next ? { ...course, syllabus: next } : null;
			});
		},
		deleteUnit(courseId: string, unitId: string): SyllabusOutcome {
			return edit(courseId, (course) => {
				const next = course.syllabus ? deleteUnit(course.syllabus, unitId) : null;
				return next ? { ...course, syllabus: next } : null;
			});
		},
	};
}

export const syllabus = createSyllabusService({ stores, build: createSyllabusBuilder() });

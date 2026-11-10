/**
 * Syllabus domain logic (fork, phase 4b — see FORK.md): pure functions.
 * A syllabus is a course's long-lived plan — units in teaching order, each
 * naming the book sections it draws on and the units it comes after. The
 * builder (a model) drafts it from the books' contents lists; the learner
 * renames, reorders, skips and deletes. No IO.
 */

import { MAX_SYLLABUS_UNITS, SYLLABUS_NOTE_MAX, UNIT_TITLE_MAX, type Syllabus, type SyllabusUnit, type UnitSource } from "./contracts/course.ts";
import type { MaterialRecord, MaterialSection } from "./contracts/material.ts";

/** What the builder needs to know about one book. */
export type SyllabusBook = Pick<MaterialRecord, "id" | "title" | "sections" | "format">;

/** One unit as the builder submits it. */
export interface DraftUnit {
	title: string;
	sections: { book: string; section: string }[];
	/** 1-based numbers of earlier units in the same draft. */
	dependsOn: number[];
}

/** The builder's instructions (wording approved by the owner, 2026-11-10). */
export const SYLLABUS_INSTRUCTIONS = [
	"You plan a course for one learner. You are given the course title, the learner's goal, and the contents lists of the books attached to the course.",
	"Draft the course's units and submit them with submit_syllabus.",
	[
		"- A unit is what one study session can teach: usually one chapter, or a few closely related sections. Split a long chapter and merge very short ones.",
		"- Include only what serves the goal. Leave out front matter, indexes, and chapters the goal does not need.",
		"- Give each unit a short title that names what the learner will understand or be able to do.",
		"- List the book sections each unit draws on, by book id and section id exactly as given. Every unit needs at least one section.",
		"- Order the units so each comes after what it depends on, and list each unit's direct prerequisites by unit number. The first unit has none.",
		"- If the learner left a note, follow it.",
		"- Units listed as already covered are finished. Do not plan them again; later units may build on them.",
	].join("\n"),
].join("\n\n");

/** Above this many sections a book is shown to the builder by chapter only. */
const MAX_CONTENTS_LINES = 250;

const pagesOf = (section: MaterialSection) => (section.pageStart === section.pageEnd ? `${section.pageStart}` : `${section.pageStart}–${section.pageEnd}`);

function contentsFor(book: SyllabusBook): string {
	const chaptersOnly = book.sections.length > MAX_CONTENTS_LINES;
	const shown = (chaptersOnly ? book.sections.filter((section) => section.level === 1) : book.sections).slice(0, MAX_CONTENTS_LINES * 2);
	const unit = book.format === "epub" ? "chapter file" : "page";
	return [
		`Book "${book.title}" (book id ${book.id})${chaptersOnly ? " — chapters only; its sub-sections are not listed" : ""}:`,
		...shown.map((section) => `${section.level > 1 ? "  " : ""}- [${section.id}] ${section.title} (${unit} ${pagesOf(section)})`),
	].join("\n");
}

/** What the builder reads. */
export function syllabusPrompt(input: { title: string; goal: string; books: readonly SyllabusBook[]; note?: string; covered?: readonly SyllabusUnit[] }): string {
	const covered = input.covered ?? [];
	return [
		`Course: ${input.title}`,
		`Goal: ${input.goal}`,
		...(input.note ? [`The learner's note: ${input.note}`] : []),
		...(covered.length > 0 ? [["Already covered:", ...covered.map((unit) => `- ${unit.title}`)].join("\n")] : []),
		...input.books.map(contentsFor),
	].join("\n\n");
}

export function cleanSyllabusNote(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, SYLLABUS_NOTE_MAX) : "";
}

export function cleanUnitTitle(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const title = value.replace(/\s+/g, " ").trim().slice(0, UNIT_TITLE_MAX);
	return title === "" ? null : title;
}

/** Why a draft cannot be stored, in words the builder can act on; null when it can. */
export function draftProblem(draft: readonly DraftUnit[], books: readonly SyllabusBook[]): string | null {
	if (draft.length === 0) return "the syllabus has no units";
	if (draft.length > MAX_SYLLABUS_UNITS) return `the syllabus has ${draft.length} units — use at most ${MAX_SYLLABUS_UNITS}, merging closely related ones`;
	const known = new Map(books.map((book) => [book.id, new Set(book.sections.map((section) => section.id))]));
	for (const [index, unit] of draft.entries()) {
		const number = index + 1;
		if (!cleanUnitTitle(unit.title)) return `unit ${number} has no title`;
		if (unit.sections.length === 0) return `unit ${number} lists no book sections — every unit needs at least one`;
		for (const source of unit.sections) {
			const sections = known.get(source.book);
			if (!sections) return `unit ${number} names book id ${JSON.stringify(source.book)}, which is not one of the course's books`;
			if (!sections.has(source.section)) return `unit ${number} names section ${JSON.stringify(source.section)}, which that book does not have — use section ids exactly as listed`;
		}
		for (const dependency of unit.dependsOn) {
			if (!Number.isInteger(dependency) || dependency < 1 || dependency >= number) return `unit ${number} depends on unit ${dependency} — a unit may only depend on earlier units`;
		}
	}
	return null;
}

/**
 * The stored syllabus for an accepted draft. Units already covered are
 * kept, first and unchanged; everything else is replaced by the draft.
 */
export function syllabusFromDraft(draft: readonly DraftUnit[], covered: readonly SyllabusUnit[], now: string, note: string, newId: () => string): Syllabus {
	const ids = draft.map(() => newId());
	const units: SyllabusUnit[] = draft.map((unit, index) => {
		const sources: UnitSource[] = [];
		for (const source of unit.sections) {
			if (!sources.some((s) => s.materialId === source.book && s.sectionId === source.section)) sources.push({ materialId: source.book, sectionId: source.section });
		}
		return { id: ids[index]!, title: cleanUnitTitle(unit.title)!, dependsOn: [...new Set(unit.dependsOn)].map((n) => ids[n - 1]!), sources, status: "todo" };
	});
	return { units: [...covered, ...units], builtAt: now, ...(note ? { note } : {}) };
}

const mapUnit = (syllabus: Syllabus, unitId: string, change: (unit: SyllabusUnit) => SyllabusUnit): Syllabus | null =>
	syllabus.units.some((unit) => unit.id === unitId) ? { ...syllabus, units: syllabus.units.map((unit) => (unit.id === unitId ? change(unit) : unit)) } : null;

/** Each edit returns the new syllabus, or null when it does not apply. */
export function renameUnit(syllabus: Syllabus, unitId: string, title: unknown): Syllabus | null {
	const cleaned = cleanUnitTitle(title);
	return cleaned ? mapUnit(syllabus, unitId, (unit) => ({ ...unit, title: cleaned })) : null;
}

/** Skip or un-skip. A covered unit stays covered: there is nothing to skip. */
export function setUnitSkipped(syllabus: Syllabus, unitId: string, skipped: boolean): Syllabus | null {
	const unit = syllabus.units.find((u) => u.id === unitId);
	if (!unit || unit.status === "covered" || (unit.status === "skipped") === skipped) return null;
	return mapUnit(syllabus, unitId, (u) => ({ ...u, status: skipped ? "skipped" : "todo" }));
}

export function moveUnit(syllabus: Syllabus, unitId: string, direction: "up" | "down"): Syllabus | null {
	const from = syllabus.units.findIndex((unit) => unit.id === unitId);
	const to = from + (direction === "up" ? -1 : 1);
	if (from < 0 || to < 0 || to >= syllabus.units.length) return null;
	const units = [...syllabus.units];
	[units[from], units[to]] = [units[to]!, units[from]!];
	return { ...syllabus, units };
}

/** Delete a unit; nothing may go on depending on it. */
export function deleteUnit(syllabus: Syllabus, unitId: string): Syllabus | null {
	if (!syllabus.units.some((unit) => unit.id === unitId)) return null;
	return {
		...syllabus,
		units: syllabus.units.filter((unit) => unit.id !== unitId).map((unit) => (unit.dependsOn.includes(unitId) ? { ...unit, dependsOn: unit.dependsOn.filter((id) => id !== unitId) } : unit)),
	};
}

/** A book left the course: its sections leave the units. A unit with no
 *  sections left stays, by title. */
export function withoutBook(syllabus: Syllabus, materialId: string): Syllabus {
	if (!syllabus.units.some((unit) => unit.sources.some((source) => source.materialId === materialId))) return syllabus;
	return { ...syllabus, units: syllabus.units.map((unit) => ({ ...unit, sources: unit.sources.filter((source) => source.materialId !== materialId) })) };
}

/** Why a syllabus cannot be built yet; null when it can. */
export function buildBlocker(course: { goal: string }, readyBooks: number): string | null {
	if (readyBooks === 0) return "Add a book first.";
	if (!course.goal.trim()) return "Add a course goal first: the syllabus is planned around it.";
	return null;
}

/** Mark a unit covered, or back to in progress (it had a session) / to do.
 *  A skipped unit can be covered directly. Null when nothing changes. */
export function setUnitCovered(syllabus: Syllabus, unitId: string, covered: boolean, hasSession = false): Syllabus | null {
	const unit = syllabus.units.find((u) => u.id === unitId);
	if (!unit || (unit.status === "covered") === covered) return null;
	return mapUnit(syllabus, unitId, (u) => ({ ...u, status: covered ? "covered" : hasSession ? "active" : "todo" }));
}

/** A session started on the unit: to do → in progress. Unchanged otherwise. */
export function withUnitActive(syllabus: Syllabus, unitId: string): Syllabus {
	return syllabus.units.some((u) => u.id === unitId && u.status === "todo") ? mapUnit(syllabus, unitId, (u) => ({ ...u, status: "active" }))! : syllabus;
}

/**
 * The unit "Continue course" goes to: the first unit in order that is not
 * covered or skipped and whose prerequisites are all covered, skipped or
 * gone; failing that, the first unfinished unit. Null when none is left.
 */
export function nextUnit(syllabus: Syllabus): SyllabusUnit | null {
	const open = syllabus.units.filter((unit) => unit.status === "todo" || unit.status === "active");
	const settled = new Set(syllabus.units.filter((unit) => unit.status === "covered" || unit.status === "skipped").map((unit) => unit.id));
	const known = new Set(syllabus.units.map((unit) => unit.id));
	return open.find((unit) => unit.dependsOn.every((id) => settled.has(id) || !known.has(id))) ?? open[0] ?? null;
}

/** An idea the learner has recently got wrong (missed) or only partly right (shaky). */
export interface WeakIdea {
	name: string;
	state: "missed" | "shaky";
}

/**
 * The unit block of the tutor's course fragment, for a session scoped to a
 * unit (wording approved by the owner, 2026-11-10). Lines with nothing to
 * say are left out. Null when the unit is not in the syllabus.
 */
export function unitContextBlock(syllabus: Syllabus, unitId: string, books: readonly SyllabusBook[], weak: readonly WeakIdea[] = []): string | null {
	const index = syllabus.units.findIndex((unit) => unit.id === unitId);
	if (index < 0) return null;
	const unit = syllabus.units[index]!;
	const sources = books
		.map((book) => {
			const sections = unit.sources
				.filter((source) => source.materialId === book.id)
				.map((source) => book.sections.find((section) => section.id === source.sectionId))
				.filter((section): section is MaterialSection => section !== undefined);
			return sections.length > 0 ? `- "${book.title}" (id ${book.id}): ${sections.map((section) => `[${section.id}] ${section.title}`).join("; ")}` : null;
		})
		.filter((line): line is string => line !== null);
	const covered = syllabus.units.filter((u) => u.status === "covered" && u.id !== unitId).map((u) => u.title);
	return [
		`This session's unit: "${unit.title}" (unit ${index + 1} of ${syllabus.units.length}).`,
		...(sources.length > 0 ? [["It draws on these book sections. Read them with read_material before teaching:", ...sources].join("\n")] : []),
		...(covered.length > 0 || weak.length > 0
			? [
					[
						...(covered.length > 0 ? [`Units already covered: ${covered.join("; ")}.`] : []),
						...(weak.length > 0 ? [`Ideas from this course the learner has recently got wrong or only partly right: ${weak.map((idea) => `${idea.name} (${idea.state})`).join("; ")}.`] : []),
					].join("\n"),
				]
			: []),
		unit.status === "covered"
			? "This unit is already marked covered; the learner has come back to it."
			: "Teach this unit. When you have taught its material and checked the learner's understanding of it, call mark_unit_covered.",
	].join("\n\n");
}

/**
 * Syllabus (fork, phase 4b — FORK.md): the pure plan logic, the service
 * with a fake builder (books shared from the library, build on request,
 * rebuild keeping covered units, unit edits), the routes, the course
 * fragment's books line, and the course page's Books and Syllabus views.
 * Runs under an isolated LH_DATA_DIR, set before the first config-loading
 * import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-syllabus-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const {
	buildBlocker, deleteUnit, draftProblem, moveUnit, renameUnit, setUnitSkipped, SYLLABUS_INSTRUCTIONS, syllabusFromDraft, syllabusPrompt, withoutBook,
} = await import("../src/core/syllabus.ts");
const { courseContextSegment } = await import("../src/core/course.ts");
const { createSyllabusService } = await import("../src/server/syllabus.ts");
const { courseContextFor } = await import("../src/server/courses.ts");
const { stores } = await import("../src/server/stores.ts");
const booksRoute = await import("../app/api/courses/[id]/books/route.ts");
const syllabusRoute = await import("../app/api/courses/[id]/syllabus/route.ts");
const { CourseBooksBody, SyllabusBody, UnitRow, unitDependsLabel, unitSourcesLabel } = await import("../components/course-syllabus.tsx");
import type { CourseRecord, MaterialRecord, Syllabus, SyllabusUnit } from "../src/core/contracts.ts";
import type { DraftUnit } from "../src/core/syllabus.ts";
import type { SyllabusBuildInput } from "../src/server/syllabus-builder.ts";

const book = (id: string, title: string, sections = 3): Pick<MaterialRecord, "id" | "title" | "sections" | "format"> => ({
	id, title, format: "pdf",
	sections: Array.from({ length: sections }, (_, i) => ({ id: `s${i + 1}`, title: `Chapter ${i + 1}`, level: 1, pageStart: i * 10 + 1, pageEnd: i * 10 + 10 })),
});
const algebra = book("mat_alg", "Algebra");
const unit = (id: string, overrides: Partial<SyllabusUnit> = {}): SyllabusUnit => ({ id, title: `Unit ${id}`, dependsOn: [], sources: [{ materialId: "mat_alg", sectionId: "s1" }], status: "todo", ...overrides });
const draft: DraftUnit[] = [
	{ title: "Sets", sections: [{ book: "mat_alg", section: "s1" }], dependsOn: [] },
	{ title: "Maps", sections: [{ book: "mat_alg", section: "s2" }, { book: "mat_alg", section: "s2" }], dependsOn: [1, 1] },
];

describe("what the builder reads", () => {
	it("names the course, goal, note, covered units and each book's sections by id", () => {
		const prompt = syllabusPrompt({ title: "Abstract algebra", goal: "Pass the qual", books: [algebra], note: "skip chapter 3", covered: [unit("u0", { title: "Warm-up" })] });
		assert.equal(prompt, [
			"Course: Abstract algebra", "Goal: Pass the qual", "The learner's note: skip chapter 3", "Already covered:\n- Warm-up",
			'Book "Algebra" (book id mat_alg):\n- [s1] Chapter 1 (page 1–10)\n- [s2] Chapter 2 (page 11–20)\n- [s3] Chapter 3 (page 21–30)',
		].join("\n\n"));
		assert.doesNotMatch(syllabusPrompt({ title: "t", goal: "g", books: [algebra] }), /note|Already covered/);
	});

	it("shows a very long contents list by chapter only", () => {
		const huge = book("mat_big", "Anthology", 0);
		huge.sections = Array.from({ length: 300 }, (_, i) => ({ id: i % 3 === 0 ? `s${i}` : `s${i}.1`, title: `T${i}`, level: i % 3 === 0 ? 1 : 2, pageStart: i + 1, pageEnd: i + 1 }));
		const prompt = syllabusPrompt({ title: "t", goal: "g", books: [huge] });
		assert.match(prompt, /chapters only; its sub-sections are not listed/);
		assert.equal(prompt.match(/^- \[/gm)!.length, 100);
		assert.doesNotMatch(prompt, /^ {2}- \[/m);
	});

	it("is told what a unit is, to serve the goal, and to leave covered units alone", () => {
		assert.match(SYLLABUS_INSTRUCTIONS, /A unit is what one study session can teach/);
		assert.match(SYLLABUS_INSTRUCTIONS, /Include only what serves the goal\./);
		assert.match(SYLLABUS_INSTRUCTIONS, /Units listed as already covered are finished\. Do not plan them again; later units may build on them\.$/);
	});
});

describe("a draft", () => {
	it("is refused with a reason the builder can act on", () => {
		assert.equal(draftProblem(draft, [algebra]), null);
		assert.match(draftProblem([], [algebra])!, /no units/);
		assert.match(draftProblem(Array.from({ length: 61 }, () => draft[0]!), [algebra])!, /61 units — use at most 60/);
		assert.match(draftProblem([{ ...draft[0]!, title: "  " }], [algebra])!, /unit 1 has no title/);
		assert.match(draftProblem([{ ...draft[0]!, sections: [] }], [algebra])!, /unit 1 lists no book sections/);
		assert.match(draftProblem([{ ...draft[0]!, sections: [{ book: "mat_x", section: "s1" }] }], [algebra])!, /book id "mat_x", which is not one of the course's books/);
		assert.match(draftProblem([{ ...draft[0]!, sections: [{ book: "mat_alg", section: "s9" }] }], [algebra])!, /section "s9", which that book does not have/);
		assert.match(draftProblem([draft[0]!, { ...draft[1]!, dependsOn: [2] }], [algebra])!, /unit 2 depends on unit 2 — a unit may only depend on earlier units/);
		assert.match(draftProblem([{ ...draft[0]!, dependsOn: [0] }], [algebra])!, /may only depend on earlier units/);
	});

	it("becomes units with fresh ids, numbered dependencies resolved, and covered units kept first", () => {
		let n = 0;
		const covered = unit("u_done", { status: "covered", title: "Done" });
		const syllabus = syllabusFromDraft(draft, [covered], "2026-11-10T00:00:00.000Z", "a note", () => `u${++n}`);
		assert.deepEqual(syllabus, {
			builtAt: "2026-11-10T00:00:00.000Z",
			note: "a note",
			units: [
				covered,
				{ id: "u1", title: "Sets", dependsOn: [], sources: [{ materialId: "mat_alg", sectionId: "s1" }], status: "todo" },
				{ id: "u2", title: "Maps", dependsOn: ["u1"], sources: [{ materialId: "mat_alg", sectionId: "s2" }], status: "todo" },
			],
		});
		assert.equal("note" in syllabusFromDraft(draft, [], "t", "", () => "x"), false);
	});
});

describe("editing a syllabus", () => {
	const syllabus: Syllabus = { builtAt: "t", units: [unit("a"), unit("b", { dependsOn: ["a"] }), unit("c", { dependsOn: ["a", "b"], status: "covered" })] };
	const ids = (s: Syllabus | null) => s?.units.map((u) => u.id);

	it("renames, moves, skips and deletes; an edit that does not apply returns null", () => {
		assert.equal(renameUnit(syllabus, "b", "  New   name ")!.units[1]!.title, "New name");
		assert.equal(renameUnit(syllabus, "b", " "), null);
		assert.equal(renameUnit(syllabus, "zz", "x"), null);
		assert.deepEqual(ids(moveUnit(syllabus, "b", "up")), ["b", "a", "c"]);
		assert.deepEqual(ids(moveUnit(syllabus, "b", "down")), ["a", "c", "b"]);
		assert.equal(moveUnit(syllabus, "a", "up"), null);
		assert.equal(moveUnit(syllabus, "c", "down"), null);
		const skipped = setUnitSkipped(syllabus, "a", true)!;
		assert.equal(skipped.units[0]!.status, "skipped");
		assert.equal(setUnitSkipped(skipped, "a", false)!.units[0]!.status, "todo");
		assert.equal(setUnitSkipped(skipped, "a", true), null, "already skipped");
		assert.equal(setUnitSkipped(syllabus, "c", true), null, "a covered unit cannot be skipped");
	});

	it("deleting a unit removes it from what others come after", () => {
		const next = deleteUnit(syllabus, "a")!;
		assert.deepEqual(next.units.map((u) => [u.id, u.dependsOn]), [["b", []], ["c", ["b"]]]);
		assert.equal(deleteUnit(syllabus, "zz"), null);
	});

	it("removing a book takes its sections out of the units and keeps the units", () => {
		const mixed: Syllabus = { builtAt: "t", units: [unit("a", { sources: [{ materialId: "mat_alg", sectionId: "s1" }, { materialId: "mat_geo", sectionId: "s1" }] }), unit("b")] };
		assert.deepEqual(withoutBook(mixed, "mat_alg").units.map((u) => u.sources), [[{ materialId: "mat_geo", sectionId: "s1" }], []]);
		assert.equal(withoutBook(mixed, "mat_none"), mixed);
	});

	it("needs a book and a goal before it can be built", () => {
		assert.equal(buildBlocker({ goal: "g" }, 0), "Add a book first.");
		assert.match(buildBlocker({ goal: "  " }, 1)!, /Add a course goal first/);
		assert.equal(buildBlocker({ goal: "g" }, 1), null);
	});
});

describe("the course fragment", () => {
	it("lists the course's books between the goal and the closing rule", () => {
		assert.equal(courseContextSegment({ title: "Algebra", goal: "Pass" }, [{ id: "mat_1", title: "Dummit" }, { id: "mat_2", title: "Lang" }]), [
			"# Course context", 'This session is part of the learner\'s course "Algebra".', "Course goal: Pass",
			'Course books, readable with read_material:\n- "Dummit" (id mat_1)\n- "Lang" (id mat_2)',
			"Keep the session in service of that goal. The learner's request for this session still decides its topic.",
		].join("\n\n"));
		assert.equal(courseContextSegment({ title: "Algebra", goal: "" }, [{ id: "mat_1", title: "Dummit" }]),
			'# Course context\n\nThis session is part of the learner\'s course "Algebra".\n\nCourse books, readable with read_material:\n- "Dummit" (id mat_1)');
		// With no books the fragment is exactly phase 1's.
		assert.equal(courseContextSegment({ title: "A", goal: "g" }), courseContextSegment({ title: "A", goal: "g" }, []));
		assert.doesNotMatch(courseContextSegment({ title: "A", goal: "g" }), /books/);
	});
});

describe("the syllabus service", () => {
	const calls: SyllabusBuildInput[] = [];
	const behavior = { draft, fails: null as Error | null, gate: null as Promise<void> | null };
	const service = createSyllabusService({
		stores,
		build: async (input) => {
			calls.push(input);
			if (behavior.gate) await behavior.gate;
			if (behavior.fails) throw behavior.fails;
			return behavior.draft;
		},
	});
	const makeBook = (title: string, status: MaterialRecord["status"] = "ready") => {
		const record = stores.materialStore.createMaterial(
			{ title, kind: "book", format: "pdf", fileName: `${title}.pdf`, sections: algebra.sections, status, aiReadParts: 0, sourcePath: `${title}.pdf`, pageCount: 30 },
			[{ bytes: Buffer.from("%PDF-"), extension: "pdf" }],
		);
		return record;
	};
	const course = stores.courseStore.createCourse("Abstract algebra", "Pass the qual");
	const read = () => stores.courseStore.getCourse(course.id)!;
	async function built(): Promise<CourseRecord> {
		for (let i = 0; i < 400; i++) {
			if (!service.isBuilding(course.id)) return read();
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("build never finished");
	}
	const text = makeBook("Algebra");
	// The fake draft names the fixture's id; point it at the stored book.
	behavior.draft = draft.map((u) => ({ ...u, sections: u.sections.map((s) => ({ ...s, book: text.id })) }));

	it("adds library books to a course, shared, and only books", () => {
		assert.equal((service.startBuild(course.id, "") as { error: string }).error, "Add a book first.");
		const added = service.addBook(course.id, text.id);
		assert.ok(added.ok);
		assert.deepEqual(read().bookIds, [text.id]);
		assert.ok(service.addBook(course.id, text.id).ok, "adding twice is a no-op");
		assert.deepEqual(read().bookIds, [text.id]);
		const other = stores.courseStore.createCourse("Number theory", "");
		assert.ok(service.addBook(other.id, text.id).ok, "the same book serves a second course");
		assert.equal(stores.materialStore.getMaterial(text.id)!.courseId, undefined);
		const notes = stores.materialStore.createMaterial({ title: "n", kind: "notes", format: "text", fileName: "n.md", sections: [], status: "ready", aiReadParts: 0, sourcePath: "n.md" }, [{ bytes: Buffer.from("x"), extension: "md" }]);
		assert.equal((service.addBook(course.id, notes.id) as { code: string }).code, "book_not_found");
		assert.equal((service.addBook("course_nope", text.id) as { code: string }).code, "course_not_found");
		assert.equal((service.startBuild(other.id, "") as { error: string }).error, "Add a course goal first: the syllabus is planned around it.");
	});

	it("the tutor is told the course's ready books", () => {
		stores.courseStore.saveCourse({ ...read(), sessions: [{ chatId: "chat_s", kind: "teach", unitIds: [] }] });
		const pending = makeBook("Not ready", "processing");
		assert.ok(service.addBook(course.id, pending.id).ok);
		const fragment = courseContextFor("chat_s")!;
		assert.match(fragment, new RegExp(`Course books, readable with read_material:\\n- "Algebra" \\(id ${text.id}\\)\\n\\nKeep the session`));
		assert.doesNotMatch(fragment, /Not ready/);
		assert.ok(service.removeBook(course.id, pending.id).ok);
	});

	it("builds only when asked, in the background, from the goal and the ready books", async () => {
		assert.equal(read().syllabus, undefined);
		assert.equal(calls.length, 0);
		let open!: () => void;
		behavior.gate = new Promise((resolve) => { open = resolve; });
		const started = service.startBuild(course.id, "  skip chapter 3  ");
		assert.ok(started.ok);
		assert.equal(service.isBuilding(course.id), true);
		assert.equal((service.startBuild(course.id, "") as { code: string }).code, "already_building");
		assert.equal(read().syllabus, undefined, "nothing is stored until the builder submits");
		open();
		const done = await built();
		behavior.gate = null;
		assert.deepEqual([calls[0]!.title, calls[0]!.goal, calls[0]!.note, calls[0]!.books.map((b) => b.id), calls[0]!.covered], ["Abstract algebra", "Pass the qual", "skip chapter 3", [text.id], []]);
		assert.deepEqual(done.syllabus!.units.map((u) => [u.title, u.status, u.sources.length]), [["Sets", "todo", 1], ["Maps", "todo", 1]]);
		assert.deepEqual(done.syllabus!.units[1]!.dependsOn, [done.syllabus!.units[0]!.id]);
		assert.equal(done.syllabus!.note, "skip chapter 3");
		assert.match(done.syllabus!.units[0]!.id, /^unit_[a-f0-9]{10}$/);
	});

	it("edits units through the route", async () => {
		const [sets, maps] = read().syllabus!.units;
		const patch = async (body: object) => {
			const res = await syllabusRoute.PATCH(new Request("http://test/api", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: course.id }) });
			return { status: res.status, body: (await res.json()) as { course?: CourseRecord; code?: string } };
		};
		assert.equal((await patch({ unitId: maps!.id, op: "rename", title: "Functions" })).body.course!.syllabus!.units[1]!.title, "Functions");
		assert.deepEqual((await patch({ unitId: maps!.id, op: "move", direction: "up" })).body.course!.syllabus!.units.map((u) => u.id), [maps!.id, sets!.id]);
		assert.equal((await patch({ unitId: sets!.id, op: "skip", skipped: true })).body.course!.syllabus!.units[1]!.status, "skipped");
		assert.equal((await patch({ unitId: sets!.id, op: "skip", skipped: false })).body.course!.syllabus!.units[1]!.status, "todo");
		assert.deepEqual([(await patch({ unitId: maps!.id, op: "move", direction: "sideways" })).status, (await patch({ unitId: "unit_nope", op: "delete" })).status], [404, 404]);
		assert.deepEqual([(await patch({ unitId: maps!.id, op: "explode" })).status, (await patch({ unitId: maps!.id, op: "rename", title: "" })).status], [400, 404]);
		const deleted = await patch({ unitId: sets!.id, op: "delete" });
		assert.deepEqual(deleted.body.course!.syllabus!.units.map((u) => [u.title, u.dependsOn]), [["Functions", []]]);
		const status = await syllabusRoute.GET(new Request("http://test/api"), { params: Promise.resolve({ id: course.id }) });
		assert.deepEqual(await status.json(), { building: false });
	});

	it("a rebuild replaces the draft and keeps covered units", async () => {
		const current = read();
		stores.courseStore.saveCourse({ ...current, syllabus: { ...current.syllabus!, units: current.syllabus!.units.map((u) => ({ ...u, status: "covered" as const })) } });
		assert.ok(service.startBuild(course.id, "").ok);
		const done = await built();
		// The route refuses what the service refuses.
		const refused = await syllabusRoute.POST(new Request("http://test/api", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "course_nope" }) });
		assert.equal(refused.status, 404);
		assert.deepEqual(calls.at(-1)!.covered!.map((u) => u.title), ["Functions"]);
		assert.deepEqual(done.syllabus!.units.map((u) => [u.title, u.status]), [["Functions", "covered"], ["Sets", "todo"], ["Maps", "todo"]]);
		assert.equal("note" in done.syllabus!, false);
	});

	it("a failed build says why, keeps the syllabus, and the next build clears the reason", async () => {
		const before = read().syllabus;
		behavior.fails = new Error("You've hit your usage limit.");
		assert.ok(service.startBuild(course.id, "").ok);
		const failed = await built();
		assert.equal(failed.syllabusError, "You've hit your usage limit.");
		assert.deepEqual(failed.syllabus, before);
		behavior.fails = null;
		assert.ok(service.startBuild(course.id, "").ok);
		assert.equal(read().syllabusError, undefined);
		assert.equal((await built()).syllabusError, undefined);
	});

	it("removing a book leaves it in the library and takes its sections out of the units", async () => {
		const res = await booksRoute.DELETE(new Request(`http://test/api?materialId=${text.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: course.id }) });
		assert.equal(res.status, 200);
		const after = read();
		assert.deepEqual(after.bookIds, []);
		assert.ok(after.syllabus!.units.length > 0 && after.syllabus!.units.every((u) => u.sources.length === 0));
		assert.ok(stores.materialStore.getMaterial(text.id), "the book is still in the library");
		assert.equal((service.removeBook(course.id, text.id) as { code: string }).code, "book_not_found");
		const add = await booksRoute.POST(new Request("http://test/api", { method: "POST", body: JSON.stringify({ materialId: text.id }) }), { params: Promise.resolve({ id: course.id }) });
		assert.deepEqual(((await add.json()) as { course: CourseRecord }).course.bookIds, [text.id]);
	});

	it("a cancelled build stores nothing", async () => {
		let open!: () => void;
		behavior.gate = new Promise((resolve) => { open = resolve; });
		const before = read().syllabus;
		assert.ok(service.startBuild(course.id, "").ok);
		service.cancelBuild(course.id);
		assert.equal(service.isBuilding(course.id), false);
		open();
		await new Promise((resolve) => setTimeout(resolve, 20));
		behavior.gate = null;
		assert.deepEqual(read().syllabus, before);
		assert.equal(read().syllabusError, undefined);
	});
});

describe("the course page's Books and Syllabus", () => {
	const noop = () => {};
	const books = [{ ...algebra, status: "ready" as const, pageCount: 30 }];
	const units = [unit("a", { title: "Sets" }), unit("b", { title: "Maps", dependsOn: ["a"], sources: [{ materialId: "mat_alg", sectionId: "s2" }, { materialId: "mat_alg", sectionId: "s3" }, { materialId: "mat_gone", sectionId: "s1" }] })];

	it("labels a unit with its sections and what it comes after", () => {
		assert.equal(unitSourcesLabel(units[1]!, books), "Algebra · Chapter 2 (p. 11–20); Chapter 3 (p. 21–30)");
		assert.equal(unitDependsLabel(units[1]!, units), "After: Sets");
		assert.equal(unitDependsLabel(units[0]!, units), "");
	});

	it("lists the course's books and offers the rest of the library", () => {
		const body = (overrides: object = {}) =>
			renderToStaticMarkup(<CourseBooksBody books={books} library={[{ ...book("mat_2", "Lang"), status: "ready", pageCount: 9 }, { ...book("mat_3", "Slow"), status: "processing", pageCount: 0 }]} picking={false} error={null} onTogglePicking={noop} onAdd={noop} onRemove={noop} {...overrides} />);
		assert.match(body(), /data-testid="course-book"[\s\S]*Algebra[\s\S]*3 sections · 30 pages[\s\S]*data-testid="course-remove-book"/);
		assert.doesNotMatch(body(), /course-book-picker/);
		const picking = body({ picking: true });
		assert.equal(picking.match(/data-testid="course-book-option"/g)!.length, 2);
		assert.match(picking, /data-testid="course-book-option" disabled=""[^>]*>[\s\S]*?Slow[\s\S]*?Not ready/);
		assert.match(body({ books: [] }), /data-testid="course-books-empty"/);
		assert.match(body({ picking: true, library: [] }), /No other books in your Library/);
		assert.match(body({ error: "Could not add the book." }), /role="alert"[^>]*>Could not add the book\./);
	});

	it("offers Build only when there is a goal and a book, and says what is missing", () => {
		const body = (overrides: object = {}) =>
			renderToStaticMarkup(<SyllabusBody course={{ goal: "Pass" }} readyBooks={1} building={false} error={null} rebuilding={false} note="" onNote={noop} onBuild={noop} onToggleRebuild={noop} {...overrides} />);
		assert.match(body(), /data-testid="syllabus-build-confirm"[^>]*>Build syllabus/);
		assert.doesNotMatch(body(), /data-testid="syllabus-build-confirm"[^>]* disabled=""/);
		assert.match(body({ readyBooks: 0 }), /Add a book first\.[\s\S]*data-testid="syllabus-build-confirm"[^>]* disabled=""/);
		assert.match(body({ course: { goal: "" } }), /Add a course goal first/);
		assert.match(body({ building: true }), /data-testid="syllabus-building"/);
		assert.doesNotMatch(body({ building: true }), /syllabus-build-confirm|syllabus-rebuild/);
		assert.match(body({ course: { goal: "Pass", syllabusError: "Usage limit." } }), /role="alert"[^>]*>Usage limit\.[\s\S]*>Retry</);
	});

	it("shows units with their controls, and a rebuild panel that warns it replaces edits", () => {
		const row = (u: SyllabusUnit, overrides: object = {}) =>
			renderToStaticMarkup(<UnitRow unit={u} number={2} units={units} books={books} first={false} last={true} renaming={false} draftTitle="" onDraftTitle={noop} onStartRename={noop} onCommitRename={noop} onCancelRename={noop} onMove={noop} onSkip={noop} onDelete={noop} {...overrides} />);
		const html = row(units[1]!);
		assert.match(html, /Maps[\s\S]*Algebra · Chapter 2[\s\S]*After: Sets/);
		assert.match(html, /data-testid="syllabus-unit-down"[^>]* disabled=""/);
		assert.doesNotMatch(html, /data-testid="syllabus-unit-up"[^>]* disabled=""/);
		assert.match(html, /data-testid="syllabus-unit-skip"[^>]*>Skip</);
		assert.match(row({ ...units[1]!, status: "skipped" }), /data-status="skipped"[\s\S]*Skipped[\s\S]*>Un-skip</);
		assert.doesNotMatch(row({ ...units[1]!, status: "covered" }), /syllabus-unit-skip/);
		assert.match(row(units[1]!, { renaming: true, draftTitle: "New" }), /data-testid="syllabus-unit-title-input"[^>]*value="New"/);
		const withUnits = (overrides: object = {}) =>
			renderToStaticMarkup(
				<SyllabusBody course={{ goal: "Pass", syllabus: { builtAt: "t", units } }} readyBooks={1} building={false} error={null} rebuilding={false} note="" onNote={noop} onBuild={noop} onToggleRebuild={noop} {...overrides}>
					<span data-testid="rows" />
				</SyllabusBody>,
			);
		assert.match(withUnits(), /data-testid="syllabus-rebuild"[^>]*>Rebuild…[\s\S]*data-testid="rows"/);
		assert.doesNotMatch(withUnits(), /syllabus-note-panel/);
		assert.match(withUnits({ rebuilding: true }), /This replaces the current syllabus and your edits to it\. Covered units are kept\.[\s\S]*>Replace the syllabus</);
	});
});

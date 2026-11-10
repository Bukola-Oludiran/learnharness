/**
 * Unit sessions and quiz evidence (fork, phase 4c — FORK.md): unit
 * scoping at session creation, the unit block of the tutor's fragment,
 * mark_unit_covered and the learner's override, "continue" order, and
 * quiz answers matched to the lesson's ideas after a turn settles. Runs
 * under an isolated LH_DATA_DIR, set before the first config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-units-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { nextUnit, setUnitCovered, unitContextBlock, withUnitActive } = await import("../src/core/syllabus.ts");
const { QUIZ_LINKER_INSTRUCTIONS, quizEvidenceOf, quizResultsOf } = await import("../src/core/evidence.ts");
const { addSessionToCourse, courseContextFor, getCourse } = await import("../src/server/courses.ts");
const { syllabus } = await import("../src/server/syllabus.ts");
const { coveredResultText, materialToolsFor, unitToolFor } = await import("../src/server/material-tools.ts");
const { createQuizEvidenceSync } = await import("../src/server/quiz-evidence.ts");
const { weakIdeasForCourse, evidenceView } = await import("../src/server/evidence.ts");
const { stores } = await import("../src/server/stores.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const syllabusRoute = await import("../app/api/courses/[id]/syllabus/route.ts");
const { SyllabusBody, UnitRow, unitOpeningPrompt } = await import("../components/course-syllabus.tsx");
import type { CourseRecord, Syllabus, SyllabusUnit } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const unit = (id: string, overrides: Partial<SyllabusUnit> = {}): SyllabusUnit => ({ id, title: `Unit ${id}`, dependsOn: [], sources: [], status: "todo", ...overrides });
const book = { id: "mat_alg", title: "Algebra", format: "pdf" as const, sections: [{ id: "s1", title: "Sets", level: 1, pageStart: 1, pageEnd: 9 }, { id: "s1.1", title: "Unions", level: 2, pageStart: 3, pageEnd: 4 }, { id: "s2", title: "Maps", level: 1, pageStart: 10, pageEnd: 20 }] };

describe("which unit comes next", () => {
	it("is the first unfinished unit whose prerequisites are covered or skipped", () => {
		const units = [unit("a", { status: "covered" }), unit("b", { dependsOn: ["c"] }), unit("c", { dependsOn: ["a"] }), unit("d", { dependsOn: ["gone"], status: "active" })];
		assert.equal(nextUnit({ builtAt: "t", units })!.id, "c");
		assert.equal(nextUnit({ builtAt: "t", units: units.map((u) => (u.id === "c" ? { ...u, status: "skipped" as const } : u)) })!.id, "b");
		// Prerequisites that can never be met do not strand the course.
		assert.equal(nextUnit({ builtAt: "t", units: [unit("x", { dependsOn: ["y"] }), unit("y", { dependsOn: ["x"] })] })!.id, "x");
		assert.equal(nextUnit({ builtAt: "t", units: [unit("a", { status: "covered" }), unit("b", { status: "skipped" })] }), null);
	});

	it("marks covered and back, and a started unit in progress", () => {
		const s: Syllabus = { builtAt: "t", units: [unit("a"), unit("b", { status: "skipped" })] };
		assert.equal(setUnitCovered(s, "a", true)!.units[0]!.status, "covered");
		assert.equal(setUnitCovered(s, "b", true)!.units[1]!.status, "covered");
		assert.equal(setUnitCovered(s, "a", false), null);
		const covered = setUnitCovered(s, "a", true)!;
		assert.equal(setUnitCovered(covered, "a", false)!.units[0]!.status, "todo");
		assert.equal(setUnitCovered(covered, "a", false, true)!.units[0]!.status, "active");
		assert.equal(withUnitActive(s, "a").units[0]!.status, "active");
		assert.equal(withUnitActive(s, "b"), s, "a skipped unit is not started by accident");
	});
});

describe("the unit block the tutor reads", () => {
	const s: Syllabus = {
		builtAt: "t",
		units: [
			unit("a", { title: "Sets", status: "covered" }),
			unit("b", { title: "Maps", sources: [{ materialId: "mat_alg", sectionId: "s2" }, { materialId: "mat_alg", sectionId: "s1.1" }, { materialId: "mat_gone", sectionId: "s1" }] }),
			unit("c", { title: "Groups" }),
		],
	};

	it("names the unit, its sections, what is covered and what the learner is weak on", () => {
		assert.equal(unitContextBlock(s, "b", [book], [{ name: "Union", state: "missed" }, { name: "Subset", state: "shaky" }]), [
			'This session\'s unit: "Maps" (unit 2 of 3).',
			'It draws on these book sections. Read them with read_material before teaching:\n- "Algebra" (id mat_alg): [s2] Maps; [s1.1] Unions',
			"Units already covered: Sets.\nIdeas from this course the learner has recently got wrong or only partly right: Union (missed); Subset (shaky).",
			"Teach this unit. When you have taught its material and checked the learner's understanding of it, call mark_unit_covered.",
		].join("\n\n"));
	});

	it("leaves out lines with nothing to say", () => {
		assert.equal(unitContextBlock({ builtAt: "t", units: [unit("c", { title: "Groups" })] }, "c", [book]),
			'This session\'s unit: "Groups" (unit 1 of 1).\n\nTeach this unit. When you have taught its material and checked the learner\'s understanding of it, call mark_unit_covered.');
		assert.match(unitContextBlock(s, "a", [book])!, /This unit is already marked covered; the learner has come back to it\.$/);
		assert.doesNotMatch(unitContextBlock(s, "a", [book])!, /Units already covered/);
		assert.equal(unitContextBlock(s, "zz", [book]), null);
	});
});

describe("a session scoped to a unit", () => {
	const course = stores.courseStore.createCourse("Abstract algebra", "Pass the qual");
	const stored = stores.materialStore.createMaterial(
		{ title: "Algebra", kind: "book", format: "pdf", fileName: "Algebra.pdf", sections: book.sections, status: "ready", aiReadParts: 0, sourcePath: "Algebra.pdf", pageCount: 20 },
		[{ bytes: Buffer.from("%PDF-"), extension: "pdf" }],
	);
	const units = [unit("unit_a", { title: "Sets", sources: [{ materialId: stored.id, sectionId: "s1" }] }), unit("unit_b", { title: "Maps", dependsOn: ["unit_a"] })];
	stores.courseStore.saveCourse({ ...course, bookIds: [stored.id], syllabus: { builtAt: "t", units } });
	const read = () => stores.courseStore.getCourse(course.id)!;
	let chatId = "";

	it("is created through the chats route with the unit, which becomes in progress", async () => {
		const res = await chatsRoute.POST(new Request("http://test/api/chats", { method: "POST", body: JSON.stringify({ title: unitOpeningPrompt(units[0]!), courseId: course.id, unitId: "unit_a" }) }));
		assert.equal(res.status, 200);
		chatId = ((await res.json()) as { id: string }).id;
		assert.deepEqual(read().sessions, [{ chatId, kind: "teach", unitIds: ["unit_a"] }]);
		assert.deepEqual(read().syllabus!.units.map((u) => u.status), ["active", "todo"]);
		assert.equal(stores.chatStore.getChat(chatId)!.title, "Start the unit: Sets");
		// An unknown unit scopes to nothing rather than failing the start.
		const loose = stores.chatStore.createChat("loose");
		assert.ok(addSessionToCourse(course.id, loose.id, "unit_nope").ok);
		assert.deepEqual(read().sessions.at(-1), { chatId: loose.id, kind: "teach", unitIds: [] });
	});

	it("tells the tutor the unit after the course lines, and gives it mark_unit_covered", () => {
		const fragment = courseContextFor(chatId)!;
		assert.match(fragment, /^# Course context\n\nThis session is part of the learner's course "Abstract algebra"\.\n\nCourse goal: Pass the qual\n\nCourse books, readable with read_material:/);
		assert.match(fragment, new RegExp(`Keep the session in service of that goal[^\\n]*\\n\\nThis session's unit: "Sets" \\(unit 1 of 2\\)\\.\\n\\nIt draws on these book sections\\. Read them with read_material before teaching:\\n- "Algebra" \\(id ${stored.id}\\): \\[s1\\] Sets\\n\\nTeach this unit\\.`));
		assert.deepEqual(materialToolsFor(chatId).map((tool) => tool.name), ["ingest_material", "material_status", "read_material", "mark_unit_covered"]);
		const loose = read().sessions.at(-1)!.chatId;
		assert.doesNotMatch(courseContextFor(loose)!, /This session's unit/);
		assert.deepEqual(materialToolsFor(loose).map((tool) => tool.name), ["ingest_material", "material_status", "read_material"]);
		assert.equal(unitToolFor("chat_in_no_course"), null);
	});

	it("the tutor marks the unit covered and is told what comes next", async () => {
		const tool = unitToolFor(chatId)!;
		assert.match(tool.description, /Call it once, when you have taught the unit's material and the learner's answers show they understood it\./);
		assert.match(tool.description, /Do not call it because time has passed or the learner wants to stop early/);
		const run = async () => ((await tool.execute("call", {} as never, undefined as never)).content as { text: string }[])[0]!.text;
		assert.equal(await run(), 'Unit "Sets" is marked covered. The next unit is "Maps". Tell the learner.');
		assert.deepEqual(read().syllabus!.units.map((u) => u.status), ["covered", "todo"]);
		assert.equal(await run(), 'Unit "Sets" is marked covered. The next unit is "Maps". Tell the learner.', "calling again changes nothing");
		assert.equal(coveredResultText("Maps", null), 'Unit "Maps" is marked covered. That was the last unit of the syllabus. Tell the learner.');
		assert.match(courseContextFor(chatId)!, /This unit is already marked covered; the learner has come back to it\.$/);
	});

	it("the learner overrides covered through the route; a unit with a session goes back to in progress", async () => {
		const patch = async (body: object) => {
			const res = await syllabusRoute.PATCH(new Request("http://test/api", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: course.id }) });
			return { status: res.status, course: ((await res.json()) as { course?: CourseRecord }).course };
		};
		assert.equal((await patch({ unitId: "unit_a", op: "cover", covered: false })).course!.syllabus!.units[0]!.status, "active");
		assert.equal((await patch({ unitId: "unit_b", op: "cover", covered: true })).course!.syllabus!.units[1]!.status, "covered");
		assert.equal((await patch({ unitId: "unit_b", op: "cover", covered: false })).course!.syllabus!.units[1]!.status, "todo");
		assert.equal((await patch({ unitId: "unit_b", op: "cover", covered: false })).status, 404, "nothing to change");
		assert.ok(syllabus.setUnitCovered(course.id, "unit_a", true).ok);
	});

	it("a deleted unit leaves the session unscoped and without the tool", () => {
		assert.ok(syllabus.deleteUnit(course.id, "unit_a").ok);
		assert.doesNotMatch(courseContextFor(chatId)!, /This session's unit/);
		assert.equal(unitToolFor(chatId), null);
		assert.deepEqual(getCourse(course.id)!.sessions[0]!.unitIds, ["unit_a"], "the membership line is kept as written");
	});
});

describe("quiz answers as evidence", () => {
	let clock = 1_800_000_200_000;
	const call = (id: string, name: string) => ({ id: `a_${id}`, role: "assistant", stopReason: "toolUse", timestamp: clock++, content: [{ type: "toolCall", id, name, arguments: {} }] });
	const answer = (id: string, name: string, details: object | null, isError = false) =>
		({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "{}" }], isError, timestamp: clock++, details });
	const graded = (question: string, extra: object) => ({ kind: "quiz", questionText: question, dontKnow: false, answers: [], answeredAt: "2026-11-10T10:00:00.000Z", ...extra });
	const messages = [
		call("p1", "probe"), answer("p1", "probe", graded("Probe question", { correct: true })),
		call("q1", "quiz"), answer("q1", "quiz", graded("  What is a union?  ", { correct: true, questionType: "check" })),
		call("q2", "quiz"), answer("q2", "quiz", graded("Is every map injective?", { correct: false })),
		call("q3", "quiz"), answer("q3", "quiz", graded("Guess before we start", { correct: false, questionType: "predict" })),
		call("q4", "quiz"), answer("q4", "quiz", { ...graded("Define a group", {}), dontKnow: true }),
		call("q5", "quiz"), answer("q5", "quiz", { ...graded("Dismissed", { correct: true }), dismissed: true }),
		call("q6", "quiz"), answer("q6", "quiz", null, true),
		call("e1", "explain"), answer("e1", "explain", { kind: "explain", questionText: "Explain closure", dontKnow: false, answers: [], answeredAt: "2026-11-10T10:00:00.000Z" }),
		call("q7", "quiz"),
	] as unknown as LhMessage[];

	it("counts teach-phase multiple-choice verdicts only", () => {
		assert.deepEqual(quizResultsOf(messages), [
			{ toolCallId: "q1", question: "What is a union?", outcome: "correct", at: "2026-11-10T10:00:00.000Z" },
			{ toolCallId: "q2", question: "Is every map injective?", outcome: "wrong", at: "2026-11-10T10:00:00.000Z" },
			{ toolCallId: "q4", question: "Define a group", outcome: "wrong", at: "2026-11-10T10:00:00.000Z" },
		]);
		assert.deepEqual(quizEvidenceOf("chat_1", quizResultsOf(messages)[0]!, ["n1", "n1"], { courseId: "course_1", unitId: "unit_a" }), {
			id: "quiz:chat_1:q1", at: "2026-11-10T10:00:00.000Z", nodeIds: ["n1"], from: "quiz", outcome: "correct", summary: "What is a union?", chatId: "chat_1", courseId: "course_1", unitId: "unit_a",
		});
		assert.match(QUIZ_LINKER_INSTRUCTIONS, /a list of ideas that lesson added to the learner's knowledge graph/);
	});

	const asked: { questions: string[]; ideas: string[] }[] = [];
	const behavior = { links: (questions: readonly { question: string }[]): string[][] => questions.map(() => []), fails: false };
	const sync = createQuizEvidenceSync({
		stores,
		link: async (questions, ideas) => {
			asked.push({ questions: questions.map((q) => q.question), ideas: ideas.map((idea) => idea.id) });
			if (behavior.fails) throw new Error("usage limit");
			return behavior.links(questions);
		},
	});
	const course = stores.courseStore.createCourse("Sets and maps", "g");
	const chat = stores.chatStore.createChat("Lesson on sets");
	stores.courseStore.saveCourse({ ...stores.courseStore.getCourse(course.id)!, sessions: [{ chatId: chat.id, kind: "teach", unitIds: ["unit_s"] }] });
	stores.chatStore.saveMessages(chat.id, messages);
	const mine = () => stores.evidenceStore.read().filter((entry) => entry.chatId === chat.id);
	const node = (id: string, name: string, chatId: string) =>
		stores.graphStore.appendNode({ id, name, statement: `${name} statement.`, aliases: [], createdAt: "2026-11-10T00:00:00.000Z", provenance: [{ chatId, messageId: "m" }] });

	it("waits until the lesson's ideas are in the graph", async () => {
		node("n_elsewhere", "Unrelated", "chat_other");
		assert.equal(await sync(chat.id), 0);
		assert.equal(asked.length, 0, "no model call without candidate ideas");
	});

	it("records the answers that match an idea, scoped to the course and unit, and retries the rest later", async () => {
		node("n_union", "Union", chat.id);
		behavior.links = (questions) => questions.map((q) => (q.question.includes("union") ? ["n_union", "n_invented"] : []));
		assert.equal(await sync(chat.id), 1);
		assert.deepEqual(asked.at(-1), { questions: ["What is a union?", "Is every map injective?", "Define a group"], ideas: ["n_union"] });
		assert.deepEqual(mine().map((e) => [e.id, e.from, e.outcome, e.nodeIds, e.courseId, e.unitId]), [[`quiz:${chat.id}:q1`, "quiz", "correct", ["n_union"], course.id, "unit_s"]]);
		// Nothing new in the graph: the unmatched answers are not asked about again.
		const calls = asked.length;
		assert.equal(await sync(chat.id), 0);
		assert.equal(asked.length, calls);
		// More of the lesson lands: only the unrecorded answers go back, against the larger set.
		node("n_inj", "Injective map", chat.id);
		behavior.links = (questions) => questions.map((q) => (q.question.includes("injective") ? ["n_inj"] : []));
		assert.equal(await sync(chat.id), 1);
		assert.deepEqual(asked.at(-1), { questions: ["Is every map injective?", "Define a group"], ideas: ["n_union", "n_inj"] });
		assert.deepEqual(mine().map((e) => e.outcome), ["correct", "wrong"]);
	});

	it("shows on the idea, and in the course's weak ideas", () => {
		const view = evidenceView();
		assert.equal(view.states.n_union, "demonstrated");
		assert.equal(view.states.n_inj, "missed");
		assert.deepEqual(view.results.n_inj!.map((r) => [r.from, r.outcome, r.summary, r.source]), [["quiz", "wrong", "Is every map injective?", { label: "Lesson on sets", href: `/chat/${chat.id}` }]]);
		assert.deepEqual(weakIdeasForCourse(course.id), [{ name: "Injective map", state: "missed" }]);
		assert.deepEqual(weakIdeasForCourse("course_other"), []);
	});

	it("a failed match records nothing and is tried again", async () => {
		node("n_group", "Group", chat.id);
		behavior.fails = true;
		await assert.rejects(sync(chat.id), /usage limit/);
		behavior.fails = false;
		behavior.links = (questions) => questions.map(() => ["n_group"]);
		assert.equal(await sync(chat.id), 1);
		assert.equal(mine().length, 3);
		assert.equal(await sync(chat.id), 0, "everything is recorded");
	});

	it("ignores practice sessions and unknown chats", async () => {
		const practice = stores.chatStore.createChat("Drills", "practice");
		stores.chatStore.saveMessages(practice.id, messages);
		node("n_p", "P", practice.id);
		assert.equal(await sync(practice.id), 0);
		assert.equal(await sync("chat_nope"), 0);
	});
});

describe("the syllabus view's session controls", () => {
	const noop = () => {};
	const units = [unit("a", { title: "Sets", status: "covered" }), unit("b", { title: "Maps", status: "active" }), unit("c", { title: "Groups", status: "skipped" })];
	const row = (u: SyllabusUnit, overrides: object = {}) =>
		renderToStaticMarkup(
			<UnitRow unit={u} number={1} units={units} books={[]} first last renaming={false} draftTitle="" onDraftTitle={noop} onStartRename={noop} onCommitRename={noop} onCancelRename={noop}
				onMove={noop} onSkip={noop} onDelete={noop} onStart={noop} onCover={noop} {...overrides} />,
		);

	it("a unit starts a session, or opens the one it has, and can be marked by hand", () => {
		assert.match(row(unit("x")), /data-testid="syllabus-unit-start"[^>]*>Start<[\s\S]*data-testid="syllabus-unit-cover"[^>]*>Mark covered</);
		assert.match(row(units[1]!, { hasSession: true }), /In progress[\s\S]*>Open session</);
		assert.match(row(units[0]!), /Covered[\s\S]*data-testid="syllabus-unit-cover"[^>]*>Not covered</);
		assert.doesNotMatch(row(units[2]!), /syllabus-unit-start|syllabus-unit-cover/);
		assert.match(row(unit("x"), { starting: true }), /data-testid="syllabus-unit-start" disabled=""/);
		assert.equal(unitOpeningPrompt({ title: "Sets" }), "Start the unit: Sets");
	});

	it("Continue course names the next unit, and goes away when every unit is done", () => {
		const body = (list: SyllabusUnit[], overrides: object = {}) =>
			renderToStaticMarkup(<SyllabusBody course={{ goal: "g", syllabus: { builtAt: "t", units: list } }} readyBooks={1} building={false} error={null} rebuilding={false} note="" onNote={noop} onBuild={noop} onToggleRebuild={noop} onContinue={noop} {...overrides} />);
		assert.match(body(units), /data-testid="syllabus-continue" title="Next: Maps"[^>]*>Continue course</);
		assert.match(body(units, { starting: true }), /data-testid="syllabus-continue"[^>]* disabled=""[^>]*>Starting…/);
		const done = body([units[0]!, units[2]!]);
		assert.doesNotMatch(done, /syllabus-continue/);
		assert.match(done, /data-testid="syllabus-done"[^>]*>Every unit is covered or skipped\./);
		assert.doesNotMatch(body(units, { building: true }), /syllabus-continue/);
	});
});

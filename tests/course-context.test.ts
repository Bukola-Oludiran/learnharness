/**
 * The course-context prompt segment (fork, phase 1 — FORK.md): its approved
 * wording, and the agent seam that appends it. The upstream guarantee is
 * the second half: with no course, the prompt is byte-identical to the
 * composed instructions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import { composeInstructions, createPracticeAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { courseContextSegment, courseOfSession, withLiveSessions, withSession, withoutSession } from "../src/core/course.ts";
import type { CourseRecord } from "../src/core/contracts.ts";

function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function course(overrides: Partial<CourseRecord> = {}): CourseRecord {
	return { id: "course_a", title: "Linear algebra", goal: "", materialIds: [], sessions: [], createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", ...overrides };
}

describe("courseContextSegment", () => {
	it("carries the approved wording", () => {
		assert.equal(
			courseContextSegment({ title: "Linear algebra", goal: "Read Strang cover to cover." }),
			[
				"# Course context",
				'This session is part of the learner\'s course "Linear algebra".',
				"Course goal: Read Strang cover to cover.",
				"Keep the session in service of that goal. The learner's request for this session still decides its topic.",
			].join("\n\n"),
		);
	});

	it("a course with no goal contributes its title line only", () => {
		assert.equal(
			courseContextSegment({ title: "Linear algebra", goal: "" }),
			'# Course context\n\nThis session is part of the learner\'s course "Linear algebra".',
		);
	});
});

describe("the agent seam", () => {
	it("appends the segment after the composed prompt, for teaching and practice agents", () => {
		const segment = courseContextSegment({ title: "Linear algebra", goal: "Pass." });
		const teacher = createTeacherAgent(undefined, { engine: fauxEngine(), courseContext: segment });
		assert.equal(teacher.state.systemPrompt, `${composeInstructions("teacher")}\n\n---\n\n${segment}`);
		const practice = createPracticeAgent({} as never, { engine: fauxEngine(), tools: {}, courseContext: segment });
		assert.equal(practice.state.systemPrompt, `${composeInstructions("practice")}\n\n---\n\n${segment}`);
	});

	it("no course → the prompt is byte-identical to upstream's composition", () => {
		const agent = createTeacherAgent(undefined, { engine: fauxEngine() });
		assert.equal(agent.state.systemPrompt, composeInstructions("teacher"));
	});
});

describe("membership edits are pure and identity-preserving when nothing changes", () => {
	const session = { chatId: "chat_1", kind: "teach" as const, unitIds: [] };

	it("withSession appends once and bumps updatedAt", () => {
		const base = course();
		const added = withSession(base, session, "2026-11-10T00:00:00.000Z");
		assert.deepEqual(added.sessions, [session]);
		assert.equal(added.updatedAt, "2026-11-10T00:00:00.000Z");
		assert.equal(withSession(added, session, "2026-11-11T00:00:00.000Z"), added);
		assert.deepEqual(base.sessions, []);
	});

	it("withoutSession and withLiveSessions return the same record when nothing leaves", () => {
		const base = course({ sessions: [session] });
		assert.equal(withoutSession(base, "chat_other"), base);
		assert.deepEqual(withoutSession(base, "chat_1").sessions, []);
		assert.equal(withLiveSessions(base, () => true), base);
		assert.deepEqual(withLiveSessions(base, () => false).sessions, []);
	});

	it("courseOfSession finds the listing course", () => {
		const a = course({ id: "course_a" });
		const b = course({ id: "course_b", sessions: [session] });
		assert.equal(courseOfSession([a, b], "chat_1"), b);
		assert.equal(courseOfSession([a, b], "chat_2"), null);
	});
});

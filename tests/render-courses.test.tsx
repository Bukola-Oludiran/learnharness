/**
 * Course UI render pins (fork, phase 1 — FORK.md): the pure bodies, SSR'd.
 * Same tsx classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { addableSessions, CourseHomeBody, courseSessions } from "../components/course-home.tsx";
import { CourseFormBody, DeleteCourseBody } from "../components/course-dialogs.tsx";
import { CourseRow } from "../components/courses-section.tsx";
import type { ChatListItem, CourseRecord } from "../src/core/index.ts";

function chat(id: string, title: string, overrides: Partial<ChatListItem> = {}): ChatListItem {
	return { id, title, kind: "teach", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", messageCount: 1, phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false, ...overrides };
}

const course: CourseRecord = {
	id: "course_a",
	title: "Linear algebra",
	goal: "Read Strang.",
	materialIds: [],
	sessions: [{ chatId: "c2", kind: "teach", unitIds: [] }, { chatId: "c1", kind: "practice", unitIds: [] }],
	createdAt: "2026-11-09T00:00:00.000Z",
	updatedAt: "2026-11-09T00:00:00.000Z",
};
const chats = [chat("c1", "Bases practice", { kind: "practice" }), chat("c2", "Eigenvectors"), chat("c3", "Loose session")];
const noop = () => {};

function home(overrides: Partial<React.ComponentProps<typeof CourseHomeBody>> = {}) {
	return renderToStaticMarkup(
		<CourseHomeBody course={course} chats={chats} adding={false} query="" error={null} onStart={noop} onOpenSession={noop} onRemoveSession={noop}
			onToggleAdding={noop} onQuery={noop} onAddSession={noop} onEdit={noop} onDelete={noop} {...overrides} />,
	);
}

describe("CourseRow", () => {
	it("links to the course home and counts sessions in words", () => {
		const row = (sessionCount: number, active = false) => renderToStaticMarkup(
			<CourseRow course={{ id: "course_a", title: "Linear algebra", goal: "", sessionCount, createdAt: "", updatedAt: "" }} active={active} />,
		);
		assert.match(row(1), /href="\/course\/course_a"/);
		assert.match(row(1), />1 session</);
		assert.match(row(0), />0 sessions</);
		assert.match(row(2, true), /aria-current="page"/);
		assert.doesNotMatch(row(2), /aria-current/);
	});
});

describe("CourseHomeBody", () => {
	it("joins sessions in the session list's order and leaves outsiders out", () => {
		assert.deepEqual(courseSessions(course, chats).map((c) => c.id), ["c1", "c2"]);
		const html = home();
		assert.match(html, /Read Strang\./);
		assert.match(html, /Bases practice[\s\S]*Eigenvectors/);
		assert.doesNotMatch(html, /Loose session/);
		assert.equal(html.match(/data-testid="course-remove-session"/g)?.length, 2);
	});

	it("shows the empty states: no goal, loading, no sessions", () => {
		assert.match(home({ course: { ...course, goal: "" } }), /data-testid="course-goal-empty"/);
		assert.match(home({ chats: null }), /Loading…/);
		assert.match(home({ course: { ...course, sessions: [] } }), /data-testid="course-sessions-empty"/);
	});

	it("the add panel lists only sessions outside the course, filtered by the query", () => {
		assert.deepEqual(addableSessions(course, chats, "").map((c) => c.id), ["c3"]);
		assert.deepEqual(addableSessions(course, chats, "zzz"), []);
		const html = home({ adding: true });
		assert.match(html, /data-testid="course-add-panel"[\s\S]*Loose session/);
		assert.match(html, /moves here/);
		assert.doesNotMatch(home(), /data-testid="course-add-panel"/);
	});

	it("surfaces a membership failure", () => {
		assert.match(home({ error: "Could not add the session. Try again." }), /role="alert"[^>]*>Could not add the session/);
	});
});

describe("course dialogs", () => {
	const form = (overrides: Partial<React.ComponentProps<typeof CourseFormBody>> = {}) => renderToStaticMarkup(
		<CourseFormBody editing={false} title="" goal="" busy={false} error={null} onTitle={noop} onGoal={noop} onClose={noop} onSubmit={noop} {...overrides} />,
	);

	it("create cannot submit without a title; edit says Save", () => {
		assert.match(form(), /data-testid="course-form-submit"[^>]*disabled=""[^>]*>Create course</);
		assert.doesNotMatch(form({ title: "Algebra" }), /data-testid="course-form-submit"[^>]* disabled=""/);
		assert.match(form({ editing: true, title: "Algebra" }), />Save</);
		assert.match(form({ error: "nope" }), /data-testid="course-form-error"[^>]*>nope</);
	});

	it("delete says the sessions are kept", () => {
		const html = renderToStaticMarkup(<DeleteCourseBody title="Linear algebra" busy={false} error={null} onClose={noop} onRun={noop} />);
		assert.match(html, /Its sessions are kept/);
		assert.match(html, /Linear algebra/);
	});
});

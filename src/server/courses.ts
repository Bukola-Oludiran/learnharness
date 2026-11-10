/**
 * Courses service (fork, phase 1 — see FORK.md): the server-side entries
 * behind app/api/courses* and the turn handler's course lookup.
 *
 * Two rules live here, not in the store:
 *
 *   ONE COURSE PER SESSION — adding a session that another course lists
 *   moves it. Every function below is synchronous, so a move's
 *   read-modify-write cannot interleave with another request.
 *
 *   DELETED SESSIONS LEAVE ON READ — a course's stored list may name a
 *   chat that no longer exists (session deletion has no course hook, by
 *   design: no edit to upstream's deletion path). Reads project the list
 *   down to live chats; the stale id is never written back, so a chat
 *   that is only temporarily unreadable keeps its place.
 */

import { cleanCourseGoal, cleanCourseTitle, courseContextSegment, courseOfSession, courseSummary, withLiveSessions, withSession, withoutSession } from "../core/course.ts";
import type { CourseRecord, CourseSummary } from "../core/contracts.ts";
import { unitContextBlock, withUnitActive } from "../core/syllabus.ts";
import { weakIdeasForCourse } from "./evidence.ts";
import { stores } from "./stores.ts";

export type CourseOutcome =
	| { ok: true; course: CourseRecord }
	| { ok: false; status: 400; code: "bad_title"; error: string }
	| { ok: false; status: 404; code: "course_not_found" | "session_not_found"; error: string };

const NO_COURSE = { ok: false, status: 404, code: "course_not_found", error: "No such course" } as const;
const NO_SESSION = { ok: false, status: 404, code: "session_not_found", error: "No such session" } as const;
const BAD_TITLE = { ok: false, status: 400, code: "bad_title", error: "title must be a non-empty string" } as const;

function liveView(course: CourseRecord, liveChatIds: ReadonlySet<string>): CourseRecord {
	return withLiveSessions(course, (chatId) => liveChatIds.has(chatId));
}

function liveChatIds(): Set<string> {
	return new Set(stores.chatStore.listChats().map((chat) => chat.id));
}

/** The sidebar's list: most recently updated first. */
export function listCourseSummaries(): CourseSummary[] {
	const live = liveChatIds();
	return stores.courseStore.listCourses().map((course) => courseSummary(liveView(course, live)));
}

/** One course with its sessions projected down to live chats; null when unknown. */
export function getCourse(id: string): CourseRecord | null {
	const course = stores.courseStore.getCourse(id);
	return course ? liveView(course, liveChatIds()) : null;
}

export function createCourse(input: { title?: unknown; goal?: unknown }): CourseOutcome {
	const title = cleanCourseTitle(input.title);
	if (!title) return BAD_TITLE;
	return { ok: true, course: stores.courseStore.createCourse(title, cleanCourseGoal(input.goal)) };
}

/** Edit title and/or goal; an absent key leaves that field alone. */
export function updateCourse(id: string, input: { title?: unknown; goal?: unknown }): CourseOutcome {
	const course = stores.courseStore.getCourse(id);
	if (!course) return NO_COURSE;
	const next = { ...course };
	if (input.title !== undefined) {
		const title = cleanCourseTitle(input.title);
		if (!title) return BAD_TITLE;
		next.title = title;
	}
	if (input.goal !== undefined) next.goal = cleanCourseGoal(input.goal);
	stores.courseStore.saveCourse(next);
	return { ok: true, course: liveView(next, liveChatIds()) };
}

/** Delete the course record only — its sessions stay, as loose sessions. */
export function deleteCourse(id: string): boolean {
	return stores.courseStore.deleteCourse(id);
}

/** Put a session in a course, moving it out of any other course first. */
export function addSessionToCourse(courseId: string, chatId: unknown, unitId?: string): CourseOutcome {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return NO_COURSE;
	const chat = typeof chatId === "string" && /^[A-Za-z0-9_-]+$/.test(chatId) ? stores.chatStore.getChat(chatId) : null;
	if (!chat) return NO_SESSION;
	for (const other of stores.courseStore.listCourses()) {
		if (other.id === courseId) continue;
		const without = withoutSession(other, chat.id);
		if (without !== other) stores.courseStore.saveCourse(without);
	}
	// A session started on a syllabus unit (phase 4c) is scoped to it, and
	// the unit becomes in progress. An unknown unit id scopes to nothing.
	const unit = unitId ? course.syllabus?.units.find((u) => u.id === unitId) : undefined;
	let next = withSession(course, { chatId: chat.id, kind: chat.kind ?? "teach", unitIds: unit ? [unit.id] : [] }, new Date().toISOString());
	if (unit && next.syllabus) next = { ...next, syllabus: withUnitActive(next.syllabus, unit.id) };
	if (next !== course) stores.courseStore.saveCourse(next);
	return { ok: true, course: liveView(next, liveChatIds()) };
}

/** Take a session out of a course; the session itself is untouched. */
export function removeSessionFromCourse(courseId: string, chatId: string): CourseOutcome {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return NO_COURSE;
	const next = withoutSession(course, chatId);
	if (next === course) return NO_SESSION;
	stores.courseStore.saveCourse(next);
	return { ok: true, course: liveView(next, liveChatIds()) };
}

/** The turn handler's lookup: the course-context prompt segment for a
 *  session, or undefined when it is in no course. Resolved every turn, so
 *  an edited goal or a later move reaches the next turn. */
export function courseContextFor(chatId: string): string | undefined {
	const course = courseOfSession(stores.courseStore.listCourses(), chatId);
	if (!course) return undefined;
	// The course's books that can be read now (phase 4b).
	const books = (course.bookIds ?? [])
		.map((id) => stores.materialStore.getMaterial(id))
		.filter((book): book is NonNullable<typeof book> => book !== null && book.kind === "book" && book.status === "ready");
	const unitId = course.sessions.find((session) => session.chatId === chatId)?.unitIds[0];
	const unitBlock = unitId && course.syllabus ? unitContextBlock(course.syllabus, unitId, books, weakIdeasForCourse(course.id)) : null;
	return courseContextSegment(course, books, unitBlock);
}

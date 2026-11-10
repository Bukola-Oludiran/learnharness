/**
 * Course domain logic (fork, phase 1): pure functions over CourseRecord —
 * membership edits and the tutor's course-context prompt segment. No IO;
 * the server service (src/server/courses.ts) reads and writes through the
 * CourseStore port.
 */

import { COURSE_GOAL_MAX, COURSE_TITLE_MAX, type CourseRecord, type CourseSession, type CourseSummary } from "./contracts/course.ts";

/** A trimmed, bounded title, or null when nothing usable remains. */
export function cleanCourseTitle(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const title = value.trim().slice(0, COURSE_TITLE_MAX);
	return title === "" ? null : title;
}

/** A trimmed, bounded goal; anything that is not a string reads as empty. */
export function cleanCourseGoal(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, COURSE_GOAL_MAX) : "";
}

export function courseSummary(course: CourseRecord): CourseSummary {
	return {
		id: course.id,
		title: course.title,
		goal: course.goal,
		sessionCount: course.sessions.length,
		createdAt: course.createdAt,
		updatedAt: course.updatedAt,
	};
}

/** The course that lists the session, if any. */
export function courseOfSession(courses: readonly CourseRecord[], chatId: string): CourseRecord | null {
	return courses.find((course) => course.sessions.some((s) => s.chatId === chatId)) ?? null;
}

/** The record with the session appended; unchanged when already listed. */
export function withSession(course: CourseRecord, session: CourseSession, now: string): CourseRecord {
	if (course.sessions.some((s) => s.chatId === session.chatId)) return course;
	return { ...course, sessions: [...course.sessions, session], updatedAt: now };
}

/** The record without the session; unchanged when not listed. */
export function withoutSession(course: CourseRecord, chatId: string): CourseRecord {
	if (!course.sessions.some((s) => s.chatId === chatId)) return course;
	return { ...course, sessions: course.sessions.filter((s) => s.chatId !== chatId) };
}

/** The record with only the sessions whose chat still exists. A deleted
 *  session leaves its course this way — on read, with no hook in the
 *  session-deletion path. */
export function withLiveSessions(course: CourseRecord, exists: (chatId: string) => boolean): CourseRecord {
	const sessions = course.sessions.filter((s) => exists(s.chatId));
	return sessions.length === course.sessions.length ? course : { ...course, sessions };
}

/**
 * The tutor's course-context prompt segment (wording approved by the
 * owner, 2026-11-09). Appended after the composed prompt for every agent
 * kind. A course with no goal contributes its title line only — the two
 * goal lines have nothing to refer to.
 */
export function courseContextSegment(course: Pick<CourseRecord, "title" | "goal">): string {
	return [
		"# Course context",
		`This session is part of the learner's course "${course.title}".`,
		...(course.goal
			? [
					`Course goal: ${course.goal}`,
					"Keep the session in service of that goal. The learner's request for this session still decides its topic.",
				]
			: []),
	].join("\n\n");
}

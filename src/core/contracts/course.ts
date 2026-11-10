/**
 * Course contracts (fork, phase 1 — see FORK.md). A course is a record that
 * LISTS its sessions; chat records carry no course field, so the chat file
 * format stays at upstream's version. A session belongs to at most one
 * course (enforced by the server service, src/server/courses.ts).
 *
 * Later phases extend this record (personaId, syllabus); absent keys read
 * as "not set", so adding them needs no migration.
 */

export const CURRENT_COURSE_VERSION = 1;

/** One session's membership line. unitIds stays empty until the syllabus
 *  phase scopes sessions to units. */
export interface CourseSession {
	chatId: string;
	kind: "teach" | "practice";
	unitIds: string[];
}

/** One book section a unit draws on — the address read_material takes. */
export interface UnitSource {
	materialId: string;
	sectionId: string;
}

/**
 * todo    — not started
 * active  — a session is teaching it (phase 4c)
 * covered — taught (phase 4c)
 * skipped — the learner set it aside
 */
export type UnitStatus = "todo" | "active" | "covered" | "skipped";

/** One unit of a course's syllabus: what one study session can teach. */
export interface SyllabusUnit {
	id: string;
	title: string;
	/** Ids of the units this one comes after. */
	dependsOn: string[];
	sources: UnitSource[];
	status: UnitStatus;
}

/** The course's long-lived plan, in teaching order. */
export interface Syllabus {
	units: SyllabusUnit[];
	builtAt: string;
	/** The learner's note to the builder on the last build, if any. */
	note?: string;
}

export interface CourseRecord {
	id: string;
	title: string;
	/** What the learner wants from the course. May be empty. */
	goal: string;
	/** Books, notes and tests attached to the course (ingest phase). */
	materialIds: string[];
	sessions: CourseSession[];
	/** Library books the course teaches from (phase 4b). A book is shared:
	 *  it lives in the library and may serve several courses. */
	bookIds?: string[];
	syllabus?: Syllabus;
	/** Why the last syllabus build failed; cleared by the next build. */
	syllabusError?: string;
	createdAt: string;
	/** Bumped when a session joins — not on title/goal edits, so the
	 *  sidebar order never churns on an edit (the chat rename rule). */
	updatedAt: string;
	/** Absent on disk reads as v1; a newer stamp is refused. */
	version?: number;
}

/** The sidebar's list row. */
export interface CourseSummary {
	id: string;
	title: string;
	goal: string;
	sessionCount: number;
	createdAt: string;
	updatedAt: string;
}

export const COURSE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const COURSE_TITLE_MAX = 200;
export const COURSE_GOAL_MAX = 2000;
export const MAX_SYLLABUS_UNITS = 60;
export const UNIT_TITLE_MAX = 200;
export const SYLLABUS_NOTE_MAX = 1000;

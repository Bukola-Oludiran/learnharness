/**
 * CourseStore — the fs JSON adapter (one file per course in data/courses/).
 *
 * Implements core/ports.ts CourseStore with the chat store's idioms: sync
 * fs, id-guarded filenames, atomic temp-file rename, a version stamp on
 * every write and a newer-version refusal on read. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { CourseStore } from "../core/ports.ts";
import { COURSE_ID_PATTERN, CURRENT_COURSE_VERSION, type CourseRecord } from "../core/contracts.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

function courseFile(id: string): string {
	if (!COURSE_ID_PATTERN.test(id)) throw new Error(`Invalid course id: ${id}`);
	return path.join(PATHS.courses, `${id}.json`);
}

function writeCourse(record: CourseRecord): void {
	fs.mkdirSync(PATHS.courses, { recursive: true });
	writeFileAtomicSync(courseFile(record.id), JSON.stringify({ ...record, version: CURRENT_COURSE_VERSION }, null, "\t"));
	emit("courses-changed", {});
}

function createCourse(title: string, goal: string): CourseRecord {
	const now = new Date().toISOString();
	const record: CourseRecord = {
		id: `course_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title,
		goal,
		materialIds: [],
		sessions: [],
		createdAt: now,
		updatedAt: now,
	};
	writeCourse(record);
	return { ...record, version: CURRENT_COURSE_VERSION };
}

function getCourse(id: string): CourseRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(courseFile(id), "utf-8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	// A record stamped newer than this build reads as absent, never
	// misparsed — the next write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_COURSE_VERSION) {
		console.error(`[course ${id}] record stamped with schema version ${v} > ${CURRENT_COURSE_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	const record = parsed as CourseRecord;
	if (record.id !== id || typeof record.title !== "string" || !Array.isArray(record.sessions)) return null;
	return record;
}

function listCourses(): CourseRecord[] {
	let files: string[];
	try {
		files = fs.readdirSync(PATHS.courses);
	} catch {
		return []; // no courses folder yet
	}
	return files
		.filter((f) => f.endsWith(".json") && COURSE_ID_PATTERN.test(f.slice(0, -5)))
		.map((f) => getCourse(f.slice(0, -5)))
		.filter((r): r is CourseRecord => r !== null)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function saveCourse(course: CourseRecord): void {
	if (!fs.existsSync(courseFile(course.id))) throw new Error(`Course not found: ${course.id}`);
	writeCourse(course);
}

function deleteCourse(id: string): boolean {
	try {
		fs.unlinkSync(courseFile(id));
		removeLeftoverTemps(courseFile(id));
		emit("courses-changed", {});
		return true;
	} catch {
		return false;
	}
}

export const courseStore: CourseStore = {
	createCourse,
	getCourse,
	listCourses,
	saveCourse,
	deleteCourse,
};

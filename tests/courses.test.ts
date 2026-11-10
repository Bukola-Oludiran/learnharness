/**
 * Courses (fork, phase 1 — FORK.md): the store, the service rules and the
 * routes, driven framework-free under an isolated LH_DATA_DIR. The seam is
 * set before the first config-loading import, so app modules load
 * dynamically (the chat-birth-stamp discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const list = await import("../app/api/courses/route.ts");
const one = await import("../app/api/courses/[id]/route.ts");
const members = await import("../app/api/courses/[id]/sessions/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { courseContextFor } = await import("../src/server/courses.ts");
const { subscribe } = await import("../src/core/events.ts");
const { PATHS } = await import("../config.ts");
const { CURRENT_COURSE_VERSION } = await import("../src/core/contracts.ts");

const json = (method: string, body?: unknown) => new Request("http://test/api", {
	method,
	headers: { "Content-Type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const at = (id: string) => ({ params: Promise.resolve({ id }) });

async function newCourse(title: string, goal = ""): Promise<{ id: string; title: string; goal: string }> {
	const res = await list.POST(json("POST", { title, goal }));
	assert.equal(res.status, 200);
	return (await res.json()).course;
}
const add = (courseId: string, chatId: unknown) => members.POST(json("POST", { chatId }), at(courseId));
const storedSessions = (courseId: string) => stores.courseStore.getCourse(courseId)!.sessions.map((s) => s.chatId);

describe("course records", () => {
	it("create persists a stamped record with trimmed fields and no sessions", async () => {
		const course = await newCourse("  Linear algebra  ", "  Read Strang.  ");
		assert.match(course.id, /^course_[a-z0-9]+_[a-f0-9]{8}$/);
		const onDisk = JSON.parse(fs.readFileSync(path.join(PATHS.courses, `${course.id}.json`), "utf-8"));
		assert.equal(onDisk.title, "Linear algebra");
		assert.equal(onDisk.goal, "Read Strang.");
		assert.deepEqual(onDisk.sessions, []);
		assert.deepEqual(onDisk.materialIds, []);
		assert.equal(onDisk.version, CURRENT_COURSE_VERSION);
	});

	it("a title is required; the goal is optional", async () => {
		for (const body of [{}, { title: "   " }, { title: 7 }]) {
			const res = await list.POST(json("POST", body));
			assert.equal(res.status, 400);
			assert.equal((await res.json()).code, "bad_title");
		}
		assert.equal((await newCourse("No goal")).goal, "");
	});

	it("edit changes only the keys sent and does not reorder the list", async () => {
		const course = await newCourse("Before", "Old goal");
		const before = stores.courseStore.getCourse(course.id)!.updatedAt;
		let res = await one.PUT(json("PUT", { goal: "New goal" }), at(course.id));
		assert.deepEqual([(await res.json()).course.title, stores.courseStore.getCourse(course.id)!.goal], ["Before", "New goal"]);
		res = await one.PUT(json("PUT", { title: "After" }), at(course.id));
		assert.equal((await res.json()).course.goal, "New goal");
		assert.equal(stores.courseStore.getCourse(course.id)!.updatedAt, before);
		assert.equal((await one.PUT(json("PUT", { title: "" }), at(course.id))).status, 400);
		assert.equal((await one.PUT(json("PUT", { title: "x" }), at("course_missing"))).status, 404);
	});

	it("unknown, malformed and newer-version ids read as absent", async () => {
		assert.equal((await one.GET(json("GET"), at("course_missing"))).status, 404);
		assert.equal((await one.GET(json("GET"), at("../chats/x"))).status, 404);
		fs.writeFileSync(path.join(PATHS.courses, "course_future.json"), JSON.stringify({ id: "course_future", title: "Future", goal: "", materialIds: [], sessions: [], createdAt: "2027-01-01", updatedAt: "2027-01-01", version: CURRENT_COURSE_VERSION + 1 }));
		assert.equal(stores.courseStore.getCourse("course_future"), null);
		const { courses } = await (await list.GET()).json();
		assert.ok(!courses.some((c: { id: string }) => c.id === "course_future"));
		fs.rmSync(path.join(PATHS.courses, "course_future.json"));
	});

	it("every write announces courses-changed", async () => {
		let count = 0;
		const off = subscribe((event) => { if (event.type === "courses-changed") count++; });
		try {
			const course = await newCourse("Events");
			await one.PUT(json("PUT", { goal: "g" }), at(course.id));
			await one.DELETE(json("DELETE"), at(course.id));
			assert.equal(count, 3);
		} finally {
			off();
		}
	});
});

describe("course membership", () => {
	it("adding records the session's kind; adding twice is a no-op", async () => {
		const course = await newCourse("Membership");
		const teach = stores.chatStore.createChat("Teach session");
		const practice = stores.chatStore.createChat("Practice session", "practice");
		assert.equal((await add(course.id, teach.id)).status, 200);
		assert.equal((await add(course.id, practice.id)).status, 200);
		assert.equal((await add(course.id, teach.id)).status, 200);
		assert.deepEqual(stores.courseStore.getCourse(course.id)!.sessions, [
			{ chatId: teach.id, kind: "teach", unitIds: [] },
			{ chatId: practice.id, kind: "practice", unitIds: [] },
		]);
	});

	it("a session belongs to one course: adding it elsewhere moves it", async () => {
		const first = await newCourse("First");
		const second = await newCourse("Second");
		const chat = stores.chatStore.createChat("Moves");
		await add(first.id, chat.id);
		await add(second.id, chat.id);
		assert.deepEqual(storedSessions(first.id), []);
		assert.deepEqual(storedSessions(second.id), [chat.id]);
	});

	it("unknown courses and sessions refuse with 404 and change nothing", async () => {
		const course = await newCourse("Refusals");
		const chat = stores.chatStore.createChat("Real");
		assert.equal((await (await add("course_missing", chat.id)).json()).code, "course_not_found");
		for (const chatId of ["chat_missing", "../x", 42, undefined]) {
			assert.equal((await (await add(course.id, chatId)).json()).code, "session_not_found");
		}
		assert.deepEqual(storedSessions(course.id), []);
	});

	it("remove takes the session out and leaves the chat alone", async () => {
		const course = await newCourse("Removal");
		const chat = stores.chatStore.createChat("Stays a session");
		await add(course.id, chat.id);
		const url = (chatId: string) => new Request(`http://test/api/courses/${course.id}/sessions?chatId=${chatId}`, { method: "DELETE" });
		assert.equal((await members.DELETE(url(chat.id), at(course.id))).status, 200);
		assert.deepEqual(storedSessions(course.id), []);
		assert.ok(stores.chatStore.getChat(chat.id));
		assert.equal((await members.DELETE(url(chat.id), at(course.id))).status, 404);
	});

	it("a deleted session leaves its course on read, without rewriting the course file", async () => {
		const course = await newCourse("Pruning");
		const kept = stores.chatStore.createChat("Kept");
		const gone = stores.chatStore.createChat("Gone");
		await add(course.id, kept.id);
		await add(course.id, gone.id);
		const file = path.join(PATHS.courses, `${course.id}.json`);
		const bytes = fs.readFileSync(file, "utf-8");
		stores.chatStore.deleteChat(gone.id);
		const read = (await (await one.GET(json("GET"), at(course.id))).json()).course;
		assert.deepEqual(read.sessions.map((s: { chatId: string }) => s.chatId), [kept.id]);
		const { courses } = await (await list.GET()).json();
		assert.equal(courses.find((c: { id: string }) => c.id === course.id).sessionCount, 1);
		assert.equal(fs.readFileSync(file, "utf-8"), bytes);
	});

	it("deleting a course keeps its sessions", async () => {
		const course = await newCourse("Short-lived");
		const chat = stores.chatStore.createChat("Survivor");
		await add(course.id, chat.id);
		assert.equal((await one.DELETE(json("DELETE"), at(course.id))).status, 200);
		assert.equal((await one.DELETE(json("DELETE"), at(course.id))).status, 404);
		assert.ok(stores.chatStore.getChat(chat.id));
		assert.equal(courseContextFor(chat.id), undefined);
	});
});

describe("starting a session inside a course", () => {
	it("POST /api/chats with courseId creates the session in the course", async () => {
		const course = await newCourse("Started here");
		const res = await chatsRoute.POST(json("POST", { title: "eigenvectors", kind: "practice", courseId: course.id }));
		assert.equal(res.status, 200);
		const { id } = await res.json();
		assert.deepEqual(stores.courseStore.getCourse(course.id)!.sessions, [{ chatId: id, kind: "practice", unitIds: [] }]);
	});

	it("an unknown courseId refuses before any session is created", async () => {
		const before = stores.chatStore.listChats().length;
		const res = await chatsRoute.POST(json("POST", { title: "orphan?", courseId: "course_missing" }));
		assert.equal(res.status, 404);
		assert.equal((await res.json()).code, "course_not_found");
		assert.equal(stores.chatStore.listChats().length, before);
	});

	it("without courseId the session joins no course and the chat file carries no course field", async () => {
		const res = await chatsRoute.POST(json("POST", { title: "loose" }));
		const { id } = await res.json();
		assert.equal(courseContextFor(id), undefined);
		assert.ok(!("courseId" in JSON.parse(fs.readFileSync(path.join(PATHS.chats, `${id}.json`), "utf-8"))));
	});
});

describe("the turn handler's course lookup", () => {
	it("resolves the current course each call, following edits and moves", async () => {
		const first = await newCourse("Algebra", "Pass the exam.");
		const second = await newCourse("Chemistry");
		const chat = stores.chatStore.createChat("Context");
		await add(first.id, chat.id);
		assert.match(courseContextFor(chat.id)!, /course "Algebra"[\s\S]*Course goal: Pass the exam\./);
		await one.PUT(json("PUT", { goal: "Understand proofs." }), at(first.id));
		assert.match(courseContextFor(chat.id)!, /Course goal: Understand proofs\./);
		await add(second.id, chat.id);
		assert.match(courseContextFor(chat.id)!, /course "Chemistry"/);
	});
});

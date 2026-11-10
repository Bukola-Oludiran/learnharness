/**
 * The tutor's material tools (fork, phase 3c — FORK.md): ingest_material
 * and material_status, driven through their real execute with the real
 * materials service behind fakes for the model calls. Runs under an
 * isolated LH_DATA_DIR, set before the first config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-material-tools-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { createMaterialTools, MAX_INGEST_PATHS } = await import("../src/agent/tools/ingest.ts");
const { createMaterialsService } = await import("../src/server/materials.ts");
const { materialToolDeps } = await import("../src/server/material-tools.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { stores } = await import("../src/server/stores.ts");
const { ingestResultText, materialStatusLine } = await import("../src/core/material.ts");
const { withSession } = await import("../src/core/course.ts");
const { createFauxCore } = await import("@earendil-works/pi-ai");
import type { MaterialView } from "../src/core/contracts.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20_000, 7)]);
// The learner's files live under the real home's temp area; os.tmpdir() is outside every sensitive location.
const files = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-files-"));
after(() => fs.rmSync(files, { recursive: true, force: true }));
const file = (name: string, content: string | Uint8Array) => {
	const target = path.join(files, name);
	fs.writeFileSync(target, content);
	return target;
};

const imported: { filePath: string }[] = [];
const service = createMaterialsService({
	stores,
	transcribe: async (_bytes, label) => `read ${label}`,
	importNotes: async (input) => void imported.push(input),
	registerImport: () => {},
	abortExtraction: () => {},
	readTest: async () => ({ questions: [{ number: "1", question: "Q", answer: "A", idea: "Bayes' rule", outcome: "correct" }] }),
	linkTest: async (questions) => questions.map(() => []),
	sourceIdeas: () => [],
	renderPdfPages: async () => [],
	removeEvidence: () => {},
});
const toolsFor = (chatId: string) => {
	const [ingest, status] = createMaterialTools(materialToolDeps(chatId, service));
	const run = async (tool: typeof ingest, input: unknown) => {
		const result = await tool!.execute("call_1", input as never, undefined as never);
		return (result.content as { text: string }[]).map((part) => part.text).join("\n");
	};
	return { ingest: (input: unknown) => run(ingest, input), status: (input: unknown = {}) => run(status, input), raw: [ingest!, status!] };
};
async function settled(id: string): Promise<MaterialView> {
	for (let i = 0; i < 400; i++) {
		const found = service.getMaterial(id)!.material;
		if (found.status !== "processing") return found;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("material never settled");
}
const idIn = (text: string) => /\(id (mat_[A-Za-z0-9_-]+)\)/.exec(text)![1]!;

describe("the wording the tutor reads", () => {
	it("reports what started and what was refused", () => {
		assert.equal(
			ingestResultText([{ name: "week2.pdf", id: "mat_1" }], [{ name: "old.ppt", error: "Old Office files are not supported." }]),
			"Started adding 1 file to the learner's library:\n- week2.pdf (id mat_1): processing.\n\nNot added:\n- old.ppt: Old Office files are not supported.",
		);
		assert.match(ingestResultText([{ name: "a", id: "1" }, { name: "b", id: "2" }], []), /^Started adding 2 files/);
	});

	it("says each state in words the tutor can pass on", () => {
		const line = (overrides: object) => materialStatusLine({ title: "Week 2", kind: "notes", status: "ready", ...overrides } as never);
		assert.equal(line({}), "- Week 2 (notes): in the graph.");
		assert.equal(line({ status: "processing", stage: "queued" }), "- Week 2 (notes): waiting its turn.");
		assert.equal(line({ status: "processing", stage: "converting" }), "- Week 2 (notes): being processed.");
		assert.equal(line({ status: "review", kind: "test" }), "- Week 2 (marked test): waiting for the learner's review in the Library.");
		assert.equal(line({ kind: "test", score: { earned: 7, possible: 10 } }), "- Week 2 (marked test): results recorded, score 7/10.");
		assert.equal(line({ status: "failed", error: "Could not open this PDF." }), "- Week 2 (notes): failed. Could not open this PDF. The learner can retry it in the Library.");
		assert.match(line({ status: "processing", interrupted: true }), /interrupted when the app closed/);
	});
});

describe("ingest_material", () => {
	it("adds notes to the library when the session is in no course, and returns at once", async () => {
		const tools = toolsFor("chat_free");
		const text = await tools.ingest({ kind: "notes", paths: [file("Week 2.md", "# Bayes\n\nNotes.")] });
		assert.match(text, /^Started adding 1 file to the learner's library:\n- Week 2\.md \(id mat_[^)]+\): processing\.$/);
		const done = await settled(idIn(text));
		assert.deepEqual([done.status, done.courseId, done.sourcePath, done.kind], ["ready", undefined, "Week 2.md", "notes"]);
		assert.equal(imported.at(-1)!.filePath, "Week 2.md");
	});

	it("adds to the session's course when it is in one", async () => {
		const course = stores.courseStore.createCourse("Stats 201", "");
		stores.courseStore.saveCourse(withSession(course, { chatId: "chat_course", kind: "teach", unitIds: [] }, new Date().toISOString()));
		const text = await toolsFor("chat_course").ingest({ kind: "notes", paths: [file("Week 3.md", "Expectation.")] });
		const done = await settled(idIn(text));
		assert.deepEqual([done.courseId, done.sourcePath], [course.id, "Stats 201/Week 3.md"]);
		assert.ok(stores.courseStore.getCourse(course.id)!.materialIds!.includes(done.id));
	});

	it("makes each notes path its own material and reports refusals beside successes", async () => {
		const text = await toolsFor("chat_free").ingest({
			kind: "notes",
			paths: [file("a.md", "A"), file("old.ppt", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2])), path.join(files, "missing.pdf"), file("b.txt", "B")],
		});
		assert.match(text, /^Started adding 2 files[\s\S]*- a\.md \(id [^)]+\): processing\.\n- b\.txt \(id/);
		assert.match(text, /Not added:\n- old\.ppt: Old Office files[\s\S]*\n- missing\.pdf: No such file\./);
	});

	it("reads all paths as the pages of one marked test, which waits for review", async () => {
		const tools = toolsFor("chat_free");
		const text = await tools.ingest({ kind: "test", paths: [file("p1.png", PNG), file("p2.png", PNG)] });
		assert.match(text, /^Started adding 1 file/);
		const done = await settled(idIn(text));
		assert.deepEqual([done.kind, done.status, done.aiReadParts], ["test", "review", 2]);
		assert.match(await tools.status({ ids: [done.id] }), /^- p1 \(marked test\): waiting for the learner's review in the Library\.$/);
	});

	it("fails as a tool error when nothing could be added, and never reads a test with a page missing", async () => {
		const tools = toolsFor("chat_free");
		const before = service.listMaterials().length;
		await assert.rejects(tools.ingest({ kind: "notes", paths: [path.join(files, "nope.md")] }), /Not added:\n- nope\.md: No such file\./);
		await assert.rejects(tools.ingest({ kind: "test", paths: [file("page1.png", PNG), path.join(files, "page2.png")] }), /page2\.png: No such file\./);
		await assert.rejects(tools.ingest({ kind: "notes", paths: [files] }), /It is not a file\./);
		await assert.rejects(tools.ingest({ kind: "notes", paths: ["~/.ssh/id_rsa"] }), /Not added/);
		assert.equal(service.listMaterials().length, before);
		assert.equal(MAX_INGEST_PATHS, 10);
	});
});

describe("material_status", () => {
	it("lists the most recent first with no ids, and names ids it cannot find", async () => {
		const tools = toolsFor("chat_free");
		const listed = (await tools.status()).split("\n");
		assert.ok(listed.length >= 4 && listed.length <= 10);
		assert.match(listed[0]!, /^- p1 \(marked test\)/);
		assert.equal(await tools.status({ ids: ["mat_gone"] }), "- mat_gone: no such material (it may have been deleted).");
	});
});

describe("the teacher's registry", () => {
	const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
	const ctx = { chatId: "chat_free", chatStore: stores.chatStore, jobStore: stores.jobStore, spawn: () => {}, searchAvailable: () => false };

	const engine = () => { const faux = createFauxCore({}); return { model: faux.getModel(), streamFn: faux.streamSimple }; };

	it("gains the material tools only when they are passed, after its own tools", () => {
		const plain = names(createTeacherAgent(ctx as never, { engine: engine() }).state.tools as never);
		const withExtra = names(createTeacherAgent(ctx as never, { engine: engine(), extraTools: toolsFor("chat_free").raw }).state.tools as never);
		assert.ok(!plain.includes("ingest_material") && !plain.includes("material_status"));
		assert.deepEqual(withExtra.filter((name) => !plain.includes(name)), ["ingest_material", "material_status"]);
		// An explicit test registry stays caller-owned.
		const owned = names(createTeacherAgent(ctx as never, { engine: engine(), tools: {}, extraTools: toolsFor("chat_free").raw }).state.tools as never);
		assert.ok(!owned.includes("ingest_material"));
	});

	it("tells the tutor to add only on request or consent, and that review is the learner's", () => {
		const [ingest, status] = toolsFor("chat_free").raw;
		assert.match(ingest!.description, /Call it only when the learner asks for a file to be added, or after they agree to your offer\. Offer at most once per file\./);
		assert.match(ingest!.description, /waits for the learner's review in the Library before it reaches the graph/);
		assert.match(ingest!.description, /To teach from a file, use read/);
		assert.match(status!.description, /Call it when the learner asks about a file they added\./);
	});
});

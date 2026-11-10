/**
 * Learner evidence and marked tests (fork, phase 3b — FORK.md): the state
 * rule, the practice fold, the ledger, the test pipeline with a fake reader
 * and linker, and the view that joins evidence to the graph. Runs under an
 * isolated LH_DATA_DIR, set before the first config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-evidence-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const {
	cleanTestReading, ideaState, practiceEvidenceOf, TEST_LINKER_INSTRUCTIONS, TEST_READER_INSTRUCTIONS, testEvidenceOf, testIdeasText, testScore,
} = await import("../src/core/evidence.ts");
const { stores } = await import("../src/server/stores.ts");
const { createMaterialsService } = await import("../src/server/materials.ts");
const { evidenceView, removeMaterialEvidence, syncPracticeEvidence } = await import("../src/server/evidence.ts");
const { emit } = await import("../src/core/events.ts");
const { EVIDENCE_FILE, PATHS } = await import("../config.ts");
const evidenceRoute = await import("../app/api/graph/evidence/route.ts");
import type { Evidence, EvidenceOutcome, MaterialView, TestQuestion, TestReading } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const C: EvidenceOutcome = "correct", P: EvidenceOutcome = "partial", W: EvidenceOutcome = "wrong";

describe("the state rule (last three results, weighed)", () => {
	it("matches the table the owner approved", () => {
		const table: [EvidenceOutcome[], string][] = [
			[[C], "demonstrated"],
			[[W], "missed"],
			[[P], "shaky"],
			[[W, C], "shaky"],
			[[W, W, C], "shaky"],
			[[W, C, C], "shaky"],
			[[C, C, W], "shaky"],
			[[C, W, W], "missed"],
			[[C, C, C], "demonstrated"],
		];
		for (const [outcomes, state] of table) assert.equal(ideaState(outcomes, true), state, outcomes.join(","));
	});

	it("only the last three count, and no results means taught or unseen", () => {
		assert.equal(ideaState([W, W, W, C, C, C], false), "demonstrated");
		assert.equal(ideaState([C, C, C, W, W, W], true), "missed");
		assert.equal(ideaState([P, C, C], true), "demonstrated");
		assert.equal(ideaState([], true), "taught");
		assert.equal(ideaState([], false), "unseen");
	});
});

describe("practice results are folded from the saved record", () => {
	let clock = 1_800_000_000_000;
	const call = (id: string, name: string, args: unknown): LhMessage =>
		({ id: `a_${id}`, role: "assistant", stopReason: "toolUse", timestamp: clock++, content: [{ type: "toolCall", id, name, arguments: args }] }) as unknown as LhMessage;
	const result = (id: string, name: string, isError = false): LhMessage =>
		({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError, timestamp: clock++ }) as unknown as LhMessage;
	const problem = (id: string, target?: string[]) => [call(id, "problem", { statement: `Solve ${id}`, ...(target ? { target } : {}) }), result(id, "problem")];
	const conclude = (id: string, outcome: string, isError = false) => [call(id, "conclude", { outcome, verdict: `verdict ${id}` }), result(id, "conclude", isError)];

	it("maps outcomes, pairs each conclusion with its problem's targets, and skips what says nothing", () => {
		const messages = [
			...problem("p1", ["n_a"]), ...conclude("c1", "solved"),
			...problem("p2", ["n_a", "n_b", "n_a"]), ...conclude("c2", "solvedWithHints"),
			...problem("p3", ["n_b"]), ...conclude("c3", "surrendered"),
			...problem("p4", ["n_b"]), ...conclude("c4", "movedOn"),
			...problem("p5"), ...conclude("c5", "solved"),
			...problem("p6", ["n_c"]), ...conclude("c6", "solved", true),
		];
		const evidence = practiceEvidenceOf("chat_1", messages, "course_1");
		assert.deepEqual(evidence.map((e) => [e.id, e.outcome, e.nodeIds]), [
			["practice:chat_1:c1", "correct", ["n_a"]],
			["practice:chat_1:c2", "partial", ["n_a", "n_b"]],
			["practice:chat_1:c3", "wrong", ["n_b"]],
		]);
		assert.equal(evidence[0]!.summary, "Solve p1 — verdict c1");
		assert.deepEqual([evidence[0]!.from, evidence[0]!.chatId, evidence[0]!.courseId], ["practice", "chat_1", "course_1"]);
		assert.deepEqual(practiceEvidenceOf("chat_1", messages, "course_1"), evidence, "a re-fold yields the same lines");
	});
});

describe("test readings", () => {
	const q = (overrides: Partial<TestQuestion> = {}): TestQuestion =>
		({ number: "1", question: "State Bayes' rule.", answer: "P(A|B)=P(B|A)P(A)", marksAwarded: 1, marksAvailable: 2, outcome: "partial", whatWentWrong: "Missing the division by P(B).", idea: "Bayes' rule divides by P(B).", ...overrides });

	it("cleans a model submit or an edited review into a storable reading", () => {
		const cleaned = cleanTestReading({
			questions: [
				{ number: " 3a ", question: " Q ", answer: 7, marksAwarded: "2", marksAvailable: 4, outcome: "nonsense", idea: " I " },
				{ question: "", idea: "" },
				{ question: "Only a question", outcome: "wrong", whatWentWrong: " slipped ", marksAwarded: -1 },
			],
			total: { earned: 3, possible: 0 },
		});
		assert.deepEqual(cleaned, {
			questions: [
				{ number: "3a", question: "Q", answer: "", marksAvailable: 4, outcome: "unmarked", idea: "I" },
				{ number: "3", question: "Only a question", answer: "", outcome: "wrong", whatWentWrong: "slipped", idea: "" },
			],
		});
		assert.equal(cleanTestReading({ questions: [] }), null);
		assert.equal(cleanTestReading("nope"), null);
		assert.deepEqual(cleanTestReading({ questions: [q()], total: { earned: 14, possible: 20 } })!.total, { earned: 14, possible: 20 });
	});

	it("scores from the paper's total, else from complete per-question marks", () => {
		assert.deepEqual(testScore({ questions: [q()], total: { earned: 14, possible: 20 } }), { earned: 14, possible: 20 });
		assert.deepEqual(testScore({ questions: [q(), q({ marksAwarded: 2 })] }), { earned: 3, possible: 4 });
		assert.equal(testScore({ questions: [q(), q({ marksAwarded: undefined })] }), undefined);
	});

	it("contributes only tested ideas to the graph — never the learner's answers", () => {
		const text = testIdeasText("Midterm", { questions: [q(), q({ idea: "Bayes' rule divides by P(B)." }), q({ idea: "Independence means P(A and B) = P(A)P(B)." }), q({ idea: " " })] });
		assert.equal(text, "# Ideas tested in Midterm\n\n- Bayes' rule divides by P(B).\n- Independence means P(A and B) = P(A)P(B).");
		assert.ok(!text.includes("P(A|B)=P(B|A)P(A)"));
		assert.equal(testIdeasText("Empty", { questions: [q({ idea: "" })] }), "");
	});

	it("yields one evidence line per marked question, with stable ids", () => {
		const reading: TestReading = { questions: [q({ nodeIds: ["n_1"] }), q({ outcome: "unmarked", nodeIds: ["n_1"] }), q({ number: "3", outcome: "correct", nodeIds: [] })] };
		const lines = testEvidenceOf({ id: "mat_1", courseId: "course_1" }, reading, "2026-11-10T00:00:00.000Z");
		assert.deepEqual(lines.map((e) => [e.id, e.outcome, e.nodeIds]), [["test:mat_1:0", "partial", ["n_1"]], ["test:mat_1:2", "correct", []]]);
		assert.equal(lines[0]!.summary, "Q1 (1/2): State Bayes' rule. — Missing the division by P(B).");
		assert.equal(lines[1]!.summary, "Q3 (1/2): State Bayes' rule.");
		assert.deepEqual([lines[0]!.from, lines[0]!.materialId, lines[0]!.courseId], ["test", "mat_1", "course_1"]);
	});

	it("carries the approved reader and linker wording", () => {
		assert.match(TEST_READER_INSTRUCTIONS, /^You are reading photos of a marked test paper\. Report exactly what is on the paper\./);
		assert.match(TEST_READER_INSTRUCTIONS, /Base it on the question, never on the learner's answer\./);
		assert.match(TEST_READER_INSTRUCTIONS, /Never guess a mark that is not on the paper\.\n\nCall submit_test once with the result\.$/);
		assert.match(TEST_LINKER_INSTRUCTIONS, /^Match each test question to the ideas it tests\./);
		assert.match(TEST_LINKER_INSTRUCTIONS, /Never invent an id\.\n\nCall submit_links once with the result\.$/);
	});
});

describe("the evidence ledger", () => {
	const line = (id: string, extra: Partial<Evidence> = {}): Evidence =>
		({ id, at: "2026-11-10T00:00:00.000Z", nodeIds: ["n_x"], from: "test", outcome: "correct", summary: "s", ...extra });

	it("appends once per id, skips corrupt lines, and rewrites atomically", () => {
		assert.deepEqual(stores.evidenceStore.read(), []);
		assert.equal(stores.evidenceStore.append([line("e1"), line("e2", { materialId: "mat_gone" })]), 2);
		assert.equal(stores.evidenceStore.append([line("e1"), line("e3")]), 1);
		fs.appendFileSync(EVIDENCE_FILE, "{ torn line\n\n" + JSON.stringify({ id: "bad", at: "x" }) + "\n");
		assert.deepEqual(stores.evidenceStore.read().map((e) => e.id), ["e1", "e2", "e3"]);
		removeMaterialEvidence("mat_gone");
		assert.deepEqual(stores.evidenceStore.read().map((e) => e.id), ["e1", "e3"]);
		assert.ok(!fs.readdirSync(PATHS.graph).some((f) => f.includes(".tmp")));
		stores.evidenceStore.rewrite([]);
	});
});

describe("a marked test, end to end", () => {
	const imported: { filePath: string; text: string }[] = [];
	let reads = 0;
	const reading: TestReading = {
		questions: [
			{ number: "1", question: "State Bayes' rule.", answer: "P(A|B)=P(B|A)P(A)", marksAwarded: 1, marksAvailable: 2, outcome: "partial", whatWentWrong: "No division by P(B).", idea: "Bayes' rule divides by P(B)." },
			{ number: "2", question: "Define independence.", answer: "P(A and B)=P(A)P(B)", marksAwarded: 2, marksAvailable: 2, outcome: "correct", idea: "Independent events multiply." },
			{ number: "3", question: "Name a paradox.", answer: "Monty Hall", marksAwarded: 0, marksAvailable: 1, outcome: "wrong", whatWentWrong: "Wrong paradox.", idea: "Simpson's paradox reverses a trend." },
			{ number: "4", question: "Bonus.", answer: "", outcome: "unmarked", idea: "" },
		],
	};
	const behavior = { linkFails: false };
	const service = createMaterialsService({
		stores,
		transcribe: async () => "",
		readTest: async (pages) => {
			reads++;
			assert.equal(pages.length, 2, "both pages reach the reader");
			return reading;
		},
		// The graph holds ideas for questions 1 and 2 only; 3 stays unplaced.
		sourceIdeas: () => [
			{ id: "n_bayes", name: "Bayes' rule", statement: "P(A|B) = P(B|A)P(A)/P(B)." },
			{ id: "n_indep", name: "Independence", statement: "P(A and B) = P(A)P(B)." },
		],
		linkTest: async (questions) => {
			if (behavior.linkFails) throw new Error("The provider refused the request.");
			return questions.map((question) => (question.number === "1" ? ["n_bayes", "n_invented"] : question.number === "2" ? ["n_indep"] : []));
		},
		renderPdfPages: async () => [],
		importNotes: async (input) => void imported.push(input),
		registerImport: () => {},
		abortExtraction: () => {},
		removeEvidence: removeMaterialEvidence,
	});
	const course = stores.courseStore.createCourse("Probability", "");
	stores.graphStore.appendNode({ id: "n_bayes", name: "Bayes' rule", statement: "P(A|B) = P(B|A)P(A)/P(B).", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId: "chat_taught", messageId: "m1" }] });
	stores.graphStore.appendNode({ id: "n_indep", name: "Independence", statement: "P(A and B) = P(A)P(B).", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId: "src_aaaaaaaaaaaa", messageId: "" }] });
	stores.graphStore.appendNode({ id: "n_other", name: "Variance", statement: "Variance is the expected squared deviation.", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId: "src_aaaaaaaaaaaa", messageId: "" }] });

	async function settled(id: string): Promise<MaterialView> {
		for (let i = 0; i < 400; i++) {
			const found = service.getMaterial(id)!.material;
			if (found.status !== "processing") return found;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("material never settled");
	}
	const pages = [{ name: "page1.png", bytes: PNG }, { name: "page2.png", bytes: PNG }];
	let testId = "";

	it("several pages become one material that waits for review", async () => {
		const outcome = service.uploadTest(course.id, pages);
		assert.ok(outcome.ok);
		testId = outcome.material.id;
		assert.deepEqual([outcome.material.kind, outcome.material.format], ["test", "image"]);
		const waiting = await settled(testId);
		assert.deepEqual([waiting.status, waiting.aiReadParts], ["review", 2]);
		assert.deepEqual(fs.readdirSync(path.join(PATHS.materials, testId)).filter((f) => f.startsWith("original")).sort(), ["original-1.png", "original-2.png"]);
		assert.equal(service.getMaterial(testId)!.reading!.questions.length, 4);
		assert.deepEqual([imported.length, stores.evidenceStore.read().length], [0, 0], "nothing is recorded before approval");
	});

	it("approval adds the tested ideas, links the questions and records each marked result", async () => {
		const edited = { ...reading, questions: reading.questions.map((q) => (q.number === "1" ? { ...q, marksAwarded: 2, outcome: "correct" as const } : q)) };
		assert.equal((service.approveMaterial(testId, { reading: { questions: [] } }) as { code: string }).code, "empty_reading");
		assert.ok(service.approveMaterial(testId, { reading: edited }).ok);
		const done = await settled(testId);
		assert.deepEqual([done.status, done.score, done.unplaced], ["ready", { earned: 4, possible: 5 }, 1]);
		assert.deepEqual(imported.at(-1), {
			filePath: "Probability/page1.png",
			text: "# Ideas tested in page1\n\n- Bayes' rule divides by P(B).\n- Independent events multiply.\n- Simpson's paradox reverses a trend.",
		});
		const ledger = stores.evidenceStore.read();
		assert.deepEqual(ledger.map((e) => [e.id, e.outcome, e.nodeIds]), [
			[`test:${testId}:0`, "correct", ["n_bayes"]], // the learner's correction, and the invented id dropped
			[`test:${testId}:1`, "correct", ["n_indep"]],
			[`test:${testId}:2`, "wrong", []],
		]);
		assert.deepEqual(service.getMaterial(testId)!.reading!.questions.map((q) => q.nodeIds), [["n_bayes"], ["n_indep"], [], []]);
	});

	it("the view derives each idea's state and lists its results; unplaced and dangling results count toward nothing", async () => {
		stores.evidenceStore.append([{ id: "dangling", at: "2026-11-09T00:00:00.000Z", nodeIds: ["n_deleted_upstream"], from: "test", outcome: "wrong", summary: "gone" }]);
		const view = await (await evidenceRoute.GET()).json();
		assert.deepEqual(view.states, { n_bayes: "demonstrated", n_indep: "demonstrated", n_other: "unseen" });
		assert.deepEqual(Object.keys(view.results).sort(), ["n_bayes", "n_indep"]);
		const [result] = view.results.n_bayes;
		assert.deepEqual([result.outcome, result.from, result.source], ["correct", "test", { label: "page1", href: `/course/${course.id}` }]);
		assert.match(result.summary, /^Q1 \(2\/2\): State Bayes' rule\.$/);
	});

	it("a failure after approval retries from extraction, keeping the learner's edits", async () => {
		const outcome = service.uploadTest(course.id, pages);
		assert.ok(outcome.ok);
		await settled(outcome.material.id);
		behavior.linkFails = true;
		service.approveMaterial(outcome.material.id, {});
		const failed = await settled(outcome.material.id);
		assert.deepEqual([failed.status, failed.error], ["failed", "The provider refused the request."]);
		const readsBefore = reads;
		behavior.linkFails = false;
		assert.ok(service.retryMaterial(outcome.material.id).ok);
		assert.equal((await settled(outcome.material.id)).status, "ready");
		assert.equal(reads, readsBefore, "the paper is not read again");
		assert.equal(stores.evidenceStore.read().filter((e) => e.materialId === outcome.material.id).length, 3);
		assert.equal(service.deleteMaterial(outcome.material.id), true);
		assert.equal(stores.evidenceStore.read().filter((e) => e.materialId === outcome.material.id).length, 0, "deleting a test removes its results");
	});

	it("refuses papers that are not photos or one PDF, and oversize sets", () => {
		const code = (files: { name: string; bytes: Uint8Array }[]) => (service.uploadTest(course.id, files) as { code: string }).code;
		assert.equal(code([]), "no_files");
		assert.equal(code([{ name: "notes.md", bytes: Buffer.from("# hi") }]), "unsupported");
		assert.equal(code([{ name: "a.pdf", bytes: Buffer.from("%PDF-1.7") }, { name: "b.png", bytes: PNG }]), "unsupported");
		assert.equal(code(Array.from({ length: 11 }, (_, i) => ({ name: `p${i}.png`, bytes: PNG }))), "too_many_pages");
		assert.equal((service.uploadTest("course_missing", pages) as { code: string }).code, "course_not_found");
	});
});

describe("practice sessions feed the ledger when a turn settles", () => {
	it("folds a concluded, targeted problem once, and reads it back through the view", async () => {
		const chat = stores.chatStore.createChat("Bayes drills", "practice");
		const messages = [
			{ id: "a1", role: "assistant", stopReason: "toolUse", timestamp: 1_800_000_100_000, content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Apply Bayes.", target: ["n_bayes"] } }] },
			{ id: "r1", role: "toolResult", toolCallId: "p1", toolName: "problem", content: [{ type: "text", text: "posed" }], isError: false, timestamp: 1_800_000_100_001 },
			{ id: "a2", role: "assistant", stopReason: "toolUse", timestamp: 1_800_000_100_002, content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "surrendered", verdict: "Could not set up the ratio." } }] },
			{ id: "r2", role: "toolResult", toolCallId: "c1", toolName: "conclude", content: [{ type: "text", text: "concluded" }], isError: false, timestamp: 1_800_000_100_003 },
		] as unknown as LhMessage[];
		stores.chatStore.saveMessages(chat.id, messages);
		emit("turn-settled", { chatId: chat.id });
		const mine = () => stores.evidenceStore.read().filter((e) => e.chatId === chat.id);
		assert.equal(mine().length, 1, "the bus subscription folded the settled turn");
		assert.equal(syncPracticeEvidence(chat.id), 0, "a second fold appends nothing");
		const view = evidenceView();
		// One correct test answer, then a practice surrender: latest wrong, average 0.5 → shaky.
		assert.equal(view.states.n_bayes, "shaky");
		assert.deepEqual(view.results.n_bayes!.map((r) => [r.from, r.outcome]), [["practice", "wrong"], ["test", "correct"]]);
		assert.deepEqual(view.results.n_bayes![0]!.source, { label: "Bayes drills", href: `/chat/${chat.id}` });
		const teach = stores.chatStore.createChat("A lesson");
		stores.chatStore.saveMessages(teach.id, messages);
		assert.equal(syncPracticeEvidence(teach.id), 0, "only practice sessions are folded");
	});
});

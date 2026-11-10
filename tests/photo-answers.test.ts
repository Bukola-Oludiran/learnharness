/**
 * Photo answers (fork, phase 2 — FORK.md): the upload route, the input
 * events that carry attachment ids, and the provider-boundary step that
 * turns ids into images. Runs under an isolated LH_DATA_DIR, set before
 * the first config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-photo-answers-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { POST } = await import("../app/api/chats/[id]/attachments/route.ts");
const images = await import("../app/api/chats/[id]/images/[snapshotId]/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { isHeif } = await import("../src/server/attachments.ts");
const { PATHS } = await import("../config.ts");
const {
	assertAttachmentsUploaded, attachmentIdsOf, ChatInputError, hasPhotoAnswers, inputAppends, MAX_ANSWER_ATTACHMENTS,
	parseAttachmentIds, parseChatInput, PHOTO_ANSWER_RULE,
} = await import("../src/core/index.ts");
const { newAnswerResult, newThinkingMessage, newUserMessage, toLlmMessages } = await import("../src/core/native-messages.ts");
const { buildAnswer, compactAnswerForModel } = await import("../src/core/question-core.ts");
const { composeInstructions, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { createFauxCore } = await import("@earendil-works/pi-ai");
import type { LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData, QuestionData } from "../src/core/question-core.ts";

function picture(width = 40, height = 30): Buffer {
	const canvas = createCanvas(width, height);
	canvas.getContext("2d").fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}
const at = (id: string) => ({ params: Promise.resolve({ id }) });
const upload = (chatId: string, bytes: Uint8Array) =>
	POST(new Request("http://test/api", { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from(bytes) }), at(chatId));
const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const pool = { [ID_A]: { mimeType: "image/png" as const, data: "QUJD", width: 4, height: 3 } };
const answer = (extra: Partial<QuestionAnswerData> = {}): QuestionAnswerData =>
	({ kind: "explain", questionText: "Why?", dontKnow: false, answers: [], answeredAt: "2026-11-10T00:00:00.000Z", ...extra });

describe("the attachments route", () => {
	it("stores the processed photo once in the session's image pool and returns its id", async () => {
		const chat = stores.chatStore.createChat("Photo session");
		const before = stores.chatStore.getChat(chat.id)!.updatedAt;
		const res = await upload(chat.id, picture());
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.match(body.snapshotId, /^[a-f0-9]{64}$/);
		assert.deepEqual([body.mimeType, body.width, body.height], ["image/png", 40, 30]);
		assert.equal((await (await upload(chat.id, picture())).json()).snapshotId, body.snapshotId, "identical bytes share one snapshot");
		const record = stores.chatStore.getChat(chat.id)!;
		assert.deepEqual(Object.keys(record.imageSnapshots ?? {}), [body.snapshotId]);
		assert.equal(record.updatedAt, before, "an upload is not conversation activity");
		assert.deepEqual(record.messages, []);
		const served = await images.GET(new Request("http://test/api"), { params: Promise.resolve({ id: chat.id, snapshotId: body.snapshotId }) });
		assert.equal(served.status, 200);
	});

	it("refuses unknown sessions, empty bodies and non-images without writing anything", async () => {
		const chat = stores.chatStore.createChat("Refusals");
		assert.equal((await upload("chat_missing", picture())).status, 404);
		assert.equal((await upload(chat.id, new Uint8Array())).status, 400);
		const notImage = await upload(chat.id, Buffer.from("just some text, not a picture"));
		assert.equal(notImage.status, 400);
		assert.match((await notImage.json()).error, /Not a supported image/);
		assert.equal(stores.chatStore.getChat(chat.id)!.imageSnapshots, undefined);
		assert.ok(!fs.readdirSync(PATHS.chats).some((f) => f.includes(".tmp")));
	});

	it("recognises HEIC by its container brand, not its name", () => {
		const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(12)]);
		assert.equal(isHeif(heic), true);
		assert.equal(isHeif(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)])), false);
		assert.equal(isHeif(picture()), false);
		assert.equal(isHeif(new Uint8Array(4)), false);
	});
});

describe("input events carry attachment ids", () => {
	it("parses ids, dedupes them, and refuses malformed or oversized lists", () => {
		assert.deepEqual(parseAttachmentIds(undefined), { ids: [] });
		assert.deepEqual(parseAttachmentIds([ID_A, ID_A, ID_B]).ids, [ID_A, ID_B]);
		for (const bad of ["x", [1], ["not-an-id"], [ID_A.toUpperCase()]]) assert.ok(parseAttachmentIds(bad).problem);
		const many = Array.from({ length: MAX_ANSWER_ATTACHMENTS + 1 }, (_, i) => String(i).repeat(64).slice(0, 64));
		assert.match(parseAttachmentIds(many).problem!, /at most 4 photos/);
	});

	it("a practice submission may be photo-only; with neither text nor photos it is refused", () => {
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p1", text: "", attachments: [ID_A] }),
			{ type: "thinking", problemCallId: "p1", text: "", attachments: [ID_A] });
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p1", text: "x" }), { type: "thinking", problemCallId: "p1", text: "x" });
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p1", text: "  " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p1", text: "x", attachments: ["nope"] }), ChatInputError);
	});

	it("an answer's attachment list is validated; an empty list leaves upstream's exact shape", () => {
		const parsed = parseChatInput({ type: "answer", toolCallId: "t1", answer: answer({ attachments: [ID_A, ID_A] }) });
		assert.deepEqual(parsed.type === "answer" && parsed.answer.attachments, [ID_A]);
		const empty = parseChatInput({ type: "answer", toolCallId: "t1", answer: answer({ attachments: [] }) });
		assert.ok(empty.type === "answer" && !("attachments" in empty.answer));
		assert.throws(() => parseChatInput({ type: "answer", toolCallId: "t1", answer: answer({ attachments: ["bad"] as string[] }) }), ChatInputError);
	});

	it("the server refuses ids that were never uploaded to the session", () => {
		const thinking = { type: "thinking" as const, problemCallId: "p1", text: "", attachments: [ID_A] };
		assert.doesNotThrow(() => assertAttachmentsUploaded(thinking, pool));
		assert.throws(() => assertAttachmentsUploaded(thinking, undefined), /not uploaded to this session/);
		assert.throws(() => assertAttachmentsUploaded({ type: "answer", toolCallId: "t", answer: answer({ attachments: [ID_B] }) }, pool), ChatInputError);
		assert.doesNotThrow(() => assertAttachmentsUploaded({ type: "text", text: "hi" }, undefined));
		assert.doesNotThrow(() => assertAttachmentsUploaded({ type: "thinking", problemCallId: "p1", text: "x" }, undefined));
	});

	it("buildAnswer and the model-facing record carry the photos as ids and a count", () => {
		const qd: QuestionData = { id: "t1", kind: "explain", question: "Why?", mode: "text", options: [], createdAt: "2026-11-10T00:00:00.000Z" };
		const built = buildAnswer(qd, { text: "", attachments: [ID_A, ID_B] }, "explain");
		assert.deepEqual(built.attachments, [ID_A, ID_B]);
		assert.equal(built.text, undefined);
		assert.deepEqual(compactAnswerForModel(built), { kind: "explain", photos: 2 });
		assert.ok(!("attachments" in buildAnswer(qd, { text: "words" }, "explain")));
		assert.ok(!("photos" in compactAnswerForModel(answer({ text: "words" }))));
	});
});

describe("the record stores ids; images join at the provider boundary", () => {
	it("a thinking marker keeps ids in details and reads as a sentence when photo-only", () => {
		const marker = newThinkingMessage("p1", "", [ID_A]);
		assert.deepEqual(marker.details, { problemCallId: "p1", text: "", attachments: [ID_A] });
		assert.match(marker.content, /\(See the attached photo\.\)$/);
		assert.match(newThinkingMessage("p1", "", [ID_A, ID_B]).content, /\(See the 2 attached photos\.\)$/);
		assert.deepEqual(newThinkingMessage("p1", "my work").details, { problemCallId: "p1", text: "my work" });
		assert.ok(!JSON.stringify(marker).includes("QUJD"), "no image bytes in the record");
	});

	it("inputAppends threads a thinking event's photos into the marker", () => {
		const problem = { id: "m1", role: "assistant", stopReason: "toolUse", timestamp: 1, content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Solve." } }] } as unknown as LhMessage;
		const posed = { id: "m2", role: "toolResult", toolCallId: "p1", toolName: "problem", content: [{ type: "text", text: "posed" }], isError: false, timestamp: 2 } as unknown as LhMessage;
		const [appended] = inputAppends({ messages: [problem, posed], kind: "practice" }, { type: "thinking", problemCallId: "p1", text: "", attachments: [ID_A] });
		assert.deepEqual(attachmentIdsOf(appended), [ID_A]);
	});

	it("toLlmMessages appends each photo after the text of a marker and of an answer result", () => {
		const marker = newThinkingMessage("p1", "my work", [ID_A]);
		const result = newAnswerResult("t1", "explain", answer({ attachments: [ID_A] }));
		const [user, tool] = toLlmMessages([marker, result], pool);
		assert.deepEqual((user as { content: unknown[] }).content.slice(1), [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
		const toolContent = (tool as { content: Array<{ type: string; text?: string }> }).content;
		assert.equal(toolContent.length, 2);
		assert.deepEqual(JSON.parse(toolContent[0]!.text!), { kind: "explain", photos: 1 });
		assert.deepEqual(toolContent[1], { type: "image", data: "QUJD", mimeType: "image/png" });
	});

	it("a photo missing from the pool becomes a visible note, never a silent omission", () => {
		const [user] = toLlmMessages([newThinkingMessage("p1", "my work", [ID_B])], pool);
		assert.deepEqual((user as { content: unknown[] }).content[1], { type: "text", text: "[An attached photo is no longer available.]" });
	});

	it("messages without attachments convert exactly as upstream, with or without a pool", () => {
		const messages = [newUserMessage("hello"), newThinkingMessage("p1", "plain"), newAnswerResult("t1", "explain", answer({ text: "words" }))];
		assert.deepEqual(toLlmMessages(messages, pool), toLlmMessages(messages));
		assert.equal(hasPhotoAnswers(messages), false);
		assert.equal(hasPhotoAnswers([...messages, newThinkingMessage("p1", "", [ID_A])]), true);
	});
});

describe("the tutor's photo rule", () => {
	it("carries the approved wording", () => {
		assert.equal(PHOTO_ANSWER_RULE, [
			"# Photos of the learner's work",
			"The learner can answer with photos of handwritten or drawn work. They arrive as images beside the answer.",
			"Before you judge a photo answer, restate in one or two lines what you read from it: the key steps, the values and the final answer as you understood them. Then judge that reading. If part of the image is unclear or cut off, say which part and ask about it. Never mark work wrong on a guess at what it says.",
			// Phase 5a: the canvas paragraph.
			"A drawing made on the canvas arrives with an outline of its labelled shapes and arrows. Use the outline for what is labelled and what connects to what, and the image for layout. When you give feedback, name the specific shapes and arrows you mean.",
		].join("\n\n"));
	});

	it("extra segments append in order; none leaves upstream's prompt untouched", () => {
		const engine = () => { const faux = createFauxCore({}); return { model: faux.getModel(), streamFn: faux.streamSimple }; };
		const both = createTeacherAgent(undefined, { engine: engine(), extraSegments: ["COURSE", PHOTO_ANSWER_RULE] });
		assert.equal(both.state.systemPrompt, [composeInstructions("teacher"), "COURSE", PHOTO_ANSWER_RULE].join("\n\n---\n\n"));
		assert.equal(createTeacherAgent(undefined, { engine: engine(), extraSegments: [] }).state.systemPrompt, composeInstructions("teacher"));
	});
});

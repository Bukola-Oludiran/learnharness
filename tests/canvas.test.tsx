/**
 * The drawing canvas (fork, phase 5a — FORK.md): the scene outline, the
 * canvases service and routes, the outline's place in the tutor's input,
 * and the dock's Draw button. The editor itself (Excalidraw) is browser-only
 * and is not loaded here. Runs under an isolated LH_DATA_DIR, set before
 * the first config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-canvas-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { DRAWING_RULE, drawingOutlineBlock, sceneElements, sceneOutline, shapeLetter } = await import("../src/core/canvas.ts");
const { attachmentBlocks, PHOTO_ANSWER_RULE } = await import("../src/core/attachments.ts");
const { answerImagePool, listCanvases, readCanvasScene, saveCanvas } = await import("../src/server/canvases.ts");
const { stores } = await import("../src/server/stores.ts");
const { PATHS } = await import("../config.ts");
const listRoute = await import("../app/api/chats/[id]/canvases/route.ts");
const sceneRoute = await import("../app/api/chats/[id]/canvases/[snapshotId]/route.ts");
const { AttachPhotoButton } = await import("../components/answer-attachments.tsx");
import type { SceneElement } from "../src/core/canvas.ts";

const shape = (id: string, type: string, x: number, y: number, extra: Partial<SceneElement> = {}): SceneElement => ({ id, type, x, y, ...extra });
const label = (id: string, containerId: string, text: string): SceneElement => ({ id, type: "text", containerId, text });
const arrow = (id: string, from?: string, to?: string, type = "arrow"): SceneElement => ({
	id, type, startBinding: from ? { elementId: from } : null, endBinding: to ? { elementId: to } : null,
});

describe("the outline of a drawing", () => {
	const scene: SceneElement[] = [
		shape("srv", "rectangle", 300, 100),
		shape("cli", "rectangle", 0, 100),
		shape("db", "ellipse", 300, 400),
		shape("gone", "diamond", 0, 0, { isDeleted: true }),
		label("t1", "cli", "Client"),
		label("t2", "srv", "API\n  server"),
		arrow("a1", "cli", "srv"),
		label("t3", "a1", "HTTP request"),
		arrow("a2", "srv", "db"),
		arrow("a3", "db"),
		arrow("a4", undefined, "cli"),
		arrow("a5"),
		arrow("l1", "cli", "db", "line"),
		{ id: "note", type: "text", text: "v2 design", containerId: null },
		{ id: "f1", type: "freedraw" }, { id: "f2", type: "freedraw" },
	];

	it("letters shapes in reading order and states each arrow's ends as facts", () => {
		assert.equal(sceneOutline(scene), [
			"Shapes:",
			'- A: rectangle "Client"',
			'- B: rectangle "API server"',
			"- C: ellipse, no label",
			"Arrows:",
			'- A → B "HTTP request"',
			"- B → C",
			"- from C to nothing (not attached at its end)",
			"- from nothing to A (not attached at its start)",
			"- a loose arrow, attached to nothing",
			"- A — C",
			'Loose text: "v2 design"',
			"Freehand strokes: 2",
		].join("\n"));
	});

	it("handles an empty scene, frames, an arrow bound to a deleted shape, and very large drawings", () => {
		assert.equal(sceneOutline([]), "");
		assert.equal(sceneOutline([shape("f", "frame", 0, 0, { name: "Stage 1" })]), 'Shapes:\n- A: frame "Stage 1"');
		assert.equal(sceneOutline([shape("x", "rectangle", 0, 0, { isDeleted: true }), arrow("a", "x")]), "Arrows:\n- a loose arrow, attached to nothing");
		const many = sceneOutline(Array.from({ length: 200 }, (_, i) => shape(`s${i}`, "rectangle", i, 0)));
		assert.match(many, /\n\(81 more lines not shown\)$/);
		assert.deepEqual([0, 25, 26, 27, 701, 702].map(shapeLetter), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
	});

	it("reads only what looks like a scene", () => {
		assert.equal(sceneElements({ elements: "no" }), null);
		assert.equal(sceneElements(null), null);
		assert.deepEqual(sceneElements({ elements: [shape("a", "rectangle", 0, 0), null, { id: 3 }, "x"] }), [shape("a", "rectangle", 0, 0)]);
	});
});

describe("what the tutor reads", () => {
	it("puts a drawing's outline in front of its image, and leaves photos as they were", () => {
		const pool = { aa: { mimeType: "image/png" as const, data: "QQ==", width: 1, height: 1, outline: drawingOutlineBlock("Shapes:\n- A: rectangle") }, bb: { mimeType: "image/jpeg" as const, data: "Qg==", width: 1, height: 1 } };
		assert.deepEqual(attachmentBlocks({ details: { attachments: ["a".repeat(64)] } }, undefined), [{ type: "text", text: "[An attached photo is no longer available.]" }]);
		const ids = { drawing: "a".repeat(64), photo: "b".repeat(64) };
		const blocks = attachmentBlocks({ details: { attachments: [ids.drawing, ids.photo] } }, { [ids.drawing]: pool.aa, [ids.photo]: pool.bb });
		assert.deepEqual(blocks, [
			{ type: "text", text: "The learner's drawing, as an outline computed from the canvas. Labels and connections are exact; layout is only in the image.\n\nShapes:\n- A: rectangle" },
			{ type: "image", data: "QQ==", mimeType: "image/png" },
			{ type: "image", data: "Qg==", mimeType: "image/jpeg" },
		]);
		assert.equal(drawingOutlineBlock("x").endsWith("\n\nx"), true);
	});

	it("the photo rule tells the tutor how to use the outline", () => {
		assert.ok(PHOTO_ANSWER_RULE.includes(`\n\n${DRAWING_RULE}`));
		assert.match(DRAWING_RULE, /Use the outline for what is labelled and what connects to what, and the image for layout\./);
		assert.match(DRAWING_RULE, /name the specific shapes and arrows you mean\.$/);
	});
});

describe("saved drawings", () => {
	const chat = stores.chatStore.createChat("Architecture");
	const png = Buffer.from("fake png bytes");
	const snapshotId = createHash("sha256").update(png).digest("hex");
	stores.chatStore.saveImageSnapshot(chat.id, snapshotId, { mimeType: "image/png", data: png.toString("base64"), width: 10, height: 10 });
	const scene = JSON.stringify({ type: "excalidraw", elements: [shape("c", "rectangle", 0, 0), label("t", "c", "Client")], files: {} });
	const put = async (id: string, snap: string, body: string) =>
		sceneRoute.PUT(new Request("http://test/api", { method: "PUT", body }), { params: Promise.resolve({ id, snapshotId: snap }) });

	it("keeps the scene and its outline under the image's id, only for an uploaded image of a real session", async () => {
		assert.equal((await put(chat.id, snapshotId, scene)).status, 200);
		assert.ok(fs.existsSync(path.join(PATHS.canvases, chat.id, `${snapshotId}.excalidraw`)));
		assert.equal(fs.readFileSync(path.join(PATHS.canvases, chat.id, `${snapshotId}.outline.txt`), "utf-8"), 'Shapes:\n- A: rectangle "Client"');
		assert.equal((await put(chat.id, "f".repeat(64), scene)).status, 404, "no such image in the session");
		assert.equal((await put("chat_nope", snapshotId, scene)).status, 404);
		assert.equal((await put(chat.id, "../../etc", scene)).status, 404);
		assert.equal((await put(chat.id, snapshotId, "{not json")).status, 400);
		assert.equal((await put(chat.id, snapshotId, JSON.stringify({ elements: 3 }))).status, 400);
		assert.deepEqual(saveCanvas(chat.id, snapshotId, " ".repeat(5 * 1024 * 1024 + 1)), { ok: false, status: 413, error: "The drawing is too large to save" });
	});

	it("lists a session's drawings and hands a scene back to reopen", async () => {
		const res = await listRoute.GET(new Request("http://test/api"), { params: Promise.resolve({ id: chat.id }) });
		const { canvases } = (await res.json()) as { canvases: { snapshotId: string; createdAt: string }[] };
		assert.deepEqual(canvases.map((c) => c.snapshotId), [snapshotId]);
		assert.ok(!Number.isNaN(Date.parse(canvases[0]!.createdAt)));
		const got = await sceneRoute.GET(new Request("http://test/api"), { params: Promise.resolve({ id: chat.id, snapshotId }) });
		assert.equal(await got.text(), scene);
		assert.equal((await sceneRoute.GET(new Request("http://test/api"), { params: Promise.resolve({ id: chat.id, snapshotId: "e".repeat(64) }) })).status, 404);
		assert.deepEqual(listCanvases("chat_nope"), []);
		assert.deepEqual(listCanvases("../x"), []);
		assert.equal(readCanvasScene("../x", snapshotId), null);
	});

	it("joins outlines onto the turn's image pool, and leaves a session without drawings untouched", () => {
		const record = stores.chatStore.getChat(chat.id)!;
		const pool = answerImagePool(chat.id, record.imageSnapshots)!;
		assert.equal(pool[snapshotId]!.outline, drawingOutlineBlock('Shapes:\n- A: rectangle "Client"'), "the pool carries the finished text block");
		assert.equal(pool[snapshotId]!.data, png.toString("base64"));
		assert.equal("outline" in record.imageSnapshots![snapshotId]!, false, "the stored snapshot is not changed");
		const other = stores.chatStore.createChat("No drawings");
		const plain = { x: { mimeType: "image/png" as const, data: "QQ==", width: 1, height: 1 } };
		assert.equal(answerImagePool(other.id, plain), plain);
		assert.equal(answerImagePool(other.id, undefined), undefined);
	});

	it("an empty drawing saves with no outline and reaches the tutor as its image only", () => {
		const blank = Buffer.from("blank png");
		const blankId = createHash("sha256").update(blank).digest("hex");
		stores.chatStore.saveImageSnapshot(chat.id, blankId, { mimeType: "image/png", data: blank.toString("base64"), width: 1, height: 1 });
		assert.deepEqual(saveCanvas(chat.id, blankId, JSON.stringify({ elements: [] })), { ok: true, outline: "" });
		assert.equal(answerImagePool(chat.id, stores.chatStore.getChat(chat.id)!.imageSnapshots)![blankId]!.outline, undefined);
	});
});

describe("the dock's attach buttons", () => {
	const attachments = (overrides: object = {}) => ({ items: [], uploading: false, notice: null, addFiles: () => {}, addDrawing: () => {}, addGraph: () => {}, chatId: "chat_1", remove: () => {}, clear: () => {}, onPasteCapture: () => {}, ...overrides });

	it("offers Draw beside Photo, and neither when the answer is full", () => {
		const html = renderToStaticMarkup(<AttachPhotoButton attachments={attachments() as never} />);
		assert.match(html, /data-testid="attach-drawing"[^>]*>[\s\S]*?Draw<[\s\S]*data-testid="attach-graph"[^>]*>[\s\S]*?Graph<[\s\S]*data-testid="attach-photo"[^>]*>[\s\S]*?Photo</);
		assert.doesNotMatch(html, /grapher-overlay/, "the grapher is not mounted until Graph is pressed");
		assert.doesNotMatch(html, /canvas-editor/, "the canvas is not mounted until Draw is pressed");
		const item = { key: "k", name: "n", previewUrl: "blob:x", status: "ready" };
		const full = renderToStaticMarkup(<AttachPhotoButton attachments={attachments({ items: [item, item, item, item] }) as never} />);
		assert.match(full, /data-testid="attach-drawing"[^>]* disabled=""/);
		assert.match(full, /data-testid="attach-photo"[^>]* disabled=""/);
		assert.doesNotMatch(renderToStaticMarkup(<AttachPhotoButton attachments={attachments({ chatId: undefined }) as never} />), /attach-drawing/);
	});
});

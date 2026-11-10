/**
 * Canvases service (fork, phase 5a — see FORK.md). A drawing is attached
 * to an answer as an ordinary image snapshot (the phase-2 path); this
 * service keeps the editable scene beside it, keyed by that snapshot's id,
 * and gives the tutor the scene's outline at turn time.
 */

import { drawingOutlineBlock, MAX_SCENE_BYTES, sceneElements, sceneOutline, type CanvasSummary } from "../core/canvas.ts";
import { cleanPlotDoc, plotOutline, plotOutlineBlock, type PlotDoc } from "../core/plot/index.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ImagePool } from "../core/attachments.ts";
import type { ImageSnapshot } from "../core/contracts.ts";
import { stores } from "./stores.ts";

export type CanvasOutcome = { ok: true; outline: string } | { ok: false; status: 400 | 404 | 413; error: string };

/** Store the scene of a drawing whose image is already in the session's pool. */
export function saveCanvas(chatId: string, snapshotId: string, sceneJson: string): CanvasOutcome {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, error: "No such session" };
	if (!/^[a-f0-9]{64}$/.test(snapshotId) || !chat.imageSnapshots?.[snapshotId]) return { ok: false, status: 404, error: "Upload the drawing's image first" };
	if (Buffer.byteLength(sceneJson) > MAX_SCENE_BYTES) return { ok: false, status: 413, error: "The drawing is too large to save" };
	let scene: unknown;
	try {
		scene = JSON.parse(sceneJson);
	} catch {
		return { ok: false, status: 400, error: "The drawing could not be read" };
	}
	// A graph (phase 5b) is saved the same way, as its cleaned document.
	if ((scene as { type?: unknown } | null)?.type === "plot") {
		const doc = cleanPlotDoc(scene);
		if (!doc) return { ok: false, status: 400, error: "The graph could not be read" };
		const outline = plotOutline(doc);
		stores.canvasStore.saveCanvas(chatId, snapshotId, "plot", JSON.stringify(doc), outline);
		return { ok: true, outline };
	}
	const elements = sceneElements(scene);
	if (!elements) return { ok: false, status: 400, error: "The drawing could not be read" };
	const outline = sceneOutline(elements);
	stores.canvasStore.saveCanvas(chatId, snapshotId, "drawing", sceneJson, outline);
	return { ok: true, outline };
}

/** The session's saved drawings, oldest first; empty for an unknown session. */
export function listCanvases(chatId: string): CanvasSummary[] {
	return /^[A-Za-z0-9_-]+$/.test(chatId) ? stores.canvasStore.listCanvases(chatId) : [];
}

export function readCanvasScene(chatId: string, snapshotId: string): string | null {
	return /^[A-Za-z0-9_-]+$/.test(chatId) && /^[a-f0-9]{64}$/.test(snapshotId) ? stores.canvasStore.readScene(chatId, snapshotId) : null;
}

/** The turn's image pool: the session's snapshots, with each canvas
 *  drawing's outline joined on. Unchanged (the same object) when the
 *  session has no drawings. */
export function answerImagePool(chatId: string, pool: Readonly<Record<string, ImageSnapshot>> | undefined): ImagePool | undefined {
	if (!pool) return pool;
	const outlines = stores.canvasStore.readOutlines(chatId);
	const drawn = Object.keys(outlines).filter((id) => Object.hasOwn(pool, id));
	if (drawn.length === 0) return pool;
	const joined: Record<string, ImageSnapshot & { outline?: string }> = { ...pool };
	// The pool carries the finished text block: a drawing and a graph are introduced differently.
	for (const id of drawn) {
		const { kind, outline } = outlines[id]!;
		joined[id] = { ...pool[id]!, outline: kind === "plot" ? plotOutlineBlock(outline) : drawingOutlineBlock(outline) };
	}
	return joined;
}

/** One graph of a session the learner can start from: the tutor's, or one they sent. */
export interface SessionPlot {
	id: string;
	from: "tutor" | "you";
	doc: PlotDoc;
}

/** The session's graphs in order: those the tutor placed with the `graph`
 *  tool (read from the transcript), then those the learner sent. */
export function listSessionPlots(chatId: string): SessionPlot[] {
	const chat = /^[A-Za-z0-9_-]+$/.test(chatId) ? stores.chatStore.getChat(chatId) : null;
	if (!chat) return [];
	const out: SessionPlot[] = [];
	for (const message of chat.messages) {
		if ((message as { role?: string }).role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		if (result.toolName !== "graph" || result.isError) continue;
		const doc = cleanPlotDoc(result.details);
		if (doc && doc.lines.length > 0) out.push({ id: result.toolCallId, from: "tutor", doc });
	}
	for (const saved of stores.canvasStore.listCanvases(chatId)) {
		if (saved.kind !== "plot") continue;
		try {
			const doc = cleanPlotDoc(JSON.parse(stores.canvasStore.readScene(chatId, saved.snapshotId) ?? "null"));
			if (doc) out.push({ id: saved.snapshotId, from: "you", doc });
		} catch {
			// an unreadable saved graph is simply not offered
		}
	}
	return out;
}

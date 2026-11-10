/**
 * Canvases service (fork, phase 5a — see FORK.md). A drawing is attached
 * to an answer as an ordinary image snapshot (the phase-2 path); this
 * service keeps the editable scene beside it, keyed by that snapshot's id,
 * and gives the tutor the scene's outline at turn time.
 */

import { MAX_SCENE_BYTES, sceneElements, sceneOutline, type CanvasSummary } from "../core/canvas.ts";
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
	const elements = sceneElements(scene);
	if (!elements) return { ok: false, status: 400, error: "The drawing could not be read" };
	const outline = sceneOutline(elements);
	stores.canvasStore.saveCanvas(chatId, snapshotId, sceneJson, outline);
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
	for (const id of drawn) joined[id] = { ...pool[id]!, outline: outlines[id] };
	return joined;
}

/**
 * CanvasStore — the fs adapter (data/canvases/<chatId>/): for each drawing,
 * <snapshotId>.excalidraw (the scene) and <snapshotId>.outline.txt. Same
 * idioms as the other fork stores: sync fs, id-guarded paths, atomic writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { CanvasSummary } from "../core/canvas.ts";
import type { CanvasStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const CHAT_ID = /^[A-Za-z0-9_-]+$/;
const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const SCENE_NAME = /^([a-f0-9]{64})\.excalidraw$/;
const OUTLINE_NAME = /^([a-f0-9]{64})\.outline\.txt$/;

function chatDir(chatId: string): string {
	if (!CHAT_ID.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.canvases, chatId);
}
function guard(snapshotId: string): string {
	if (!SNAPSHOT_ID.test(snapshotId)) throw new Error(`Invalid snapshot id: ${snapshotId}`);
	return snapshotId;
}

function names(chatId: string): string[] {
	try {
		return fs.readdirSync(chatDir(chatId));
	} catch {
		return []; // no drawings yet
	}
}

export const canvasStore: CanvasStore = {
	saveCanvas(chatId, snapshotId, scene, outline) {
		const dir = chatDir(chatId);
		fs.mkdirSync(dir, { recursive: true });
		writeFileAtomicSync(path.join(dir, `${guard(snapshotId)}.excalidraw`), scene);
		writeFileAtomicSync(path.join(dir, `${snapshotId}.outline.txt`), outline);
	},

	listCanvases(chatId) {
		const out: CanvasSummary[] = [];
		for (const name of names(chatId)) {
			const match = SCENE_NAME.exec(name);
			if (!match) continue;
			try {
				out.push({ snapshotId: match[1]!, createdAt: fs.statSync(path.join(chatDir(chatId), name)).mtime.toISOString() });
			} catch {
				// removed between the listing and the stat
			}
		}
		return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	},

	readScene(chatId, snapshotId) {
		try {
			return fs.readFileSync(path.join(chatDir(chatId), `${guard(snapshotId)}.excalidraw`), "utf-8");
		} catch {
			return null;
		}
	},

	readOutlines(chatId) {
		const out: Record<string, string> = {};
		for (const name of names(chatId)) {
			const match = OUTLINE_NAME.exec(name);
			if (!match) continue;
			try {
				const outline = fs.readFileSync(path.join(chatDir(chatId), name), "utf-8");
				if (outline.trim()) out[match[1]!] = outline;
			} catch {
				// unreadable: the drawing still reaches the tutor as its image
			}
		}
		return out;
	},
};

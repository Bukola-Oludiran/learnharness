/**
 * CanvasStore — the fs adapter (data/canvases/<chatId>/): for each drawing,
 * <snapshotId>.excalidraw (the scene); for each graph (phase 5b),
 * <snapshotId>.plot.json; and beside either, <snapshotId>.outline.txt.
 * Same idioms as the other fork stores: sync fs, id-guarded paths, atomic
 * writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { CanvasKind, CanvasSummary } from "../core/canvas.ts";
import type { CanvasStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const CHAT_ID = /^[A-Za-z0-9_-]+$/;
const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const EXTENSION: Record<CanvasKind, string> = { drawing: "excalidraw", plot: "plot.json" };
const SCENE_NAME = /^([a-f0-9]{64})\.(excalidraw|plot\.json)$/;
const kindOf = (extension: string): CanvasKind => (extension === "excalidraw" ? "drawing" : "plot");

function chatDir(chatId: string): string {
	if (!CHAT_ID.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.canvases, chatId);
}
function guard(snapshotId: string): string {
	if (!SNAPSHOT_ID.test(snapshotId)) throw new Error(`Invalid snapshot id: ${snapshotId}`);
	return snapshotId;
}

function scenes(chatId: string): { snapshotId: string; kind: CanvasKind; file: string }[] {
	let names: string[];
	try {
		names = fs.readdirSync(chatDir(chatId));
	} catch {
		return []; // nothing saved yet
	}
	return names
		.map((name) => ({ name, match: SCENE_NAME.exec(name) }))
		.filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
		.map((entry) => ({ snapshotId: entry.match[1]!, kind: kindOf(entry.match[2]!), file: path.join(chatDir(chatId), entry.name) }));
}

export const canvasStore: CanvasStore = {
	saveCanvas(chatId, snapshotId, kind, scene, outline) {
		const dir = chatDir(chatId);
		fs.mkdirSync(dir, { recursive: true });
		writeFileAtomicSync(path.join(dir, `${guard(snapshotId)}.${EXTENSION[kind]}`), scene);
		writeFileAtomicSync(path.join(dir, `${snapshotId}.outline.txt`), outline);
	},

	listCanvases(chatId) {
		const out: CanvasSummary[] = [];
		for (const scene of scenes(chatId)) {
			try {
				out.push({ snapshotId: scene.snapshotId, kind: scene.kind, createdAt: fs.statSync(scene.file).mtime.toISOString() });
			} catch {
				// removed between the listing and the stat
			}
		}
		return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	},

	readScene(chatId, snapshotId) {
		guard(snapshotId);
		const found = scenes(chatId).find((scene) => scene.snapshotId === snapshotId);
		if (!found) return null;
		try {
			return fs.readFileSync(found.file, "utf-8");
		} catch {
			return null;
		}
	},

	readOutlines(chatId) {
		const out: Record<string, { kind: CanvasKind; outline: string }> = {};
		for (const scene of scenes(chatId)) {
			try {
				const outline = fs.readFileSync(path.join(chatDir(chatId), `${scene.snapshotId}.outline.txt`), "utf-8");
				if (outline.trim()) out[scene.snapshotId] = { kind: scene.kind, outline };
			} catch {
				// unreadable: it still reaches the tutor as its image
			}
		}
		return out;
	},
};

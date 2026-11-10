/**
 * MaterialStore — the fs adapter (data/materials/<id>/): record.json, the
 * app's own copy of the upload (original.<ext>), and the converted
 * transcript (text.md). Same idioms as the course store: sync fs,
 * id-guarded paths, atomic writes, version stamp, newer-version refusal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { MaterialStore } from "../core/ports.ts";
import { CURRENT_MATERIAL_VERSION, MATERIAL_ID_PATTERN, type MaterialRecord, type TestReading } from "../core/contracts.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function materialDir(id: string): string {
	if (!MATERIAL_ID_PATTERN.test(id)) throw new Error(`Invalid material id: ${id}`);
	return path.join(PATHS.materials, id);
}
const recordFile = (id: string) => path.join(materialDir(id), "record.json");
const textFile = (id: string) => path.join(materialDir(id), "text.md");
const readingFile = (id: string) => path.join(materialDir(id), "test.json");
/** original.<ext> (a single upload) or original-<n>.<ext> (page n of several). */
const ORIGINAL_NAME = /^original(?:-(\d+))?\.[a-z0-9]{1,8}$/;

function writeRecord(record: MaterialRecord): void {
	writeFileAtomicSync(recordFile(record.id), JSON.stringify({ ...record, version: CURRENT_MATERIAL_VERSION }, null, "\t"));
	emit("materials-changed", {});
}

function createMaterial(init: Omit<MaterialRecord, "id" | "createdAt" | "updatedAt" | "version">, originals: readonly { bytes: Uint8Array; extension: string }[]): MaterialRecord {
	if (originals.length === 0) throw new Error("A material needs at least one file");
	for (const { extension } of originals) {
		if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error(`Invalid material extension: ${extension}`);
	}
	const now = new Date().toISOString();
	const record: MaterialRecord = { ...init, id: `mat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now };
	fs.mkdirSync(materialDir(record.id), { recursive: true });
	originals.forEach(({ bytes, extension }, index) => {
		const name = originals.length === 1 ? `original.${extension}` : `original-${index + 1}.${extension}`;
		fs.writeFileSync(path.join(materialDir(record.id), name), bytes);
	});
	writeRecord(record);
	return { ...record, version: CURRENT_MATERIAL_VERSION };
}

function getMaterial(id: string): MaterialRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(recordFile(id), "utf-8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_MATERIAL_VERSION) {
		console.error(`[material ${id}] record stamped with schema version ${v} > ${CURRENT_MATERIAL_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	const record = parsed as MaterialRecord;
	return record.id === id && typeof record.title === "string" && typeof record.status === "string" ? record : null;
}

function listMaterials(): MaterialRecord[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(PATHS.materials);
	} catch {
		return []; // no materials folder yet
	}
	return entries
		.filter((name) => MATERIAL_ID_PATTERN.test(name))
		.map((name) => getMaterial(name))
		.filter((r): r is MaterialRecord => r !== null)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function saveMaterial(record: MaterialRecord): void {
	if (!fs.existsSync(recordFile(record.id))) throw new Error(`Material not found: ${record.id}`);
	writeRecord({ ...record, updatedAt: new Date().toISOString() });
}

function originalPaths(id: string): string[] {
	try {
		return fs
			.readdirSync(materialDir(id))
			.map((name) => ({ name, match: ORIGINAL_NAME.exec(name) }))
			.filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
			.sort((a, b) => Number(a.match[1] ?? 1) - Number(b.match[1] ?? 1))
			.map((entry) => path.join(materialDir(id), entry.name));
	} catch {
		return [];
	}
}

function readReading(id: string): TestReading | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(readingFile(id), "utf-8")) as TestReading;
		return Array.isArray(parsed?.questions) ? parsed : null;
	} catch {
		return null;
	}
}

function writeReading(id: string, reading: TestReading): void {
	if (!fs.existsSync(recordFile(id))) throw new Error(`Material not found: ${id}`);
	writeFileAtomicSync(readingFile(id), JSON.stringify(reading, null, "\t"));
}

function readText(id: string): string | null {
	try {
		return fs.readFileSync(textFile(id), "utf-8");
	} catch {
		return null;
	}
}

function writeText(id: string, text: string): void {
	if (!fs.existsSync(recordFile(id))) throw new Error(`Material not found: ${id}`);
	writeFileAtomicSync(textFile(id), text);
}

function deleteMaterial(id: string): boolean {
	try {
		if (!fs.existsSync(recordFile(id))) return false;
		fs.rmSync(materialDir(id), { recursive: true, force: true });
		emit("materials-changed", {});
		return true;
	} catch {
		return false;
	}
}

export const materialStore: MaterialStore = {
	createMaterial,
	getMaterial,
	listMaterials,
	saveMaterial,
	originalPaths,
	readReading,
	writeReading,
	readText,
	writeText,
	deleteMaterial,
};

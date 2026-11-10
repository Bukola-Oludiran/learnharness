/**
 * EvidenceStore — the fs adapter for graph/evidence.jsonl (fork, phase 3b).
 * Append-only JSONL beside upstream's graph ledgers; reads skip corrupt
 * lines (the ledgers' rule). `rewrite` is the one destructive seam, used
 * when a test paper is deleted or re-approved — temp file, then rename.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EVIDENCE_FILE } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { EvidenceStore } from "../core/ports.ts";
import type { Evidence } from "../core/contracts.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function isEvidence(value: unknown): value is Evidence {
	const e = value as Evidence | null;
	return (
		typeof e === "object" && e !== null && typeof e.id === "string" && typeof e.at === "string" && Array.isArray(e.nodeIds) &&
		typeof e.from === "string" && (e.outcome === "correct" || e.outcome === "partial" || e.outcome === "wrong")
	);
}

function read(): Evidence[] {
	let raw: string;
	try {
		raw = fs.readFileSync(EVIDENCE_FILE, "utf-8");
	} catch {
		return []; // no ledger yet
	}
	const out: Evidence[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isEvidence(parsed)) out.push(parsed);
		} catch {
			// a torn or corrupt line is skipped, never fatal
		}
	}
	return out;
}

const serialize = (entries: readonly Evidence[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

function append(entries: readonly Evidence[]): number {
	const known = new Set(read().map((entry) => entry.id));
	const fresh = entries.filter((entry) => !known.has(entry.id));
	if (fresh.length === 0) return 0;
	fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
	fs.appendFileSync(EVIDENCE_FILE, serialize(fresh));
	emit("evidence-changed", {});
	return fresh.length;
}

function rewrite(entries: readonly Evidence[]): void {
	fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
	writeFileAtomicSync(EVIDENCE_FILE, serialize(entries));
	emit("evidence-changed", {});
}

export const evidenceStore: EvidenceStore = { read, append, rewrite };

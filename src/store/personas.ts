/**
 * PersonaStore — the fs JSON adapter (personas.json in the data folder;
 * fork, phase 6b — see FORK.md). One small file, read whole and replaced
 * atomically. A missing file is the starter tutors; a file from a newer
 * build, or one that cannot be read, is left alone and reads as empty so
 * nothing is overwritten by guesswork.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PERSONAS_FILE } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { PersonaStore } from "../core/ports.ts";
import { CURRENT_PERSONAS_VERSION, PERSONA_ID_PATTERN, type Persona, type PersonasFile } from "../core/contracts.ts";
import { cleanPersonaName, cleanPersonaOverlay, STARTER_PERSONAS } from "../core/persona.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const starters = (): PersonasFile => ({ version: CURRENT_PERSONAS_VERSION, personas: STARTER_PERSONAS.map((persona) => ({ ...persona, engine: { ...persona.engine } })), sessions: {} });

function clean(raw: unknown): Persona[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	return raw.flatMap((entry: Partial<Persona> | null): Persona[] => {
		const name = cleanPersonaName(entry?.name);
		const engine = entry?.engine;
		if (!entry || typeof entry.id !== "string" || !PERSONA_ID_PATTERN.test(entry.id) || seen.has(entry.id) || !name) return [];
		if (!engine || typeof engine.provider !== "string" || typeof engine.model !== "string" || !engine.provider || !engine.model) return [];
		seen.add(entry.id);
		return [{ id: entry.id, name, engine: { provider: engine.provider, model: engine.model }, promptOverlay: cleanPersonaOverlay(entry.promptOverlay) }];
	});
}

function read(): PersonasFile {
	let text: string;
	try {
		text = fs.readFileSync(PERSONAS_FILE, "utf-8");
	} catch {
		return starters();
	}
	try {
		const parsed = JSON.parse(text) as Partial<PersonasFile> | null;
		if (!parsed || typeof parsed !== "object") throw new Error("not an object");
		if (typeof parsed.version === "number" && parsed.version > CURRENT_PERSONAS_VERSION) {
			console.error(`[personas] file stamped with version ${parsed.version} > ${CURRENT_PERSONAS_VERSION} — this app build is older; reading it as empty`);
			return { version: parsed.version, personas: [], sessions: {} };
		}
		const personas = clean(parsed.personas);
		const sessions = Object.fromEntries(
			Object.entries(parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		return { version: CURRENT_PERSONAS_VERSION, personas, sessions };
	} catch (error) {
		console.error("[personas] the file could not be read; reading it as empty:", error);
		return { version: CURRENT_PERSONAS_VERSION, personas: [], sessions: {} };
	}
}

function write(file: PersonasFile): void {
	// Never replace a file a newer build wrote.
	if (file.version > CURRENT_PERSONAS_VERSION) throw new Error("personas.json was written by a newer version of the app");
	fs.mkdirSync(path.dirname(PERSONAS_FILE), { recursive: true });
	writeFileAtomicSync(PERSONAS_FILE, `${JSON.stringify({ version: CURRENT_PERSONAS_VERSION, personas: file.personas, sessions: file.sessions }, null, "\t")}\n`);
	emit("personas-changed", {});
}

export const personaStore: PersonaStore = { read, write };

import * as fs from "node:fs";
import * as path from "node:path";

import { ACP_MODELS_FILE } from "../../../config.ts";
import { ACP_PROVIDERS, isAcpProvider, type AcpModelInfo, type AcpProviderId } from "../../core/contracts/acp.ts";
import { acpAgent } from "./agents.ts";

/**
 * The models each ACP agent offers (fork, phase 6a — see FORK.md). Which
 * models exist depends on the account, so the truth is what the agent
 * reports when a session starts. That list is remembered here and in a
 * small cache file; until an agent has reported, its built-in short list
 * stands in.
 */

const reported = new Map<AcpProviderId, AcpModelInfo[]>();
let loaded = false;
let version = 0;

const clean = (raw: unknown): AcpModelInfo[] =>
	Array.isArray(raw)
		? raw.flatMap((entry: { id?: unknown; name?: unknown } | null) =>
				entry && typeof entry.id === "string" && /^[\w.[\]:-]{1,80}$/.test(entry.id) ? [{ id: entry.id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 80) : entry.id }] : [],
			).slice(0, 60)
		: [];

function load(): void {
	if (loaded) return;
	loaded = true;
	try {
		const file = JSON.parse(fs.readFileSync(ACP_MODELS_FILE, "utf8")) as Record<string, unknown>;
		for (const provider of ACP_PROVIDERS) {
			const models = clean(file[provider]);
			if (models.length > 0) reported.set(provider, models);
		}
	} catch {
		// no cache yet, or an unreadable one: the short lists stand in
	}
}

/** The agent's models: as last reported, else its short list. */
export function acpModels(provider: AcpProviderId): readonly AcpModelInfo[] {
	load();
	return reported.get(provider) ?? acpAgent(provider)?.seedModels ?? [];
}

/** Changes whenever a list does, so the provider registry knows to rebuild. */
export const acpModelsVersion = (): number => version;

/** Remember what an agent just reported. Returns whether anything changed. */
export function rememberAcpModels(provider: string, raw: unknown): boolean {
	if (!isAcpProvider(provider)) return false;
	load();
	const models = clean(raw);
	if (models.length === 0 || JSON.stringify(models) === JSON.stringify(reported.get(provider))) return false;
	reported.set(provider, models);
	version++;
	try {
		fs.mkdirSync(path.dirname(ACP_MODELS_FILE), { recursive: true });
		fs.writeFileSync(ACP_MODELS_FILE, `${JSON.stringify(Object.fromEntries(reported), null, "\t")}\n`);
	} catch (error) {
		console.error("The ACP model list could not be saved:", error);
	}
	return true;
}

/** Test seam: forget everything, including that the file was read. */
export function resetAcpModelsForTests(): void {
	reported.clear();
	loaded = false;
	version++;
}

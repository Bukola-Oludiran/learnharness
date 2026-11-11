import { createProvider, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";

import { ACP_AGENTS, type AcpAgent } from "./agents.ts";
import { acpModels, acpModelsVersion } from "./model-list.ts";
import { createAcpStreamFunction } from "./stream.ts";

/**
 * ACP agents in the app's model registry (fork, phase 6a — see FORK.md):
 * one provider per agent, with one model entry for each model the agent
 * offers this account. Built the way upstream builds its Claude Code
 * provider, so the pickers, role settings and engines need nothing new.
 */

export const ACP_API = "acp";

const modelFor = (agent: AcpAgent, id: string, name: string): Model<Api> => ({
	id,
	name,
	api: ACP_API,
	provider: agent.provider,
	baseUrl: "",
	input: ["text", "image"],
	// Required placeholders, not prices: the agent's own account is billed. The catalog reports these models unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	// An agent has no thinking-off switch; low is the floor.
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

const streams = new Map<string, ReturnType<typeof createAcpStreamFunction>>();

export function createAcpProvider(agent: AcpAgent): Provider {
	// One stream function per agent for the life of the process: it owns the agents waiting on tool results.
	let stream = streams.get(agent.provider);
	if (!stream) streams.set(agent.provider, (stream = createAcpStreamFunction(agent)));
	return createProvider({
		id: agent.provider,
		name: agent.name,
		auth: { apiKey: { name: agent.name, resolve: async () => ({ auth: {}, source: "agent sign-in" }) } },
		models: acpModels(agent.provider).map((model) => modelFor(agent, model.id, model.name)),
		api: { stream, streamSimple: stream },
	});
}

const synced = new WeakMap<object, number>();

/** Keep a model collection's ACP providers current with what the agents last reported. Cheap when nothing changed. */
export function syncAcpProviders(models: MutableModels): void {
	const version = acpModelsVersion();
	if (synced.get(models) === version) return;
	synced.set(models, version);
	for (const agent of ACP_AGENTS) models.setProvider(createAcpProvider(agent));
}

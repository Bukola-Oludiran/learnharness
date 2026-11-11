/**
 * ACP agents as model providers (fork, phase 6a — see FORK.md). An agent
 * that speaks the Agent Client Protocol (Claude, Codex) teaches through
 * its own subscription login; LearnHarness is the client. These ids are
 * the provider half of a model pin (`acp-claude:sonnet`).
 */

export const ACP_CLAUDE_PROVIDER = "acp-claude";
export const ACP_CODEX_PROVIDER = "acp-codex";
export const ACP_PROVIDERS = [ACP_CLAUDE_PROVIDER, ACP_CODEX_PROVIDER] as const;
export type AcpProviderId = (typeof ACP_PROVIDERS)[number];

export const isAcpProvider = (provider: string): provider is AcpProviderId => (ACP_PROVIDERS as readonly string[]).includes(provider);

/** The provider of a `provider:model` pin, when it is an ACP agent. */
export const isAcpModel = (model: string): boolean => isAcpProvider(model.slice(0, Math.max(0, model.indexOf(":"))));

/** The name shown wherever a provider is named. */
export const ACP_PROVIDER_NAMES: Record<AcpProviderId, string> = { [ACP_CLAUDE_PROVIDER]: "Claude (ACP)", [ACP_CODEX_PROVIDER]: "Codex (ACP)" };

/** One model an agent offers, as it reports it. */
export interface AcpModelInfo {
	id: string;
	name: string;
}

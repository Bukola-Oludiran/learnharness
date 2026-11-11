import * as fs from "node:fs";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ACP_CLAUDE_PROVIDER, ACP_CODEX_PROVIDER, ACP_PROVIDER_NAMES, type AcpModelInfo, type AcpProviderId } from "../../core/contracts/acp.ts";
import { getClaudeBinary } from "../claude-code/binary.ts";

/**
 * The two ACP agents and what each needs to teach without touching anything
 * else (fork, phase 6a — see FORK.md). Everything here was established by
 * the spike of 2026-11-10 against claude-agent-acp 0.106.0 and codex-acp
 * 2.6.0: both adapters load the user's personal tools and settings unless
 * told not to, and each is told differently.
 */

/** A held tool call outlasts the 10-minute idle limit on a waiting agent, so the agent never gives up first. */
const TOOL_TIMEOUT_MS = 30 * 60_000;

/** Where the tool bridge listens, and the token it demands. */
export interface BridgeAddress {
	name: string;
	url: string;
	token: string;
}

export interface AcpAgent {
	provider: AcpProviderId;
	name: string;
	/** Shown until the agent has reported what this account offers. */
	seedModels: readonly AcpModelInfo[];
	/** The adapter's script, or null when it is not installed. */
	entry(): string | null;
	/** Installed, and its own sign-in or CLI is present. Never a promise that the account works. */
	available(): boolean;
	/** The environment for one run, and any private folders made for it (removed when the run ends). */
	prepare(base: NodeJS.ProcessEnv, bridge: BridgeAddress): Promise<{ env: NodeJS.ProcessEnv; dirs: string[] }>;
	/** How the agent learns of the tool bridge: on session/new (the protocol's way), or from its own config file written by `prepare`. */
	bridgeBy: "session" | "config";
	/** Sent as `_meta` on session/new. */
	sessionMeta?: Readonly<Record<string, unknown>>;
	/** The session mode to select, where the agent offers one by this id. */
	mode?: string;
	/** Put in front of the tutor's prompt (wording approved by the owner, 2026-11-10). */
	rule?: string;
}

/** Where the adapters are installed: beside the server in the app, `acp-agents/` in a checkout. */
export function acpAgentsDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
	return env.LH_ACP_AGENTS_DIR || path.join(cwd, "acp-agents");
}

const adapterEntry = (pkg: string) => () => {
	const entry = path.join(acpAgentsDir(), "node_modules", "@agentclientprotocol", pkg, "dist", "index.js");
	return fs.existsSync(entry) ? entry : null;
};

/** Markers of the session this server may itself have been started from; they are not the agent's to inherit. */
const HOST_SESSION_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

export const CLAUDE_AGENT: AcpAgent = {
	provider: ACP_CLAUDE_PROVIDER,
	name: ACP_PROVIDER_NAMES[ACP_CLAUDE_PROVIDER],
	seedModels: [
		{ id: "opus", name: "Claude Opus" },
		{ id: "sonnet", name: "Claude Sonnet" },
		{ id: "haiku", name: "Claude Haiku" },
	],
	entry: adapterEntry("claude-agent-acp"),
	available() {
		return this.entry() !== null && getClaudeBinary() !== null;
	},
	async prepare(base) {
		const env = { ...base };
		for (const name of HOST_SESSION_MARKERS) delete env[name];
		const binary = getClaudeBinary();
		return {
			env: {
				...env,
				// The adapter's own bundled CLI is not shipped; it runs the Claude Code already installed.
				...(binary ? { CLAUDE_CODE_EXECUTABLE: binary } : {}),
				MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS),
				CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(TOOL_TIMEOUT_MS),
				CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
			},
			dirs: [],
		};
	},
	bridgeBy: "session",
	// No built-in tools at all, and none of the user's settings, hooks, output style or MCP servers.
	sessionMeta: { claudeCode: { options: { tools: [], settingSources: [] } } },
};

/** Everything of Codex's own that acts on the machine or the web and has a switch. Its file-edit tool has none. */
const CODEX_FEATURES_OFF = [
	"apps", "plugins", "shell_tool", "unified_exec", "multi_agent", "view_image", "image_generation", "browser_use", "computer_use", "skill_search", "hooks", "in_app_browser",
	"tool_suggest", "goals", "sleep_tool",
];

const BRIDGE_TOKEN_ENV = "LH_ACP_BRIDGE_TOKEN";

/** Codex's config for one run. The bridge is declared here, not on session/new, because only here can its tool
 *  time limit be raised: Codex gives up on a tool call after five minutes otherwise (measured 2026-11-11), and a
 *  learner working a problem on paper takes longer. The token travels in the environment, not in the file. */
export function codexConfig(bridge: BridgeAddress): string {
	return `${[
		'web_search = "disabled"',
		"",
		"[features]",
		...CODEX_FEATURES_OFF.map((name) => `${name} = false`),
		"",
		`[mcp_servers.${bridge.name}]`,
		`url = ${JSON.stringify(bridge.url)}`,
		`bearer_token_env_var = "${BRIDGE_TOKEN_ENV}"`,
		`tool_timeout_sec = ${TOOL_TIMEOUT_MS / 1000}`,
	].join("\n")}\n`;
}

export const CODEX_RULE =
	"You are running inside the LearnHarness tutoring app, not a coding session. Here you have no file, shell, search or web tools. The only tools you may use are the learnharness tools. " +
	"Reach them however your environment exposes them, including through a tool catalog or an exec interface, and use that interface for nothing else. " +
	"If the learner asks for something those tools cannot do, say that you cannot do it here.";

/** The user's own Codex folder: where the sign-in lives. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export const CODEX_AGENT: AcpAgent = {
	provider: ACP_CODEX_PROVIDER,
	name: ACP_PROVIDER_NAMES[ACP_CODEX_PROVIDER],
	seedModels: [
		{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
		{ id: "gpt-6-astra", name: "GPT-6 Astra" },
		{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
	],
	entry: adapterEntry("codex-acp"),
	available() {
		return this.entry() !== null && fs.existsSync(path.join(codexHome(), "auth.json"));
	},
	async prepare(base, bridge) {
		// A private Codex home: the user's sign-in, and none of their config, MCP servers, skills or instructions.
		// The sign-in is linked, not copied, so a refreshed token is written back to the real file.
		const home = await mkdtemp(path.join(os.tmpdir(), "lh-codex-home-"));
		await symlink(path.join(codexHome(base), "auth.json"), path.join(home, "auth.json"));
		await writeFile(path.join(home, "config.toml"), codexConfig(bridge), { mode: 0o600 });
		return { env: { ...base, CODEX_HOME: home, [BRIDGE_TOKEN_ENV]: bridge.token }, dirs: [home] };
	},
	bridgeBy: "config",
	// File edits ask first, and the app refuses.
	mode: "read-only",
	rule: CODEX_RULE,
};

export const ACP_AGENTS: readonly AcpAgent[] = [CLAUDE_AGENT, CODEX_AGENT];

export const acpAgent = (provider: string): AcpAgent | undefined => ACP_AGENTS.find((agent) => agent.provider === provider);

/** Usable right now: the gate for the model menus and for starting a run. */
export const acpAvailable = (provider: string): boolean => acpAgent(provider)?.available() ?? false;

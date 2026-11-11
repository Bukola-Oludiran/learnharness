/**
 * ACP agents as model providers (fork, phase 6a — FORK.md). A scripted
 * agent (tests/fixtures/acp/fake-agent.mjs) speaks the wire over real
 * pipes and calls the tool bridge over real HTTP, so the stream function
 * runs end to end with no model: text, held tool calls and their
 * continuation, permissions, isolation settings, failures and abort.
 * Whether the real adapters behave is not tested here; that was the spike.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "lh-acp-test-"));
process.env.LH_DATA_DIR = join(scratch, "data");
after(() => rmSync(scratch, { recursive: true, force: true }));

import type { Api, AssistantMessage, AssistantMessageEvent, Message, Model, SimpleStreamOptions, StreamFunction, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

const { ACP_AGENTS, CLAUDE_AGENT, CODEX_AGENT, codexConfig, CODEX_RULE, acpAgentsDir } = await import("../src/agent/acp/agents.ts");
const { acpModels, rememberAcpModels, resetAcpModelsForTests } = await import("../src/agent/acp/model-list.ts");
const { createAcpStreamFunction, permissionOutcome, toPromptBlocks } = await import("../src/agent/acp/stream.ts");
const { createAcpProvider } = await import("../src/agent/acp/provider.ts");
const { ACP_MODELS_FILE } = await import("../config.ts");
const { isAcpModel, isAcpProvider } = await import("../src/core/contracts/acp.ts");
type AcpAgent = (typeof ACP_AGENTS)[number];

const FAKE = fileURLToPath(new URL("./fixtures/acp/fake-agent.mjs", import.meta.url));
const QUIZ: Tool = { name: "quiz", description: "Ask a question", parameters: { type: "object", properties: { q: { type: "string" } } } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };
const SESSION = "acp-test-chat";

let runs = 0;
/** An agent profile that starts the scripted agent. `base` supplies the real profile's settings under test. */
function fakeAgent(script: unknown[], extra: Record<string, string> = {}, base: AcpAgent = CLAUDE_AGENT) {
	const logFile = join(scratch, `log-${++runs}.jsonl`);
	writeFileSync(logFile, "");
	const agent: AcpAgent = {
		...base,
		entry: () => FAKE,
		available: () => true,
		prepare: async (env, bridge) => {
			const prepared = await base.prepare(env, bridge);
			return { env: { ...prepared.env, FAKE_SCRIPT: JSON.stringify(script), FAKE_LOG: logFile, ...extra }, dirs: prepared.dirs };
		},
	};
	const log = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown>; env?: Record<string, string>; tools?: string[] });
	return { agent, log, sent: (method: string) => log().filter((entry) => entry.method === method).map((entry) => entry.params!) };
}

const model = (id = "small"): Model<Api> => ({ ...createAcpProvider(CLAUDE_AGENT).getModels()[0]!, id });

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
async function turn(streamFn: StreamFunction<Api, SimpleStreamOptions>, messages: Message[], options: SimpleStreamOptions = {}, modelId = "small") {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [QUIZ] });
	const events = await collect(streamFn(model(modelId), context, { sessionId: SESSION, ...options }));
	const last = events.at(-1)!;
	const message = (last.type === "done" ? last.message : last.type === "error" ? last.error : null) as AssistantMessage;
	return { events, message, text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") };
}
const resultFor = (message: AssistantMessage, text: string): ToolResultMessage[] =>
	message.content.flatMap((block) => (block.type === "toolCall" ? [{ role: "toolResult" as const, toolCallId: block.id, toolName: block.name, content: [{ type: "text" as const, text }], isError: false, timestamp: 1 }] : []));

describe("an ACP agent's turn", () => {
	it("streams thinking and text as one assistant message, with usage, and opens the session as approved", async () => {
		const fake = fakeAgent([{ think: "hm" }, { say: "Hello " }, { say: "there." }]);
		const { events, message, text } = await turn(createAcpStreamFunction(fake.agent), [HI], { reasoning: "high" }, "big");
		assert.equal(message.stopReason, "stop");
		assert.equal(text, "Hello there.");
		assert.deepEqual(message.content.map((block) => block.type), ["thinking", "text"]);
		assert.deepEqual(events.map((event) => event.type), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		assert.deepEqual({ ...message.usage, cost: undefined }, { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, cost: undefined });
		assert.equal(message.provider, "acp-claude");

		const init = fake.sent("initialize")[0]!;
		assert.equal(init.protocolVersion, 1);
		assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, "no file or terminal access is declared");
		const created = fake.sent("session/new")[0] as { cwd: string; mcpServers: { type: string; name: string; url: string; headers: { name: string }[] }[]; systemPrompt: unknown; _meta: unknown };
		assert.deepEqual(created.systemPrompt, { mode: "override", content: [{ type: "text", text: "You are a tutor." }] });
		assert.deepEqual(created._meta, { claudeCode: { options: { tools: [], settingSources: [] } } }, "Claude: no tools of its own, none of the user's settings");
		assert.equal(created.mcpServers.length, 1, "the bridge is the only tool server");
		assert.equal(created.mcpServers[0]!.name, "learnharness");
		assert.match(created.mcpServers[0]!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		assert.deepEqual(created.mcpServers[0]!.headers.map((header) => header.name), ["Authorization"]);
		assert.deepEqual(fake.log().find((entry) => entry.tools)!.tools, ["quiz"]);
		// The model and effort the app chose; the mode is left alone for an agent that names none.
		assert.deepEqual(fake.sent("session/set_config_option").map((params) => [params.configId, params.value]), [["model", "big"], ["effort", "high"]]);
		assert.deepEqual(fake.sent("session/prompt")[0]!.prompt, [{ type: "text", text: "hi" }]);
		// An empty folder of its own, removed afterwards.
		assert.match(created.cwd, /lh-acp-cwd-/);
		await sleep(300);
		assert.equal(existsSync(created.cwd), false);
	});

	it("holds a tool call open, hands the app the call, and carries on in the same agent with the result", async () => {
		const fake = fakeAgent([{ say: "Let me ask. " }, { call: { name: "quiz", arguments: { q: "6 × 7?" } } }, { say: " Right." }]);
		const streamFn = createAcpStreamFunction(fake.agent);
		const first = await turn(streamFn, [HI]);
		assert.equal(first.message.stopReason, "toolUse");
		const calls = first.message.content.filter((block) => block.type === "toolCall");
		assert.equal(calls.length, 1);
		assert.deepEqual({ name: calls[0]!.name, arguments: calls[0]!.arguments }, { name: "quiz", arguments: { q: "6 × 7?" } });
		assert.equal(first.text, "Let me ask. ");
		// The learner takes a moment; the agent is still the same one afterwards.
		await sleep(200);
		const second = await turn(streamFn, [HI, first.message, ...resultFor(first.message, "42")]);
		assert.equal(second.message.stopReason, "stop");
		assert.equal(second.text, "[42] Right.");
		assert.equal(fake.sent("initialize").length, 1, "one agent served both halves");
		assert.equal(fake.sent("session/prompt").length, 1);
	});

	it("gathers tool calls made together into one batch", async () => {
		const fake = fakeAgent([{ calls: [{ name: "quiz", arguments: { q: "a" } }, { name: "quiz", arguments: { q: "b" } }] }]);
		const streamFn = createAcpStreamFunction(fake.agent);
		const first = await turn(streamFn, [HI]);
		const calls = first.message.content.filter((block) => block.type === "toolCall");
		assert.deepEqual(calls.map((call) => call.arguments), [{ q: "a" }, { q: "b" }]);
		assert.equal(new Set(calls.map((call) => call.id)).size, 2);
		const results = calls.map((call, index): ToolResultMessage => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `r${index}` }], isError: false, timestamp: 1 }));
		const second = await turn(streamFn, [HI, first.message, ...results]);
		assert.equal(second.text, "[r0|r1]");
	});

	it("starts a fresh agent and replays the transcript when the waiting one is gone or the history changed", async () => {
		const fake = fakeAgent([{ call: { name: "quiz", arguments: {} } }, { say: "done" }]);
		const streamFn = createAcpStreamFunction(fake.agent);
		const first = await turn(streamFn, [HI]);
		// The history is not the one the waiting agent saw: an edited first message.
		const edited: Message = { role: "user", content: "hello instead", timestamp: 0 };
		const second = await turn(streamFn, [edited, first.message, ...resultFor(first.message, "42")]);
		assert.equal(second.message.stopReason, "toolUse", "the fresh agent runs its script from the start");
		assert.equal(fake.sent("initialize").length, 2);
		const replay = (fake.sent("session/prompt")[1]!.prompt as { text: string }[])[0]!.text;
		assert.match(replay, /\[user\]\nhello instead[\s\S]*\[tool call quiz\] \{\}[\s\S]*\[tool result quiz\]\n42/);
		await turn(streamFn, [edited, first.message, ...resultFor(first.message, "42"), second.message, ...resultFor(second.message, "x")]);
	});

	it("allows a permission request for a bridge tool and refuses every other; file access does not exist", async () => {
		const fake = fakeAgent([
			{ permission: { title: "Edit files", kinds: ["allow_once", "allow_always", "reject_once"] } },
			{ permission: { title: "mcp.learnharness.quiz", kinds: ["allow_once", "allow_always", "reject_once"] } },
			{ permission: { title: "Run shell", kinds: ["allow_once"] } },
			{ fs: true },
		]);
		const { text } = await turn(createAcpStreamFunction(fake.agent), [HI]);
		assert.equal(text, '[permission {"outcome":"selected","optionId":"o-reject_once"}][permission {"outcome":"selected","optionId":"o-allow_once"}][permission {"outcome":"cancelled"}][fs -32601]');
		assert.deepEqual(permissionOutcome({ toolCall: { title: "mcp__learnharness__quiz" }, options: [{ optionId: "a", kind: "allow_always" }] }, undefined), { outcome: "selected", optionId: "a" });
		assert.deepEqual(permissionOutcome({ toolCall: {}, options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] }, undefined), { outcome: "selected", optionId: "r" }, "an unnamed request is refused");
		assert.deepEqual(permissionOutcome({ toolCall: { title: "mcp__other__quiz" }, options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_always" }] }, undefined), { outcome: "selected", optionId: "r" });
	});

	it("gives Codex a private home with only the sign-in, read-only mode, and the rule in front of an appended prompt", async () => {
		const realHome = join(scratch, "codex-real");
		rmSync(realHome, { recursive: true, force: true });
		mkdirSync(realHome, { recursive: true });
		writeFileSync(join(realHome, "auth.json"), '{"token":"t"}');
		writeFileSync(join(realHome, "config.toml"), 'model = "users-own"\n');
		const previous = process.env.CODEX_HOME;
		process.env.CODEX_HOME = realHome;
		try {
			assert.equal({ ...CODEX_AGENT, entry: () => FAKE }.available(), true);
			let seen: { home: string; link: string; config: string; token: string | undefined } | undefined;
			const fake = fakeAgent([{ wait: 50 }, { say: "ok" }], { FAKE_CAPS: JSON.stringify({ image: false, systemPrompt: {} }) }, CODEX_AGENT);
			const inner = fake.agent.prepare;
			fake.agent.prepare = async (env, bridge) => {
				const prepared = await inner(env, bridge);
				const home = prepared.env.CODEX_HOME!;
				seen = { home, link: lstatSync(join(home, "auth.json")).isSymbolicLink() ? readlinkSync(join(home, "auth.json")) : "", config: readFileSync(join(home, "config.toml"), "utf8"), token: prepared.env.LH_ACP_BRIDGE_TOKEN };
				return prepared;
			};
			const image: Message = { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 };
			const { text } = await turn(createAcpStreamFunction(fake.agent), [image]);
			assert.equal(text, "ok");
			assert.ok(seen);
			assert.notEqual(seen.home, realHome);
			assert.equal(seen.link, join(realHome, "auth.json"), "the sign-in is linked, so a refreshed token reaches the real file");
			assert.match(seen.config, /^web_search = "disabled"\n\n\[features\]\n(?:\w+ = false\n)+\n\[mcp_servers\.learnharness\]\nurl = "http:\/\/127\.0\.0\.1:\d+\/mcp"\nbearer_token_env_var = "LH_ACP_BRIDGE_TOKEN"\ntool_timeout_sec = 1800\n$/);
			for (const feature of ["shell_tool", "apps", "plugins", "browser_use", "computer_use", "image_generation"]) assert.match(seen.config, new RegExp(`^${feature} = false$`, "m"));
			assert.match(seen.token ?? "", /^[0-9a-f]{64}$/, "the bridge's token travels in the environment");
			assert.doesNotMatch(seen.config, new RegExp(seen.token!), "and is not written to the file");
			assert.doesNotMatch(codexConfig({ name: "learnharness", url: "http://127.0.0.1:1/mcp", token: "secret-token" }), /secret-token/);
			assert.doesNotMatch(seen.config, /users-own/, "none of the user's own configuration");
			const created = fake.sent("session/new")[0] as { systemPrompt: { mode: string; content: { text: string }[] }; _meta?: unknown; mcpServers: unknown[] };
			assert.deepEqual(created.mcpServers, [], "Codex is told of the bridge in its config, where the tool time limit can be raised");
			assert.equal(created.systemPrompt.mode, "append");
			assert.equal(created.systemPrompt.content[0]!.text, `${CODEX_RULE}\n\nYou are a tutor.`);
			assert.equal(created._meta, undefined);
			assert.deepEqual(fake.sent("session/set_config_option").map((params) => [params.configId, params.value]), [["mode", "read-only"]]);
			// It said it cannot read images, so it is told one was left out.
			assert.deepEqual(fake.sent("session/prompt")[0]!.prompt, [{ type: "text", text: "see" }, { type: "text", text: "[An image was attached here. This tutor cannot read images.]" }]);
			await sleep(300);
			assert.equal(existsSync(seen.home), false, "the private home is removed");
			assert.equal(readFileSync(join(realHome, "auth.json"), "utf8"), '{"token":"t"}', "the real sign-in is untouched");
		} finally {
			if (previous === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = previous;
		}
		assert.equal(
			CODEX_RULE,
			"You are running inside the LearnHarness tutoring app, not a coding session. Here you have no file, shell, search or web tools. The only tools you may use are the learnharness tools. Reach them however your environment exposes them, including through a tool catalog or an exec interface, and use that interface for nothing else. If the learner asks for something those tools cannot do, say that you cannot do it here.",
			"wording approved by the owner, 2026-11-10",
		);
	});

	it("puts the tutor's prompt first in the conversation for an agent that takes no system prompt", async () => {
		const fake = fakeAgent([{ say: "ok" }], { FAKE_CAPS: JSON.stringify({ image: true }) });
		await turn(createAcpStreamFunction(fake.agent), [HI]);
		assert.equal((fake.sent("session/new")[0] as { systemPrompt?: unknown }).systemPrompt, undefined);
		assert.deepEqual(fake.sent("session/prompt")[0]!.prompt, [{ type: "text", text: "You are a tutor." }, { type: "text", text: "hi" }]);
		assert.deepEqual(toPromptBlocks([{ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } }], true), [{ type: "image", data: "QQ==", mimeType: "image/png" }]);
	});

	it("passes the Claude agent the installed CLI and long tool timeouts, and not this server's own session markers", async () => {
		process.env.CLAUDECODE = "1";
		try {
			const prepared = await CLAUDE_AGENT.prepare({ ...process.env }, { name: "learnharness", url: "http://127.0.0.1:1/mcp", token: "t" });
			assert.equal(prepared.env.CLAUDECODE, undefined);
			assert.equal(prepared.env.MCP_TOOL_TIMEOUT, "1800000");
			assert.equal(prepared.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "1800000");
			assert.equal(prepared.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
			assert.deepEqual(prepared.dirs, []);
		} finally {
			delete process.env.CLAUDECODE;
		}
	});

	it("reports failures in words: a model the account lacks, a wrong protocol, a crash, a refusal, nothing installed", async () => {
		const failed = async (script: unknown[], extra: Record<string, string> = {}, modelId = "small") => {
			const { message } = await turn(createAcpStreamFunction(fakeAgent(script, extra).agent), [HI], {}, modelId);
			assert.equal(message.stopReason, "error");
			return message.errorMessage;
		};
		assert.equal(await failed([{ say: "x" }], {}, "huge"), 'Claude (ACP) does not offer the model "huge" on this account. Choose another model.');
		assert.equal(await failed([], { FAKE_PROTOCOL: "2" }), "Claude (ACP) speaks protocol version 2; LearnHarness speaks version 1.");
		assert.equal(await failed([{ say: "part" }, { exit: 3 }]), "Claude (ACP) stopped unexpectedly (exit code 3).");
		assert.equal(await failed([{ stop: "refusal" }]), "Claude (ACP) declined to answer.");
		assert.equal(await failed([{ raw: "not json" }, { wait: 500 }]), "Claude (ACP) sent something that is not a protocol message.");
		const missing = await turn(createAcpStreamFunction({ ...CLAUDE_AGENT, entry: () => null }), [HI]);
		assert.equal(missing.message.errorMessage, "Claude (ACP) is not installed in this copy of LearnHarness.");
		const length = await turn(createAcpStreamFunction(fakeAgent([{ say: "long" }, { stop: "max_tokens" }]).agent), [HI]);
		assert.equal(length.message.stopReason, "length");
	});

	it("aborts: the agent is told to cancel and is stopped, mid-text or while a tool call waits", async () => {
		const fake = fakeAgent([{ say: "thinking…" }, { wait: 5000 }, { say: "never" }]);
		const controller = new AbortController();
		const pending = turn(createAcpStreamFunction(fake.agent), [HI], { signal: controller.signal });
		await sleep(700);
		controller.abort();
		const { message } = await pending;
		assert.equal(message.stopReason, "aborted");
		assert.equal(message.errorMessage, "Request was aborted");
		await sleep(600);
		assert.deepEqual(fake.sent("session/cancel"), [{ sessionId: "fake-session" }]);
		const already = new AbortController();
		already.abort();
		const before = await turn(createAcpStreamFunction(fakeAgent([{ say: "x" }]).agent), [HI], { signal: already.signal });
		assert.equal(before.message.stopReason, "aborted");
	});
});

describe("the agents' model lists and registry entries", () => {
	it("starts from a short list, remembers what an agent reports, and survives a restart", () => {
		resetAcpModelsForTests();
		rmSync(ACP_MODELS_FILE, { force: true });
		assert.deepEqual(acpModels("acp-claude").map((entry) => entry.id), ["opus", "sonnet", "haiku"]);
		assert.deepEqual(acpModels("acp-codex").map((entry) => entry.id), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra"]);
		assert.equal(rememberAcpModels("acp-codex", [{ id: "gpt-9", name: "GPT 9" }, { id: "bad id with spaces" }, { id: "gpt-9-mini" }]), true);
		assert.deepEqual(acpModels("acp-codex"), [{ id: "gpt-9", name: "GPT 9" }, { id: "gpt-9-mini", name: "gpt-9-mini" }]);
		assert.equal(rememberAcpModels("acp-codex", [{ id: "gpt-9", name: "GPT 9" }, { id: "gpt-9-mini" }]), false, "the same list again changes nothing");
		assert.equal(rememberAcpModels("acp-codex", []), false, "an empty report does not wipe the list");
		assert.equal(rememberAcpModels("openai", [{ id: "x" }]), false);
		resetAcpModelsForTests();
		assert.deepEqual(acpModels("acp-codex").map((entry) => entry.id), ["gpt-9", "gpt-9-mini"], "read back from the cache file");
		assert.deepEqual(createAcpProvider(CODEX_AGENT).getModels().map((entry) => `${entry.provider}:${entry.id}`), ["acp-codex:gpt-9", "acp-codex:gpt-9-mini"]);
		resetAcpModelsForTests();
		rmSync(ACP_MODELS_FILE, { force: true });
	});

	it("registers both agents with the app's models, unpriced, and lists them only when usable", async () => {
		const { piModels } = await import("../src/agent/models.ts");
		const { toModelDto, catalogProviders } = await import("../src/server/model-catalog.ts");
		const { providerKeyPresent } = await import("../src/server/keys.ts");
		const sonnet = piModels().getModel("acp-claude", "sonnet")!;
		assert.equal(sonnet.name, "Claude Sonnet");
		assert.deepEqual(sonnet.input, ["text", "image"]);
		const dto = toModelDto(sonnet);
		assert.equal(dto.cost, null, "billed by the agent's own account: never a dollar figure");
		assert.equal(dto.contextWindow, null);
		assert.ok(piModels().getModel("acp-codex", "gpt-6.1-sol"));
		// A list the agent reports later reaches the registry without a restart.
		rememberAcpModels("acp-claude", [{ id: "sonnet", name: "Sonnet 5.5" }, { id: "fable", name: "Fable" }]);
		assert.equal(piModels().getModel("acp-claude", "fable")!.name, "Fable");
		assert.equal(piModels().getModel("acp-claude", "opus"), undefined);
		resetAcpModelsForTests();
		rmSync(ACP_MODELS_FILE, { force: true });

		const previous = process.env.LH_ACP_AGENTS_DIR;
		process.env.LH_ACP_AGENTS_DIR = join(scratch, "no-agents-here");
		try {
			assert.equal(acpAgentsDir(), join(scratch, "no-agents-here"));
			assert.equal(CLAUDE_AGENT.entry(), null);
			assert.equal(CLAUDE_AGENT.available(), false);
			assert.equal(providerKeyPresent("acp-claude"), false);
			assert.equal(providerKeyPresent("acp-codex"), false);
			assert.deepEqual(catalogProviders().filter((provider) => isAcpProvider(provider.id)), [{ id: "acp-claude", envVar: "", keyPresent: false }, { id: "acp-codex", envVar: "", keyPresent: false }]);
		} finally {
			if (previous === undefined) delete process.env.LH_ACP_AGENTS_DIR;
			else process.env.LH_ACP_AGENTS_DIR = previous;
		}
		assert.equal(isAcpModel("acp-codex:gpt-6.1-sol"), true);
		assert.equal(isAcpModel("claude-code:sonnet"), false);
		assert.equal(isAcpModel("sonnet"), false);
		const { sendToUserApplies } = await import("../src/agent/tools/send-to-user.ts");
		assert.equal(sendToUserApplies("teacher", { provider: "acp-claude", id: "sonnet" }, false), true, "Claude is Claude through either door");
		assert.equal(sendToUserApplies("teacher", { provider: "acp-codex", id: "gpt-6.1-sol" }, false), false);
	});
});

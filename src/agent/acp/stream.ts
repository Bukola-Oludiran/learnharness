import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import packageMetadata from "../../../package.json" with { type: "json" };
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { toClaudeInput, type ClaudeContentBlock } from "../claude-code/transcript.ts";
import type { AcpAgent } from "./agents.ts";
import { rememberAcpModels } from "./model-list.ts";
import { ACP_BRIDGE_NAME, createAcpToolBridge, type AcpToolBridge, type BridgeCall } from "./tool-bridge.ts";
import { createAcpWire, type AcpWire } from "./wire.ts";

/**
 * One model turn through an ACP agent (fork, phase 6a — see FORK.md).
 *
 * The agent is used as upstream's Claude Code provider uses the CLI: as a
 * model, not as the one in charge. LearnHarness keeps its agent loop. The
 * agent is started in an empty folder with one tool server (the bridge),
 * the tutor's prompt, and the saved transcript replayed as labelled text
 * and images. Its text streams out as an assistant message. When it calls
 * a LearnHarness tool the call waits at the bridge: this stream ends with
 * that tool call, the app runs the tool, and the next stream call hands
 * the result back to the SAME waiting agent, which carries on. A question
 * to the learner therefore holds the agent open until they answer (up to
 * the idle limit, after which the answer starts a fresh agent and the
 * transcript is replayed).
 *
 * The agent has no other way to act: no file or terminal capability is
 * declared, and a permission request for anything but a bridge tool is
 * refused. What each agent additionally needs is in agents.ts.
 */

const PROTOCOL_VERSION = 1;
/** How long to wait for further tool calls made in the same breath before handing the batch to the app. */
const BATCH_WINDOW_MS = 120;
const ABORT_MESSAGE = "Request was aborted";
const CANCEL_GRACE_MS = 300;

/** Start an adapter script as a child process. Injected in tests. */
export type SpawnAgent = (entry: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

const spawnWithOwnRuntime: SpawnAgent = (entry, { cwd, env }) =>
	// The app's own binary is its Node: in the desktop app that is Electron, told to behave as Node.
	spawn(process.execPath, [entry], { cwd, env: { ...env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, stdio: "pipe" });

const EFFORTS: Record<ThinkingLevel, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

const STOP_REASONS: Record<string, StopReason> = { end_turn: "stop", max_tokens: "length", max_turn_requests: "length" };

interface ConfigOption {
	id: string;
	category?: string;
	currentValue?: string;
	options?: { value: string; name?: string }[];
}
interface NewSession {
	sessionId: string;
	configOptions?: ConfigOption[];
	models?: { availableModels?: { modelId: string; name?: string }[] };
}
interface Initialized {
	protocolVersion: number;
	agentCapabilities?: { promptCapabilities?: { image?: boolean }; sessionCapabilities?: { systemPrompt?: { mode?: { override?: unknown } } | null } };
}
interface PromptResult {
	stopReason?: string;
	usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number } | null;
}
interface SessionUpdate {
	sessionUpdate?: string;
	content?: { type?: string; text?: string };
	toolCallId?: string;
	title?: string | null;
}
interface PermissionRequest {
	toolCall?: { toolCallId?: string; title?: string | null };
	options?: { optionId: string; kind?: string }[];
}

/** One assistant message under construction, and the stream it is told on. */
class AcpTurn {
	private readonly output: AssistantMessage;
	private open: "text" | "thinking" | null = null;
	started = false;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	get message(): AssistantMessage {
		return this.output;
	}

	/** A piece of what the agent says, or of its thinking. */
	chunk(kind: "text" | "thinking", delta: string): void {
		if (this.finished || !delta) return;
		this.start();
		if (this.open !== kind) {
			this.closeBlock();
			this.open = kind;
			this.output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			this.stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: this.output.content.length - 1, partial: this.output });
		}
		const contentIndex = this.output.content.length - 1;
		const block = this.output.content[contentIndex]!;
		if (block.type === "text") {
			block.text += delta;
			this.stream.push({ type: "text_delta", contentIndex, delta, partial: this.output });
		} else if (block.type === "thinking") {
			block.thinking += delta;
			this.stream.push({ type: "thinking_delta", contentIndex, delta, partial: this.output });
		}
	}

	setUsage(usage: PromptResult["usage"]): void {
		if (!usage) return;
		const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
		Object.assign(this.output.usage, { input: count(usage.inputTokens), output: count(usage.outputTokens), cacheRead: count(usage.cachedReadTokens), cacheWrite: count(usage.cachedWriteTokens) });
		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	/** The message ends with these tool calls: the app runs them next. */
	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeBlock();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.end("toolUse");
	}

	end(reason: Extract<StopReason, "stop" | "length" | "toolUse">): void {
		if (this.finished) return;
		this.start();
		this.closeBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.output });
		this.stream.end();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeBlock(): void {
		if (this.open === null) return;
		const contentIndex = this.output.content.length - 1;
		const block = this.output.content[contentIndex]!;
		if (block.type === "text") this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
		else if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
		this.open = null;
	}
}

/** The agent's name for a bridge tool: mcp__learnharness__quiz (Claude), mcp.learnharness.quiz (Codex). */
const BRIDGE_TOOL_TITLE = new RegExp(`^mcp(__|\\.)${ACP_BRIDGE_NAME}(__|\\.)`);

/** Which of the offered answers to a permission request to give. Pure — exported for tests. */
export function permissionOutcome(request: PermissionRequest, knownTitle: string | undefined): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
	const title = request.toolCall?.title ?? knownTitle ?? "";
	const wanted = BRIDGE_TOOL_TITLE.test(title) ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
	for (const kind of wanted) {
		const option = request.options?.find((candidate) => candidate.kind === kind);
		if (option) return { outcome: "selected", optionId: option.optionId };
	}
	// Nothing fitting was offered: decline to choose, which the agent treats as a refusal.
	return { outcome: "cancelled" };
}

/** The transcript as ACP prompt blocks. An agent that cannot read images is told one was left out. Pure — exported for tests. */
export function toPromptBlocks(content: readonly ClaudeContentBlock[], images: boolean): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
	return content.map((block) =>
		block.type === "text"
			? { type: "text" as const, text: block.text }
			: images
				? { type: "image" as const, data: block.source.data, mimeType: block.source.media_type }
				: { type: "text" as const, text: "[An image was attached here. This tutor cannot read images.]" },
	);
}

class AcpProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private readonly wire: AcpWire;
	private stderr = "";
	private stopping = false;
	private closed = false;
	private signal: AbortSignal | undefined;
	private killTimer: NodeJS.Timeout | undefined;
	private batchTimer: NodeJS.Timeout | undefined;
	private acpSessionId: string | undefined;
	private admitted: BridgeCall[] = [];
	/** Updates that arrived while no message was open (between a tool batch and its results). */
	private backlog: SessionUpdate[] = [];
	/** What the agent calls each tool call, for judging permission requests. */
	private readonly titles = new Map<string, string>();

	constructor(
		private readonly agent: AcpAgent,
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: AcpToolBridge,
		private readonly dirs: string[],
		private turn: AcpTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {
		this.wire = createAcpWire(
			child,
			{
				"session/update": (params) => this.onUpdate((params as { update?: SessionUpdate }).update ?? {}),
				"session/request_permission": (params) => {
					const request = params as PermissionRequest;
					return { outcome: permissionOutcome(request, this.titles.get(request.toolCall?.toolCallId ?? "")) };
				},
				// fs/* and terminal/* have no handler: the agent is told those methods do not exist.
			},
			() => this.fail(`${agent.name} sent something that is not a protocol message.`),
		);
		child.once("close", (code) => this.handleClose(`${agent.name} stopped unexpectedly (exit code ${code}).`));
		child.once("error", (error) => {
			console.error(`${agent.name} could not be started:`, error);
			this.handleClose(`${agent.name} could not be started.`);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-16_384);
		});
	}

	/** Agree the protocol, open a session with the bridge and the tutor's prompt, set the model, and send the transcript. */
	async run(cwd: string, systemPrompt: string, content: readonly ClaudeContentBlock[], model: Model<Api>, reasoning: ThinkingLevel | undefined, signal: AbortSignal | undefined): Promise<void> {
		this.setSignal(signal);
		if (this.stopping) return;
		const init = await this.wire.request<Initialized>("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "learnharness", version: packageMetadata.version },
		});
		if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`${this.agent.name} speaks protocol version ${init.protocolVersion}; LearnHarness speaks version ${PROTOCOL_VERSION}.`);
		const promptSupport = init.agentCapabilities?.sessionCapabilities?.systemPrompt;
		// Replace the agent's own instructions where it allows that; add to them where it only allows that.
		const promptMode = promptSupport == null ? null : promptSupport.mode?.override !== undefined ? "override" : "append";
		const tutorPrompt = [this.agent.rule, systemPrompt].filter((part) => part).join("\n\n");

		const session = await this.wire.request<NewSession>("session/new", {
			cwd,
			mcpServers: this.agent.bridgeBy === "session" ? [this.bridge.server] : [],
			...(promptMode && tutorPrompt ? { systemPrompt: { mode: promptMode, content: [{ type: "text", text: tutorPrompt }] } } : {}),
			...(this.agent.sessionMeta ? { _meta: this.agent.sessionMeta } : {}),
		});
		this.acpSessionId = session.sessionId;
		const options = session.configOptions ?? [];
		const option = (category: string) => options.find((candidate) => candidate.category === category);
		const choose = async (category: string, value: string | undefined, required: boolean) => {
			const target = option(category);
			if (!target || value === undefined) return;
			if (!target.options?.some((candidate) => candidate.value === value)) {
				if (required) throw new Error(`${this.agent.name} does not offer the model "${value}" on this account. Choose another model.`);
				return;
			}
			if (target.currentValue !== value) await this.wire.request("session/set_config_option", { sessionId: session.sessionId, configId: target.id, value });
		};
		const models = option("model")?.options?.map((entry) => ({ id: entry.value, name: entry.name ?? entry.value }));
		// What this account offers, for the model menus.
		rememberAcpModels(this.agent.provider, models ?? [...new Set((session.models?.availableModels ?? []).map((entry) => entry.modelId.replace(/\[.*$/, "")))].map((id) => ({ id, name: id })));
		await choose("mode", this.agent.mode, false);
		await choose("model", model.id, true);
		await choose("thought_level", reasoning ? EFFORTS[reasoning] : undefined, false);
		if (this.stopping) return;

		const blocks = toPromptBlocks(content, init.agentCapabilities?.promptCapabilities?.image === true);
		// An agent that takes no system prompt reads the tutor's prompt first in the conversation.
		const prompt = promptMode === null && tutorPrompt ? [{ type: "text" as const, text: tutorPrompt }, ...blocks] : blocks;
		const result = await this.wire.request<PromptResult>("session/prompt", { sessionId: session.sessionId, prompt });
		this.onPromptDone(result);
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return (
			!this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name))
		);
	}

	/** The app ran the tools: hand each result to its waiting call and tell the rest of the agent's turn on a new message. */
	continueTurn(turn: AcpTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) this.bridge.resolve(call, results.find((result) => result.toolCallId === call.id)!);
		const backlog = this.backlog;
		this.backlog = [];
		for (const update of backlog) this.onUpdate(update);
		// A call made while the last batch was out is already waiting.
		this.scheduleBatch();
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		clearTimeout(this.batchTimer);
		this.wire.close(`${this.agent.name} was stopped.`);
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		this.turn.fail(message, "error");
		this.kill();
	}

	/** A tool call reached the bridge. Others made in the same breath are gathered before the app is handed the batch. */
	scheduleBatch(): void {
		if (this.stopping || this.batchTimer || this.bridge.pending().length === 0) return;
		this.batchTimer = setTimeout(() => {
			this.batchTimer = undefined;
			this.admitBatch();
		}, BATCH_WINDOW_MS);
	}

	/** The agent gave up on a call (its own time limit, usually). If the app already has that call, this agent can never
	 *  receive the result: stop it, and the result will start a fresh one. */
	onCallCancelled(call: BridgeCall): void {
		if (this.admitted.some((candidate) => candidate.id === call.id)) this.kill();
	}

	private admitBatch(): void {
		if (this.stopping || this.turn.finished) return;
		const pending = this.bridge.pending();
		if (pending.length === 0) return;
		this.admitted = pending;
		this.toolCallIds = pending.map((call) => call.id);
		this.turn.admit(pending.map((call): ToolCall => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })));
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.message])));
		// With a session to return to, wait for the results; without one, the next call replays the transcript.
		if (this.sessionId) addLiveProcess(this);
		else this.kill();
	}

	private onUpdate(update: SessionUpdate): void {
		if (this.stopping) return;
		if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.toolCallId && typeof update.title === "string") {
			this.titles.set(update.toolCallId, update.title);
			return;
		}
		if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return;
		if (update.content?.type !== "text" || typeof update.content.text !== "string") return;
		if (this.turn.finished) {
			this.backlog.push(update);
			return;
		}
		this.turn.chunk(update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", update.content.text);
	}

	private onPromptDone(result: PromptResult): void {
		if (this.stopping) return;
		if (this.turn.finished) {
			// The agent ended its turn while its tool calls were still out. Their results will start a fresh agent.
			this.kill();
			return;
		}
		this.turn.setUsage(result.usage);
		const reason = STOP_REASONS[result.stopReason ?? ""];
		if (result.stopReason === "cancelled") this.turn.fail(ABORT_MESSAGE, "aborted");
		else if (result.stopReason === "refusal") this.turn.fail(`${this.agent.name} declined to answer.`, "error");
		else if (reason === "stop" || reason === "length") this.turn.end(reason);
		else this.turn.fail(`${this.agent.name} ended its turn without saying why.`, "error");
		this.kill();
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		removeLiveProcess(this);
		if (!this.acpSessionId || this.stopping) return this.kill();
		// Ask first, so the agent can drop its own request cleanly; then stop it whatever it did.
		this.wire.notify("session/cancel", { sessionId: this.acpSessionId });
		setTimeout(() => this.kill(), CANCEL_GRACE_MS).unref();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		clearTimeout(this.batchTimer);
		removeLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		this.wire.close(message);
		if (!this.turn.finished && this.stderr.trim()) console.error(`${this.agent.name} stderr:`, this.stderr.trim());
		this.turn.fail(message, "error");
		Promise.all([this.bridge.close(), ...this.dirs.map((dir) => rm(dir, { recursive: true, force: true }))]).catch((error: unknown) => {
			console.error(`${this.agent.name} cleanup failed:`, error);
		});
	}
}

function continueLiveProcess(turn: AcpTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
	const live = getLiveProcess(ids, owner, sessionId);
	if (!(live instanceof AcpProcess)) return false;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !live.canContinue(owner, sessionId, configuration, messages, results)) {
		live.kill();
		return false;
	}
	live.continueTurn(turn, messages, results, signal);
	return true;
}

async function startProcess(agent: AcpAgent, spawnAgent: SpawnAgent, turn: AcpTurn, model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, owner: symbol, configuration: unknown): Promise<void> {
	if (options?.signal?.aborted) return turn.fail(ABORT_MESSAGE, "aborted");
	const entry = agent.entry();
	if (!entry) return turn.fail(`${agent.name} is not installed in this copy of LearnHarness.`, "error");
	const input = toClaudeInput(context.messages);
	let live: AcpProcess | undefined;
	const bridge = await createAcpToolBridge(input.tools, { onCall: () => live?.scheduleBatch(), onCancel: (call) => live?.onCallCancelled(call) });
	const dirs: string[] = [];
	try {
		// An empty folder: nothing of the user's is in reach even if the agent looks.
		const cwd = await mkdtemp(join(tmpdir(), "lh-acp-cwd-"));
		dirs.push(cwd);
		const prepared = await agent.prepare(externalCliEnv(), bridge.address);
		dirs.push(...prepared.dirs);
		if (options?.signal?.aborted) throw new Error(ABORT_MESSAGE);
		const child = spawnAgent(entry, { cwd, env: prepared.env });
		live = new AcpProcess(agent, child, bridge, dirs, turn, owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
		const running = live;
		running.run(cwd, input.systemPrompt, input.userContent, model, options?.reasoning, options?.signal).catch((error: unknown) => {
			running.fail(error instanceof Error && error.message ? error.message : `${agent.name} failed.`);
		});
	} catch (error) {
		if (!live) await Promise.all([bridge.close(), ...dirs.map((dir) => rm(dir, { recursive: true, force: true }))]);
		throw error;
	}
}

/** The stream function for one agent. `spawnAgent` is replaced in tests by a scripted agent. */
export function createAcpStreamFunction(agent: AcpAgent, spawnAgent: SpawnAgent = spawnWithOwnRuntime): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol(`${agent.provider} stream owner`);
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AcpTurn(stream, model);
		const configuration = { request: configurationForReuse(model, context, options?.reasoning ? EFFORTS[options.reasoning] : "default"), agent: agent.provider };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;
		startProcess(agent, spawnAgent, turn, model, context, options, owner, configuration).catch((error: unknown) => {
			const aborted = options?.signal?.aborted === true;
			if (!aborted) console.error(`${agent.name} turn failed:`, error);
			turn.fail(aborted ? ABORT_MESSAGE : error instanceof Error && error.message ? error.message : `${agent.name} could not be started.`, aborted ? "aborted" : "error");
		});
		return stream;
	};
}

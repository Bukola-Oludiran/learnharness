// A scripted ACP agent for tests (fork, phase 6a). It speaks the wire for
// real over stdio and calls the tool bridge for real over HTTP; what it
// "decides" comes from FAKE_SCRIPT, a JSON list of steps run by each prompt:
//   { say } { think } { call: { name, arguments } } { calls: [...] }
//   { permission: { title, kinds } } { fs: true } { exit: code } { wait: ms } { raw: line }
// Everything the client sent is appended to FAKE_LOG, one JSON line each.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const script = JSON.parse(process.env.FAKE_SCRIPT ?? "[]");
const caps = JSON.parse(process.env.FAKE_CAPS ?? '{"image":true,"systemPrompt":{"mode":{"override":{}}}}');
const options = JSON.parse(process.env.FAKE_OPTIONS ?? "null") ?? [
	{ id: "mode", category: "mode", currentValue: "agent", options: [{ value: "agent" }, { value: "read-only" }] },
	{ id: "model", category: "model", currentValue: "small", options: [{ value: "small", name: "Small" }, { value: "big", name: "Big" }] },
	{ id: "effort", category: "thought_level", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
];
const log = (entry) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

let bridge;
let cancelled = false;
let callCount = 0;
async function callTool(sessionId, { name, arguments: args }) {
	const toolCallId = `t${++callCount}`;
	update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `mcp__learnharness__${name}`, kind: "other", status: "pending" });
	const result = await bridge.callTool({ name, arguments: args ?? {} }, undefined, { timeout: 60_000 });
	return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("");
}

async function runPrompt(sessionId) {
	for (const step of script) {
		if (cancelled) return "cancelled";
		if (step.say !== undefined) say(sessionId, step.say);
		else if (step.think !== undefined) update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.think } });
		else if (step.call) say(sessionId, `[${await callTool(sessionId, step.call)}]`);
		else if (step.calls) say(sessionId, `[${(await Promise.all(step.calls.map((call) => callTool(sessionId, call)))).join("|")}]`);
		else if (step.permission) {
			const toolCallId = `p${++callCount}`;
			if (step.permission.announce !== false) update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: step.permission.title, kind: "edit", status: "pending" });
			const answer = await ask("session/request_permission", { sessionId, toolCall: { toolCallId }, options: step.permission.kinds.map((kind) => ({ optionId: `o-${kind}`, name: kind, kind })) });
			say(sessionId, `[permission ${JSON.stringify(answer.result?.outcome ?? answer.error)}]`);
		} else if (step.fs) {
			const answer = await ask("fs/read_text_file", { sessionId, path: "/etc/hosts" });
			say(sessionId, `[fs ${answer.error?.code ?? "allowed"}]`);
		} else if (step.exit !== undefined) process.exit(step.exit);
		else if (step.wait !== undefined) await new Promise((resolve) => setTimeout(resolve, step.wait));
		else if (step.raw !== undefined) process.stdout.write(`${step.raw}\n`);
		else if (step.stop !== undefined) return step.stop;
	}
	return cancelled ? "cancelled" : "end_turn";
}

createInterface({ input: process.stdin }).on("line", async (line) => {
	const message = JSON.parse(line);
	if (message.method === undefined) {
		waiting.get(message.id)?.(message);
		waiting.delete(message.id);
		return;
	}
	log({ method: message.method, params: message.params, env: message.method === "initialize" ? { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE, MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT, CLAUDECODE: process.env.CLAUDECODE, cwd: process.cwd() } : undefined });
	switch (message.method) {
		case "initialize":
			return send({ id: message.id, result: { protocolVersion: Number(process.env.FAKE_PROTOCOL ?? 1), agentCapabilities: { promptCapabilities: { image: caps.image }, sessionCapabilities: caps.systemPrompt === undefined ? {} : { systemPrompt: caps.systemPrompt } } } });
		case "session/new": {
			const server = message.params.mcpServers[0];
			// An agent told of the bridge through its own config gets none here.
			if (server) {
				bridge = new Client({ name: "fake-agent", version: "0" });
				await bridge.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) } }));
				log({ tools: (await bridge.listTools()).tools.map((tool) => tool.name) });
			}
			return send({ id: message.id, result: { sessionId: "fake-session", configOptions: options } });
		}
		case "session/set_config_option":
			return send({ id: message.id, result: { configOptions: options } });
		case "session/prompt": {
			const stopReason = await runPrompt(message.params.sessionId);
			return send({ id: message.id, result: { stopReason, usage: { inputTokens: 11, outputTokens: 7, cachedReadTokens: 3 } } });
		}
		case "session/cancel":
			cancelled = true;
			return;
		default:
			if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
	}
});

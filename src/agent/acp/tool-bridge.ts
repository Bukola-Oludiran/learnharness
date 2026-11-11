import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { ImageContent, JsonObject, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The tool bridge an ACP agent is handed (fork, phase 6a — see FORK.md):
 * LearnHarness's own tools as one MCP server on a loopback port, behind a
 * random bearer token. It is the only tool server the agent is given.
 *
 * A call does not run here. It waits in this queue until the app's agent
 * loop has run the tool and hands back the result, which is how a question
 * to the learner holds the agent's turn open.
 *
 * Modelled on upstream's Claude Code bridge (agent/claude-code/
 * tool-bridge.ts), which stays unedited. That one admits a call only when
 * it matches the CLI's own streamed intent, by an id the CLI supplies; an
 * ACP agent supplies no such id, so calls are identified here.
 */

export const ACP_BRIDGE_NAME = "learnharness";

const LOOPBACK_HOST = "127.0.0.1";

export interface BridgeCall {
	id: string;
	name: string;
	arguments: JsonObject;
}

export interface AcpToolBridge {
	/** Where it listens and the token it demands, for an agent that is told through its own config. */
	address: { name: string; url: string; token: string };
	/** The server as an ACP `mcpServers` entry. */
	server: { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };
	/** Calls waiting for a result, oldest first. */
	pending(): BridgeCall[];
	resolve(call: BridgeCall, result: ToolResultMessage): void;
	close(): Promise<void>;
}

interface BridgeCallbacks {
	/** A call arrived and is waiting. */
	onCall(): void;
	/** The agent gave up on a call before it was answered. */
	onCancel(call: BridgeCall): void;
}

const toMcpContent = (block: TextContent | ImageContent): CallToolResult["content"][number] =>
	block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType };

export async function createAcpToolBridge(tools: readonly Tool[], callbacks: BridgeCallbacks): Promise<AcpToolBridge> {
	const token = randomBytes(32).toString("hex");
	const authorization = `Bearer ${token}`;
	const expected = Buffer.from(authorization);
	const waiting = new Map<BridgeCall, (result: CallToolResult) => void>();

	// The low-level Server: the tools carry JSON Schema that must reach the agent unchanged.
	const mcp = new Server({ name: ACP_BRIDGE_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
	mcp.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool): McpTool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as McpTool["inputSchema"] })),
	}));
	mcp.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		if (!tools.some((tool) => tool.name === request.params.name)) throw new McpError(ErrorCode.InvalidParams, `LearnHarness has no tool named ${request.params.name}`);
		const call: BridgeCall = { id: `acp_${randomUUID()}`, name: request.params.name, arguments: (request.params.arguments ?? {}) as JsonObject };
		const result = new Promise<CallToolResult>((resolve) => {
			const cancel = () => {
				if (!waiting.has(call)) return;
				waiting.delete(call);
				resolve({ content: [{ type: "text", text: "The request was cancelled." }], isError: true });
				callbacks.onCancel(call);
			};
			waiting.set(call, (value) => {
				waiting.delete(call);
				extra.signal.removeEventListener("abort", cancel);
				resolve(value);
			});
			extra.signal.addEventListener("abort", cancel, { once: true });
			if (extra.signal.aborted) cancel();
		});
		callbacks.onCall();
		return result;
	});

	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
	await mcp.connect(transport);
	const httpServer = http.createServer((req, res) => {
		const header = req.headers.authorization;
		const actual = header === undefined ? null : Buffer.from(header);
		if (!actual || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			res.writeHead(401).end();
			return;
		}
		transport.handleRequest(req, res).catch((error: unknown) => {
			console.error("ACP tool bridge request failed", error);
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	let port: number;
	try {
		port = await new Promise<number>((resolve, reject) => {
			httpServer.once("error", reject);
			httpServer.listen(0, LOOPBACK_HOST, () => resolve((httpServer.address() as AddressInfo).port));
		});
	} catch (error) {
		await mcp.close();
		throw error;
	}

	const url = `http://${LOOPBACK_HOST}:${port}/mcp`;
	return {
		address: { name: ACP_BRIDGE_NAME, url, token },
		server: { type: "http", name: ACP_BRIDGE_NAME, url, headers: [{ name: "Authorization", value: authorization }] },
		pending: () => [...waiting.keys()],
		resolve: (call, result) => waiting.get(call)?.({ content: result.content.map(toMcpContent), isError: result.isError }),
		close: async () => {
			for (const settle of [...waiting.values()]) settle({ content: [{ type: "text", text: "The tool bridge closed." }], isError: true });
			await mcp.close();
			httpServer.closeAllConnections();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * The ACP wire (fork, phase 6a — see FORK.md): JSON-RPC 2.0, one message
 * per line, over an agent's stdin and stdout. Kept apart from everything
 * that knows what the messages mean, so a later protocol version changes
 * this file's callers, not the transport.
 */

export class AcpRequestError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: unknown,
	) {
		super(message);
	}
}

type Handler = (params: unknown) => unknown;

export interface AcpWire {
	/** Call a method on the agent and wait for its answer. */
	request<T = unknown>(method: string, params: unknown): Promise<T>;
	/** Tell the agent something that needs no answer. */
	notify(method: string, params: unknown): void;
	/** Reject everything still waiting; later requests fail at once. */
	close(reason: string): void;
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * Speak the wire over a child's pipes. `handlers` answer the agent's own
 * requests and notifications by method; an unknown request is refused
 * (the agent is told the method does not exist), an unknown notification
 * is ignored. `onMalformed` hears a line that is not a message.
 */
export function createAcpWire(child: ChildProcessWithoutNullStreams, handlers: Readonly<Record<string, Handler>>, onMalformed: () => void): AcpWire {
	let nextId = 1;
	let closed: string | null = null;
	const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const send = (message: object) => {
		if (closed === null && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	};
	const answer = async (id: unknown, method: string, params: unknown) => {
		const handler = Object.hasOwn(handlers, method) ? handlers[method]! : null;
		if (!handler) {
			if (id !== undefined) send({ id, error: { code: METHOD_NOT_FOUND, message: "Method not found" } });
			return;
		}
		try {
			const result = await handler(params);
			if (id !== undefined) send({ id, result: result ?? null });
		} catch (error) {
			if (id !== undefined) send({ id, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : "Request failed" } });
		}
	};
	child.stdin.on("error", () => undefined); // the close handler reports a dead agent
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.trim() || closed !== null) return;
		let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
		try {
			message = JSON.parse(line) as typeof message;
		} catch {
			onMalformed();
			return;
		}
		if (typeof message.method === "string") {
			void answer(message.id, message.method, message.params);
			return;
		}
		const pending = typeof message.id === "number" ? waiting.get(message.id) : undefined;
		if (!pending) return;
		waiting.delete(message.id as number);
		if (message.error) pending.reject(new AcpRequestError(message.error.message ?? "The agent refused the request", message.error.code ?? INTERNAL_ERROR, message.error.data));
		else pending.resolve(message.result);
	});
	return {
		request: <T>(method: string, params: unknown) =>
			new Promise<T>((resolve, reject) => {
				if (closed !== null) return reject(new Error(closed));
				const id = nextId++;
				waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
				send({ id, method, params });
			}),
		notify: (method, params) => send({ method, params }),
		close: (reason) => {
			if (closed !== null) return;
			closed = reason;
			for (const pending of waiting.values()) pending.reject(new Error(reason));
			waiting.clear();
		},
	};
}

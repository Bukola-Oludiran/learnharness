/**
 * Quiz evidence (fork, phase 4c — see FORK.md): graded multiple-choice
 * answers in a teaching session become results on the ideas that lesson
 * added to the graph.
 *
 * A quiz names a node of the SESSION's plan, not a graph idea, and the
 * lesson reaches the graph in chunks, some turns after it was taught. So
 * after a turn settles (owner, 2026-11-10: as the lesson goes), a cheap
 * model matches the answers not yet recorded to the ideas the session has
 * in the graph so far. An answer that matches nothing is NOT recorded; it
 * is tried again once more of the lesson has landed. Ledger ids are
 * deterministic, so a replay appends nothing.
 */

import { courseOfSession } from "../core/course.ts";
import { quizEvidenceId, quizEvidenceOf, quizResultsOf } from "../core/evidence.ts";
import type { LinkableIdea, QuizLinker } from "./ingest/test-reader.ts";
import type { Stores } from "./stores.ts";

export interface QuizEvidenceDeps {
	stores: Pick<Stores, "chatStore" | "courseStore" | "evidenceStore" | "graphStore">;
	link: QuizLinker;
}

interface SyncState {
	running: boolean;
	/** A turn settled while a match was running: look again when it ends. */
	again: boolean;
	/** What the last attempt saw — the same answers against the same ideas are not asked twice. */
	seen?: string;
}

interface LhQuizEvidenceGlobal {
	__lhQuizEvidence?: Map<string, SyncState>;
}
function states(): Map<string, SyncState> {
	const g = globalThis as typeof globalThis & LhQuizEvidenceGlobal;
	return (g.__lhQuizEvidence ??= new Map());
}

export function createQuizEvidenceSync(deps: QuizEvidenceDeps) {
	const { chatStore, courseStore, evidenceStore, graphStore } = deps.stores;

	async function attempt(chatId: string, state: SyncState): Promise<number> {
		const chat = chatStore.getChat(chatId);
		if (!chat || chat.kind === "practice") return 0;
		const recorded = new Set(evidenceStore.read().map((entry) => entry.id));
		const pending = quizResultsOf(chat.messages).filter((result) => !recorded.has(quizEvidenceId(chatId, result.toolCallId)));
		if (pending.length === 0) return 0;
		const ideas: LinkableIdea[] = graphStore
			.readNodes()
			.filter((node) => node.provenance.some((point) => point.chatId === chatId))
			.map((node) => ({ id: node.id, name: node.name, statement: node.statement }));
		if (ideas.length === 0) return 0; // the lesson has not reached the graph yet
		const keyOf = (results: readonly { toolCallId: string }[]) => `${results.map((result) => result.toolCallId).join(",")}|${ideas.map((idea) => idea.id).join(",")}`;
		if (state.seen === keyOf(pending)) return 0;
		// A failed match throws from here and leaves `seen` alone, so it is tried again.
		const links = await deps.link(pending, ideas);
		const known = new Set(ideas.map((idea) => idea.id));
		const course = courseOfSession(courseStore.listCourses(), chatId);
		const unitId = course?.sessions.find((session) => session.chatId === chatId)?.unitIds[0];
		const matches = pending.map((result, index) => ({ result, nodeIds: (links[index] ?? []).filter((id) => known.has(id)) }));
		// What is left unmatched against these ideas is not asked about again until more ideas land.
		state.seen = keyOf(matches.filter((matched) => matched.nodeIds.length === 0).map((matched) => matched.result));
		const entries = matches
			.filter((matched) => matched.nodeIds.length > 0)
			.map((matched) => quizEvidenceOf(chatId, matched.result, matched.nodeIds, { courseId: course?.id, unitId }));
		return entries.length > 0 ? evidenceStore.append(entries) : 0;
	}

	/** Record the session's unrecorded quiz answers that match an idea.
	 *  Resolves with how many landed. One match per session at a time. */
	return async function syncQuizEvidence(chatId: string): Promise<number> {
		const state = states().get(chatId) ?? { running: false, again: false };
		states().set(chatId, state);
		if (state.running) {
			state.again = true;
			return 0;
		}
		state.running = true;
		let landed = 0;
		try {
			do {
				state.again = false;
				landed += await attempt(chatId, state);
			} while (state.again);
		} finally {
			state.running = false;
		}
		return landed;
	};
}

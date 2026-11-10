/**
 * Learner-evidence service (fork, phase 3b — see FORK.md).
 *
 *   read   evidenceView() joins the ledger to the graph's ideas and derives
 *          each idea's state (core/evidence.ts ideaState). Results that
 *          point at an idea upstream has since deleted are ignored.
 *   write  marked tests append through the materials service. Practice
 *          results are FOLDED from the saved session record when its turn
 *          settles — a bus subscription, not a hook in the practice tools,
 *          so upstream's tool code is untouched. Ids are deterministic, so
 *          a re-fold appends nothing.
 */

import { subscribe } from "../core/events.ts";
import { courseOfSession } from "../core/course.ts";
import { byTime, ideaState, practiceEvidenceOf } from "../core/evidence.ts";
import type { Evidence, EvidenceOutcome, EvidenceView, IdeaResult } from "../core/contracts.ts";
import { stores } from "./stores.ts";

interface LhEvidenceGlobal {
	__lhEvidenceSync?: { subscribed: boolean; backfilled: boolean };
}
function syncState(): NonNullable<LhEvidenceGlobal["__lhEvidenceSync"]> {
	const g = globalThis as typeof globalThis & LhEvidenceGlobal;
	return (g.__lhEvidenceSync ??= { subscribed: false, backfilled: false });
}

/** Fold one practice session's concluded problems into the ledger. */
export function syncPracticeEvidence(chatId: string): number {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat || chat.kind !== "practice") return 0;
	const course = courseOfSession(stores.courseStore.listCourses(), chatId);
	return stores.evidenceStore.append(practiceEvidenceOf(chatId, chat.messages, course?.id));
}

/** Practice sessions concluded before this build existed: folded once per
 *  process, on the first evidence read. */
function backfillPracticeEvidence(): void {
	const state = syncState();
	if (state.backfilled) return;
	state.backfilled = true;
	for (const chat of stores.chatStore.listChats()) {
		if (chat.kind !== "practice") continue;
		try {
			syncPracticeEvidence(chat.id);
		} catch (error) {
			console.error(`[evidence] backfill failed for ${chat.id}:`, error);
		}
	}
}

/** One subscription per process (globalThis: Next dev gives each route its
 *  own module instance). turn-settled fires after the record is durable. */
function ensureSubscribed(): void {
	const state = syncState();
	if (state.subscribed) return;
	state.subscribed = true;
	subscribe((event) => {
		if (event.type !== "turn-settled") return;
		try {
			syncPracticeEvidence((event as { chatId: string }).chatId);
		} catch (error) {
			console.error("[evidence] practice fold failed:", error);
		}
	});
}
ensureSubscribed();

/** Remove a test paper's results (it was deleted, or is being re-approved). */
export function removeMaterialEvidence(materialId: string): void {
	const all = stores.evidenceStore.read();
	const kept = all.filter((entry) => entry.materialId !== materialId);
	if (kept.length !== all.length) stores.evidenceStore.rewrite(kept);
}

function sourceOf(entry: Evidence, labels: Map<string, IdeaResult["source"]>): IdeaResult["source"] {
	const key = entry.materialId ?? entry.chatId ?? "";
	const cached = labels.get(key);
	if (cached) return cached;
	let source: IdeaResult["source"] = { label: entry.from === "test" ? "A deleted test" : "A deleted session" };
	if (entry.materialId) {
		const material = stores.materialStore.getMaterial(entry.materialId);
		if (material) source = { label: material.title, href: `/course/${material.courseId}` };
	} else if (entry.chatId) {
		const title = stores.chatStore.listChats().find((chat) => chat.id === entry.chatId)?.title;
		if (title) source = { label: title, href: `/chat/${entry.chatId}` };
	}
	labels.set(key, source);
	return source;
}

/** Every idea's derived state, and the results behind it. */
export function evidenceView(): EvidenceView {
	backfillPracticeEvidence();
	const nodes = stores.graphStore.readNodes();
	const entries = stores.evidenceStore.read().sort(byTime);
	const byNode = new Map<string, Evidence[]>();
	for (const entry of entries) {
		for (const nodeId of entry.nodeIds) {
			const list = byNode.get(nodeId);
			if (list) list.push(entry);
			else byNode.set(nodeId, [entry]);
		}
	}
	const labels = new Map<string, IdeaResult["source"]>();
	const states: EvidenceView["states"] = {};
	const results: EvidenceView["results"] = {};
	for (const node of nodes) {
		const own = byNode.get(node.id) ?? [];
		// Notes and test sources are "src_…"; anything else is a session.
		const taught = node.provenance.some((point) => !point.chatId.startsWith("src_"));
		states[node.id] = ideaState(own.map((entry): EvidenceOutcome => entry.outcome), taught);
		if (own.length > 0) {
			results[node.id] = [...own].reverse().map((entry) => ({
				id: entry.id,
				at: entry.at,
				from: entry.from,
				outcome: entry.outcome,
				summary: entry.summary,
				source: sourceOf(entry, labels),
			}));
		}
	}
	return { states, results };
}

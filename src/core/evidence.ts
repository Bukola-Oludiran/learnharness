/**
 * Learner-evidence logic (fork, phase 3b): pure functions — the state rule,
 * the practice-record fold, and test-reading hygiene. No IO.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Evidence, EvidenceOutcome, IdeaState, TestOutcome, TestQuestion, TestReading } from "./contracts/evidence.ts";
import { MAX_TEST_QUESTIONS } from "./contracts/evidence.ts";
import { PRACTICE_CONCLUDE_TOOL, problemInputForConclude, type LhMessage } from "./native-messages.ts";

const SCORE: Record<EvidenceOutcome, number> = { correct: 1, partial: 0.5, wrong: 0 };

/**
 * THE STATE RULE (owner choice, 2026-11-10: the last three results, weighed
 * together). `outcomes` are one idea's results, OLDEST first.
 *
 *   demonstrated  latest correct AND average of the last three ≥ 0.75
 *   missed        latest wrong   AND average of the last three < 0.5
 *   shaky         any other idea with results
 *
 * With no results the idea is `taught` when a session covered it, else `unseen`.
 */
export function ideaState(outcomes: readonly EvidenceOutcome[], taught: boolean): IdeaState {
	if (outcomes.length === 0) return taught ? "taught" : "unseen";
	const recent = outcomes.slice(-3);
	const latest = recent[recent.length - 1]!;
	const average = recent.reduce((sum, outcome) => sum + SCORE[outcome], 0) / recent.length;
	if (latest === "correct" && average >= 0.75) return "demonstrated";
	if (latest === "wrong" && average < 0.5) return "missed";
	return "shaky";
}

/** Oldest first; ties broken by id so the order is stable. */
export function byTime(a: Pick<Evidence, "at" | "id">, b: Pick<Evidence, "at" | "id">): number {
	return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
}

/** How a practice conclusion counts. "movedOn" and "dismissed" say nothing
 *  about whether the learner knows the idea, so they record nothing. */
const PRACTICE_OUTCOME: Record<string, EvidenceOutcome | undefined> = {
	solved: "correct",
	solvedWithHints: "partial",
	surrendered: "wrong",
};

/**
 * The practice evidence a session's record holds: one result per CLEANLY
 * concluded problem that named target ideas at pose time. Derived from the
 * saved record (no hook in the practice tools), with deterministic ids, so
 * folding the same record again yields the same lines.
 */
export function practiceEvidenceOf(chatId: string, messages: readonly LhMessage[], courseId?: string): Evidence[] {
	const cleanResults = new Map<string, ToolResultMessage>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (!result.isError) cleanResults.set(result.toolCallId, result);
	}
	const out: Evidence[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const block of (m as AssistantMessage).content) {
			if (block.type !== "toolCall" || block.name !== PRACTICE_CONCLUDE_TOOL) continue;
			const result = cleanResults.get(block.id);
			if (!result) continue; // a refused or dangling conclude concluded nothing
			const args = (block.arguments ?? {}) as { outcome?: unknown; verdict?: unknown };
			const outcome = typeof args.outcome === "string" ? PRACTICE_OUTCOME[args.outcome] : undefined;
			if (!outcome) continue;
			const pose = problemInputForConclude(messages, block.id);
			const nodeIds = Array.isArray(pose?.target) ? pose.target.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
			if (nodeIds.length === 0) continue; // an untargeted problem is about no particular idea
			const statement = typeof pose?.statement === "string" ? pose.statement.trim() : "";
			const verdict = typeof args.verdict === "string" ? args.verdict.trim() : "";
			out.push({
				id: `practice:${chatId}:${block.id}`,
				at: new Date(result.timestamp).toISOString(),
				nodeIds: [...new Set(nodeIds)],
				from: "practice",
				outcome,
				summary: [statement, verdict].filter(Boolean).join(" — ").slice(0, 600),
				chatId,
				...(courseId ? { courseId } : {}),
			});
		}
	}
	return out;
}

// ─── marked tests ────────────────────────────────────────────────────────────

const TEST_OUTCOMES: readonly TestOutcome[] = ["correct", "partial", "wrong", "unmarked"];
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const mark = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : undefined);

/**
 * A reading made safe to store: from the model's submit or from the
 * learner's edited review. Unknown shapes degrade to omission; a question
 * with neither text nor an idea is dropped. Returns null when nothing usable
 * remains.
 */
export function cleanTestReading(value: unknown): TestReading | null {
	const raw = value as { questions?: unknown; total?: unknown } | null;
	if (!raw || !Array.isArray(raw.questions)) return null;
	const questions: TestQuestion[] = [];
	for (const [index, item] of raw.questions.slice(0, MAX_TEST_QUESTIONS).entries()) {
		const q = (item ?? {}) as Record<string, unknown>;
		const question = text(q.question, 4000);
		const idea = text(q.idea, 1000);
		if (!question && !idea) continue;
		const awarded = mark(q.marksAwarded);
		const available = mark(q.marksAvailable);
		const whatWentWrong = text(q.whatWentWrong, 1000);
		questions.push({
			number: text(q.number, 20) || String(index + 1),
			question,
			answer: text(q.answer, 4000),
			...(awarded !== undefined ? { marksAwarded: awarded } : {}),
			...(available !== undefined ? { marksAvailable: available } : {}),
			outcome: TEST_OUTCOMES.includes(q.outcome as TestOutcome) ? (q.outcome as TestOutcome) : "unmarked",
			...(whatWentWrong ? { whatWentWrong } : {}),
			idea,
		});
	}
	if (questions.length === 0) return null;
	const total = (raw.total ?? {}) as { earned?: unknown; possible?: unknown };
	const earned = mark(total.earned);
	const possible = mark(total.possible);
	return { questions, ...(earned !== undefined && possible !== undefined && possible > 0 ? { total: { earned, possible } } : {}) };
}

/** The paper's score: the total it shows, else the sum over its MARKED
 *  questions when each of those carries both marks. Undefined when neither
 *  is known. */
export function testScore(reading: TestReading): { earned: number; possible: number } | undefined {
	if (reading.total) return reading.total;
	const marked = reading.questions.filter((q) => q.outcome !== "unmarked");
	if (marked.length === 0 || marked.some((q) => q.marksAwarded === undefined || q.marksAvailable === undefined)) return undefined;
	const earned = marked.reduce((sum, q) => sum + q.marksAwarded!, 0);
	const possible = marked.reduce((sum, q) => sum + q.marksAvailable!, 0);
	return possible > 0 ? { earned, possible } : undefined;
}

/** The notes text a test contributes to the graph: its tested ideas only —
 *  never the learner's answers, which may be wrong. */
export function testIdeasText(title: string, reading: TestReading): string {
	const ideas = [...new Set(reading.questions.map((q) => q.idea.trim()).filter(Boolean))];
	return ideas.length === 0 ? "" : `# Ideas tested in ${title}\n\n${ideas.map((idea) => `- ${idea}`).join("\n")}`;
}

/** The evidence lines an approved, linked reading yields: one per MARKED question. */
export function testEvidenceOf(material: { id: string; courseId: string }, reading: TestReading, at: string): Evidence[] {
	const out: Evidence[] = [];
	for (const [index, q] of reading.questions.entries()) {
		if (q.outcome === "unmarked") continue;
		const marks = q.marksAwarded !== undefined && q.marksAvailable !== undefined ? ` (${q.marksAwarded}/${q.marksAvailable})` : "";
		out.push({
			id: `test:${material.id}:${index}`,
			at,
			nodeIds: [...new Set(q.nodeIds ?? [])],
			from: "test",
			outcome: q.outcome,
			summary: [`Q${q.number}${marks}: ${q.question}`, q.outcome === "correct" ? "" : (q.whatWentWrong ?? "")].filter(Boolean).join(" — ").slice(0, 600),
			materialId: material.id,
			courseId: material.courseId,
		});
	}
	return out;
}

/** The reader's instructions (wording approved by the owner, 2026-11-10). */
export const TEST_READER_INSTRUCTIONS = [
	"You are reading photos of a marked test paper. Report exactly what is on the paper.",
	[
		"For each question, in order:",
		"- number: as printed.",
		"- question: the question text, transcribed. Write mathematics in LaTeX between $ signs.",
		"- answer: what the learner wrote, transcribed or briefly described.",
		"- marksAwarded and marksAvailable: as marked on the paper. Leave either out if it is not shown.",
		'- outcome: "correct" for full marks or a tick, "wrong" for zero or a cross, "partial" for anything between. If nothing shows how it was marked, use "unmarked".',
		"- whatWentWrong: for partial or wrong answers, one sentence on the error, using the marker's comments where there are any. Leave it out for correct answers.",
		"- idea: one true, self-contained sentence stating the idea the question tests. Base it on the question, never on the learner's answer.",
	].join("\n"),
	"Report the total score if the paper shows one.",
	"Where handwriting is unclear, give your best reading followed by [?]. Never guess a mark that is not on the paper.",
	"Call submit_test once with the result.",
].join("\n\n");

/** The linker's instructions (wording approved by the owner, 2026-11-10). */
export const TEST_LINKER_INSTRUCTIONS = [
	"Match each test question to the ideas it tests.",
	"You get the questions, each with the idea it tests, and a list of ideas from the learner's knowledge graph, each with an id.",
	"For every question, return the ids of the listed ideas whose statements say what the question tests. Usually that is one idea. Use two or three only when the question needs each of them. Return no ids when none of the listed ideas fits. Never invent an id.",
	"Call submit_links once with the result.",
].join("\n\n");

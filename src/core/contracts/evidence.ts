/**
 * Learner-evidence contracts (fork, phase 3b — see FORK.md).
 *
 * Every idea in the graph can carry RESULTS: dated answers to "do I know
 * this?" from marked tests and practice problems. They live in their own
 * append-only ledger (graph/evidence.jsonl) BESIDE upstream's ledgers —
 * upstream took outcomes out of its graph in September 2026, so nothing
 * upstream reads or writes this file. An idea's STATE is derived from its
 * results at read time and never stored, so the rule can change without
 * rewriting data.
 */

export type EvidenceOutcome = "correct" | "partial" | "wrong";
export type EvidenceOrigin = "test" | "practice" | "quiz" | "probe";

/** One evidence.jsonl line: one result about one or more ideas. */
export interface Evidence {
	/** Deterministic per source event — a replay appends nothing new.
	 *  "test:<materialId>:<question index>" / "practice:<chatId>:<conclude call id>". */
	id: string;
	/** ISO time of the result. */
	at: string;
	/** The graph ideas this result is about. Empty = unplaced (a test
	 *  question that matched no idea); kept, but counts toward nothing. */
	nodeIds: string[];
	from: EvidenceOrigin;
	outcome: EvidenceOutcome;
	/** What was asked and what went wrong. */
	summary: string;
	courseId?: string;
	chatId?: string;
	/** The test paper it came from. */
	materialId?: string;
	unitId?: string;
}

/**
 * unseen       — came from uploaded material; no session covered it, no results
 * taught       — a session covered it; no results yet
 * demonstrated — latest result correct and the last-three average ≥ 0.75
 * missed       — latest result wrong and the last-three average < 0.5
 * shaky        — has results, neither of the above
 */
export type IdeaState = "unseen" | "taught" | "demonstrated" | "shaky" | "missed";

/** One result as the idea's detail card shows it. */
export interface IdeaResult {
	id: string;
	at: string;
	from: EvidenceOrigin;
	outcome: EvidenceOutcome;
	summary: string;
	/** Where it came from, labelled for display. `href` when it can be opened. */
	source: { label: string; href?: string };
}

/** GET /api/graph/evidence — the view's join input. */
export interface EvidenceView {
	/** nodeId → derived state, for every idea in the graph. */
	states: Record<string, IdeaState>;
	/** nodeId → its results, newest first. Ideas with none are absent. */
	results: Record<string, IdeaResult[]>;
}

// ─── marked tests ────────────────────────────────────────────────────────────

export type TestOutcome = EvidenceOutcome | "unmarked";

export interface TestQuestion {
	number: string;
	question: string;
	/** What the learner wrote. */
	answer: string;
	marksAwarded?: number;
	marksAvailable?: number;
	outcome: TestOutcome;
	whatWentWrong?: string;
	/** One true sentence stating the idea the question tests. */
	idea: string;
	/** Set by the linker after extraction; empty = unplaced. */
	nodeIds?: string[];
}

/** What the reader took off a marked paper, as reviewed by the learner. */
export interface TestReading {
	questions: TestQuestion[];
	total?: { earned: number; possible: number };
}

export const MAX_TEST_PAGES = 10;
export const MAX_TEST_QUESTIONS = 100;

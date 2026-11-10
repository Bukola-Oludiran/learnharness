"use client";

import { cn } from "@/lib/utils";
import type { MaterialView, TestOutcome, TestQuestion, TestReading } from "@/src/core";

/**
 * The marked-test review (fork, phase 3b — see FORK.md): everything the
 * vision model read off the paper, editable before anything is recorded.
 * The same body shows an approved test's results read-only.
 * Pure — state lives in the dialog (course-materials.tsx).
 */

const QUIET = "rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";
const FIELD = "w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring disabled:opacity-70";
const LABEL = "mb-0.5 block text-[11px] uppercase tracking-wide text-muted-foreground";

const OUTCOMES: { value: TestOutcome; label: string }[] = [
	{ value: "correct", label: "Correct" },
	{ value: "partial", label: "Partial" },
	{ value: "wrong", label: "Wrong" },
	{ value: "unmarked", label: "Not marked" },
];

const numberOrUndefined = (value: string): number | undefined => {
	if (value.trim() === "") return undefined;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** How a finished question was filed. */
export function placementLabel(question: TestQuestion): string {
	if (question.outcome === "unmarked") return "Not marked — no result recorded";
	const count = question.nodeIds?.length ?? 0;
	if (count === 0) return "Unplaced — matched no idea, counts toward nothing";
	return count === 1 ? "Recorded on 1 idea" : `Recorded on ${count} ideas`;
}

function QuestionCard({
	question,
	index,
	readOnly,
	busy,
	onChange,
	onRemove,
}: {
	question: TestQuestion;
	index: number;
	readOnly: boolean;
	busy: boolean;
	onChange: (next: TestQuestion) => void;
	onRemove: () => void;
}) {
	const locked = readOnly || busy;
	const set = (patch: Partial<TestQuestion>) => onChange({ ...question, ...patch });
	const id = (field: string) => `test-q${index}-${field}`;
	return (
		<div data-testid="test-question" data-outcome={question.outcome} className="rounded-lg border border-border/60 p-3">
			<div className="flex flex-wrap items-end gap-2">
				<div className="w-16">
					<label className={LABEL} htmlFor={id("number")}>No.</label>
					<input id={id("number")} className={FIELD} value={question.number} disabled={locked} onChange={(e) => set({ number: e.target.value })} />
				</div>
				<div className="w-32">
					<label className={LABEL} htmlFor={id("outcome")}>Result</label>
					<select
						id={id("outcome")}
						data-testid="test-question-outcome"
						className={FIELD}
						value={question.outcome}
						disabled={locked}
						onChange={(e) => set({ outcome: e.target.value as TestOutcome })}
					>
						{OUTCOMES.map((o) => (
							<option key={o.value} value={o.value}>{o.label}</option>
						))}
					</select>
				</div>
				<div className="w-20">
					<label className={LABEL} htmlFor={id("awarded")}>Marks</label>
					<input id={id("awarded")} className={FIELD} inputMode="decimal" value={question.marksAwarded ?? ""} disabled={locked}
						onChange={(e) => set({ marksAwarded: numberOrUndefined(e.target.value) })} />
				</div>
				<div className="w-20">
					<label className={LABEL} htmlFor={id("available")}>Out of</label>
					<input id={id("available")} className={FIELD} inputMode="decimal" value={question.marksAvailable ?? ""} disabled={locked}
						onChange={(e) => set({ marksAvailable: numberOrUndefined(e.target.value) })} />
				</div>
				<span className="flex-1" />
				{!readOnly && (
					<button type="button" data-testid="test-question-remove" onClick={onRemove} disabled={busy} className={cn(QUIET, "hover:text-destructive")}>
						Remove
					</button>
				)}
			</div>
			<div className="mt-2 grid gap-2 sm:grid-cols-2">
				<div>
					<label className={LABEL} htmlFor={id("question")}>Question</label>
					<textarea id={id("question")} className={cn(FIELD, "min-h-16 resize-y font-mono")} value={question.question} disabled={locked} spellCheck={false}
						onChange={(e) => set({ question: e.target.value })} />
				</div>
				<div>
					<label className={LABEL} htmlFor={id("answer")}>Your answer</label>
					<textarea id={id("answer")} className={cn(FIELD, "min-h-16 resize-y font-mono")} value={question.answer} disabled={locked} spellCheck={false}
						onChange={(e) => set({ answer: e.target.value })} />
				</div>
			</div>
			{question.outcome !== "correct" && question.outcome !== "unmarked" && (
				<div className="mt-2">
					<label className={LABEL} htmlFor={id("wrong")}>What went wrong</label>
					<input id={id("wrong")} className={FIELD} value={question.whatWentWrong ?? ""} disabled={locked} onChange={(e) => set({ whatWentWrong: e.target.value })} />
				</div>
			)}
			<div className="mt-2">
				<label className={LABEL} htmlFor={id("idea")}>Idea tested</label>
				<textarea id={id("idea")} data-testid="test-question-idea" className={cn(FIELD, "min-h-10 resize-y")} value={question.idea} disabled={locked}
					onChange={(e) => set({ idea: e.target.value })} />
			</div>
			{readOnly && (
				<p data-testid="test-question-placement" className="mt-2 text-xs text-muted-foreground">{placementLabel(question)}</p>
			)}
		</div>
	);
}

export function TestReviewBody({
	material,
	reading,
	readOnly = false,
	busy,
	error,
	onReading,
	onApprove,
	onDiscard,
	onClose,
}: {
	material: Pick<MaterialView, "title" | "aiReadParts" | "notice">;
	/** null while the reading loads. */
	reading: TestReading | null;
	/** An approved test's results: nothing editable, no approve. */
	readOnly?: boolean;
	busy: boolean;
	error: string | null;
	onReading: (next: TestReading) => void;
	onApprove: () => void;
	onDiscard: () => void;
	onClose: () => void;
}) {
	const pages = material.aiReadParts === 1 ? "1 page" : `${material.aiReadParts} pages`;
	const setQuestion = (index: number, next: TestQuestion) =>
		reading && onReading({ ...reading, questions: reading.questions.map((q, i) => (i === index ? next : q)) });
	const removeQuestion = (index: number) => reading && onReading({ ...reading, questions: reading.questions.filter((_, i) => i !== index) });
	const setTotal = (patch: { earned?: number; possible?: number }) => {
		if (!reading) return;
		const earned = "earned" in patch ? patch.earned : reading.total?.earned;
		const possible = "possible" in patch ? patch.possible : reading.total?.possible;
		const { total: _total, ...rest } = reading;
		onReading(earned === undefined && possible === undefined ? rest : { ...rest, total: { earned: earned ?? 0, possible: possible ?? 0 } });
	};
	const locked = readOnly || busy;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={readOnly ? "Test results" : "Review marked test"}
			data-testid="test-review-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[calc(100vh-4rem)] w-[56rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">{readOnly ? "Test results" : "Review marked test"}</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{material.title}</code>
			</div>
			{!readOnly && (
				<p className="mt-2 text-sm text-muted-foreground">
					A vision model read {pages} of this paper. Check each question, mark and result against the paper, and fix anything ending in{" "}
					<code className="font-mono">[?]</code>. Each “Idea tested” is added to your knowledge graph, and each marked result is recorded on it. Nothing is
					recorded until you approve.
				</p>
			)}
			{material.notice && <p className="mt-1 text-xs text-muted-foreground">{material.notice}</p>}
			{reading === null ? (
				<div className="mt-3 py-8 text-center text-xs text-muted-foreground">Loading…</div>
			) : (
				<>
					<div className="mt-3 flex items-end gap-2">
						<div className="w-24">
							<label className={LABEL} htmlFor="test-total-earned">Total</label>
							<input id="test-total-earned" data-testid="test-total-earned" className={FIELD} inputMode="decimal" value={reading.total?.earned ?? ""} disabled={locked}
								onChange={(e) => setTotal({ earned: numberOrUndefined(e.target.value) })} />
						</div>
						<div className="w-24">
							<label className={LABEL} htmlFor="test-total-possible">Out of</label>
							<input id="test-total-possible" className={FIELD} inputMode="decimal" value={reading.total?.possible ?? ""} disabled={locked}
								onChange={(e) => setTotal({ possible: numberOrUndefined(e.target.value) })} />
						</div>
						<span className="pb-1 text-xs text-muted-foreground">
							{reading.questions.length === 1 ? "1 question" : `${reading.questions.length} questions`}
						</span>
					</div>
					<div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
						{reading.questions.map((question, index) => (
							<QuestionCard
								key={index}
								question={question}
								index={index}
								readOnly={readOnly}
								busy={busy}
								onChange={(next) => setQuestion(index, next)}
								onRemove={() => removeQuestion(index)}
							/>
						))}
					</div>
				</>
			)}
			{error && (
				<p role="alert" data-testid="test-review-error" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
			<div className="mt-4 flex items-center gap-2">
				{!readOnly && (
					<button type="button" data-testid="test-review-discard" onClick={onDiscard} disabled={busy} className={cn(QUIET, "hover:text-destructive")}>
						Discard test
					</button>
				)}
				<span className="flex-1" />
				<button type="button" onClick={onClose} disabled={busy} className={QUIET}>
					{readOnly ? "Close" : "Not now"}
				</button>
				{!readOnly && (
					<button
						type="button"
						data-testid="test-review-approve"
						onClick={onApprove}
						disabled={busy || reading === null || reading.questions.length === 0}
						className={ACTION}
					>
						{busy ? "Approving…" : "Approve and record results"}
					</button>
				)}
			</div>
		</div>
	);
}

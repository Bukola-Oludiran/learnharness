/**
 * Evidence UI render pins (fork, phase 3b — FORK.md). Same tsx
 * classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeaEvidence, STATE_TINT, stateTint } from "../components/idea-evidence.tsx";
import { placementLabel, TestReviewBody } from "../components/test-review.tsx";
import { MaterialRow, materialStatus } from "../components/course-materials.tsx";
import type { EvidenceView, MaterialView, TestQuestion, TestReading } from "../src/core/index.ts";

const view: EvidenceView = {
	states: { n_demo: "demonstrated", n_shaky: "shaky", n_missed: "missed", n_taught: "taught", n_unseen: "unseen" },
	results: {
		n_missed: [
			{ id: "e2", at: "2026-11-10T09:00:00.000Z", from: "practice", outcome: "wrong", summary: "Could not set up the ratio.", source: { label: "Bayes drills", href: "/chat/chat_1" } },
			{ id: "e1", at: "2026-11-02T09:00:00.000Z", from: "test", outcome: "partial", summary: "Q1 (1/2): State Bayes' rule.", source: { label: "A deleted test" } },
		],
	},
};
const noop = () => {};

describe("map tints", () => {
	it("tints only ideas with results; the rest keep the map's own colour", () => {
		assert.equal(stateTint(view, "n_demo"), STATE_TINT.demonstrated);
		assert.equal(stateTint(view, "n_shaky"), STATE_TINT.shaky);
		assert.equal(stateTint(view, "n_missed"), STATE_TINT.missed);
		assert.equal(stateTint(view, "n_taught"), undefined);
		assert.equal(stateTint(view, "n_unseen"), undefined);
		assert.equal(stateTint(view, "imp_1"), undefined);
		assert.equal(stateTint(null, "n_demo"), undefined);
		for (const tint of Object.values(STATE_TINT)) assert.match(tint!, /^#[0-9a-f]{6}$/);
	});
});

describe("IdeaEvidence (the detail card block)", () => {
	const card = (nodeId: string, v: EvidenceView | null = view) => renderToStaticMarkup(<IdeaEvidence view={v} nodeId={nodeId} />);

	it("renders nothing before the view loads or for a non-idea node", () => {
		assert.equal(card("n_demo", null), "");
		assert.equal(card("imp_1"), "");
	});

	it("names the state and lists results newest first with their source", () => {
		const html = card("n_missed");
		assert.match(html, /data-state="missed"/);
		assert.match(html, />Missed</);
		assert.match(html, /Wrong[\s\S]*Practice · 2026-11-10[\s\S]*href="\/chat\/chat_1"[^>]*>Bayes drills<[\s\S]*Partial[\s\S]*Test · 2026-11-02[\s\S]*A deleted test/);
		assert.equal(html.match(/data-testid="idea-result"/g)?.length, 2);
		assert.doesNotMatch(html, /href="[^"]*"[^>]*>A deleted test/);
	});

	it("an idea with no results shows its state and no list", () => {
		const html = card("n_unseen");
		assert.match(html, />Unseen</);
		assert.doesNotMatch(html, /idea-results/);
		assert.match(card("n_taught"), /A session covered it\. No results yet\./);
	});
});

describe("the marked-test review", () => {
	const question = (overrides: Partial<TestQuestion> = {}): TestQuestion =>
		({ number: "1", question: "State Bayes' rule.", answer: "P(A|B)", marksAwarded: 1, marksAvailable: 2, outcome: "partial", whatWentWrong: "No division.", idea: "Bayes divides by P(B).", ...overrides });
	const reading: TestReading = { questions: [question(), question({ number: "2", outcome: "correct", whatWentWrong: undefined })], total: { earned: 3, possible: 4 } };
	const body = (overrides: Partial<React.ComponentProps<typeof TestReviewBody>> = {}) => renderToStaticMarkup(
		<TestReviewBody material={{ title: "Midterm", aiReadParts: 2 }} reading={reading} busy={false} error={null}
			onReading={noop} onApprove={noop} onDiscard={noop} onClose={noop} {...overrides} />,
	);

	it("shows every question editable, and says nothing is recorded until approval", () => {
		const html = body();
		assert.match(html, /A vision model read 2 pages of this paper/);
		assert.match(html, /Nothing is\s+recorded until you approve\./);
		assert.equal(html.match(/data-testid="test-question"/g)?.length, 2);
		assert.match(html, /data-testid="test-total-earned"[^>]*value="3"/);
		assert.equal(html.match(/What went wrong/g)?.length, 1, "only the non-correct question asks what went wrong");
		assert.match(html, /data-testid="test-review-approve"/);
	});

	it("cannot approve while loading or with no questions", () => {
		assert.match(body({ reading: null }), /Loading…[\s\S]*data-testid="test-review-approve"[^>]* disabled=""/);
		assert.match(body({ reading: { questions: [] } }), /data-testid="test-review-approve"[^>]* disabled=""/);
		assert.doesNotMatch(body(), /data-testid="test-review-approve"[^>]* disabled=""/);
	});

	it("results are read-only and say how each question was filed", () => {
		const html = body({ readOnly: true, reading: { questions: [question({ nodeIds: ["n_1"] }), question({ nodeIds: [] }), question({ outcome: "unmarked" })] } });
		assert.match(html, />Test results</);
		assert.doesNotMatch(html, /test-review-approve|test-review-discard|test-question-remove/);
		assert.equal(placementLabel(question({ nodeIds: ["n_1", "n_2"] })), "Recorded on 2 ideas");
		assert.match(html, /Recorded on 1 idea<[\s\S]*Unplaced — matched no idea[\s\S]*Not marked — no result recorded/);
	});
});

describe("a test's row", () => {
	const test = (overrides: Partial<MaterialView> = {}): MaterialView => ({
		id: "mat_t", title: "Midterm", kind: "test", format: "image", courseId: "course_a", fileName: "p1.jpg", sections: [], status: "ready",
		aiReadParts: 2, sourcePath: "C/p1.jpg", createdAt: "", updatedAt: "", interrupted: false, ...overrides,
	});

	it("shows the score and unplaced count, and offers Results once recorded", () => {
		assert.equal(materialStatus(test({ score: { earned: 14, possible: 20 }, unplaced: 2 })).label, "Score 14/20 · 2 unplaced");
		assert.equal(materialStatus(test()).label, "Recorded");
		assert.equal(materialStatus(test({ status: "processing", stage: "converting" })).label, "Reading the paper…");
		assert.equal(materialStatus(test({ status: "processing", stage: "extracting" })).label, "Recording results…");
		const row = (m: MaterialView) => renderToStaticMarkup(
			<MaterialRow material={m} onReview={noop} onResults={noop} onRetry={noop} onAskDelete={noop} onCancelDelete={noop} onDelete={noop} />,
		);
		assert.match(row(test()), /Marked test ·[\s\S]*data-testid="material-results"/);
		assert.doesNotMatch(row(test({ status: "review" })), /material-results/);
		assert.match(row(test({ status: "review" })), /data-testid="material-review"/);
	});
});

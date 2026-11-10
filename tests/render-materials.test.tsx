/**
 * Materials UI render pins (fork, phase 3a — FORK.md). Same tsx
 * classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MaterialReviewBody, MaterialRow, materialStatus } from "../components/course-materials.tsx";
import type { MaterialView } from "../src/core/index.ts";

const material = (overrides: Partial<MaterialView> = {}): MaterialView => ({
	id: "mat_1", title: "Week 1", kind: "notes", format: "pptx", courseId: "course_a", fileName: "Week 1.pptx", sections: [],
	status: "ready", aiReadParts: 0, sourcePath: "Course/Week 1.pptx", createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z",
	interrupted: false, ...overrides,
});
const noop = () => {};
const row = (m: MaterialView, confirmingDelete = false) =>
	renderToStaticMarkup(<MaterialRow material={m} confirmingDelete={confirmingDelete} onReview={noop} onRetry={noop} onAskDelete={noop} onCancelDelete={noop} onDelete={noop} />);

describe("materialStatus", () => {
	it("names each state the learner can be in", () => {
		assert.deepEqual(materialStatus(material({ status: "processing", stage: "converting" })), { label: "Converting…", busy: true, tone: "quiet" });
		assert.equal(materialStatus(material({ status: "processing", stage: "extracting" })).label, "Adding to graph…");
		assert.deepEqual(materialStatus(material({ status: "review" })), { label: "Needs review", busy: false, tone: "attention" });
		assert.equal(materialStatus(material({ status: "ready" })).label, "In graph");
		assert.equal(materialStatus(material({ status: "failed" })).tone, "problem");
		assert.deepEqual(materialStatus(material({ status: "processing", interrupted: true })), { label: "Interrupted", busy: false, tone: "problem" });
	});
});

describe("MaterialRow", () => {
	it("offers Review only when waiting for review, Retry only when failed or interrupted", () => {
		assert.match(row(material({ status: "review", aiReadParts: 2 })), /data-testid="material-review"/);
		assert.doesNotMatch(row(material()), /material-review|material-retry/);
		assert.match(row(material({ status: "failed", error: "Could not open this PDF." })), /data-testid="material-retry"[\s\S]*Could not open this PDF\./);
		const interrupted = row(material({ status: "processing", stage: "converting", interrupted: true }));
		assert.match(interrupted, /data-status="interrupted"/);
		assert.match(interrupted, /material-retry[\s\S]*The app closed before this finished\./);
	});

	it("shows a conversion notice on a healthy material and the format in words", () => {
		const html = row(material({ notice: "3 pictures were not read (logos)." }));
		assert.match(html, /Slides ·/);
		assert.match(html, /3 pictures were not read/);
	});

	it("delete asks first", () => {
		assert.match(row(material()), /data-testid="material-delete"/);
		const confirming = row(material(), true);
		assert.match(confirming, /data-testid="material-delete-confirm"/);
		assert.doesNotMatch(confirming, /data-testid="material-delete"/);
	});
});

describe("MaterialReviewBody", () => {
	const body = (overrides: Partial<React.ComponentProps<typeof MaterialReviewBody>> = {}) => renderToStaticMarkup(
		<MaterialReviewBody material={{ title: "Week 1", aiReadParts: 2, notice: undefined }} text="## Slide 1" busy={false} error={null}
			onText={noop} onApprove={noop} onDiscard={noop} onClose={noop} {...overrides} />,
	);

	it("says how much was AI-read and that nothing is in the graph yet", () => {
		const html = body();
		assert.match(html, /A vision model read 2 parts of this material/);
		assert.match(html, /Nothing reaches your graph until you do\./);
		assert.match(html, /<textarea[^>]*>## Slide 1<\/textarea>/);
		assert.match(body({ material: { title: "t", aiReadParts: 1 } }), /read 1 part of/);
	});

	it("cannot approve while loading or with an empty transcript", () => {
		assert.match(body({ text: null }), /Loading…[\s\S]*data-testid="material-review-approve"[^>]* disabled=""/);
		assert.match(body({ text: "   " }), /data-testid="material-review-approve"[^>]* disabled=""/);
		assert.doesNotMatch(body(), /data-testid="material-review-approve"[^>]* disabled=""/);
		assert.match(body({ error: "Could not approve." }), /role="alert"[^>]*>Could not approve\./);
	});
});

/**
 * Attachment UI render pins (fork, phase 2 — FORK.md). Same tsx
 * classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentTrayView, attachmentsSettled, isAttachableImage, readyAttachmentIds, type AttachmentItem } from "../components/answer-attachments.tsx";
import { AttachmentThumbs } from "../components/attachment-thumbs.tsx";
import { ThinkingCard } from "../components/practice-cards.tsx";

const ID_A = "a".repeat(64);
const item = (overrides: Partial<AttachmentItem>): AttachmentItem => ({ key: "k1", name: "work.jpg", previewUrl: "blob:x", status: "ready", snapshotId: ID_A, ...overrides });

describe("attachment state", () => {
	it("only ready photos ride an answer, once each, in order", () => {
		const items = [item({}), item({ key: "k2", status: "uploading", snapshotId: undefined }), item({ key: "k3" }), item({ key: "k4", snapshotId: "b".repeat(64) })];
		assert.deepEqual(readyAttachmentIds(items), [ID_A, "b".repeat(64)]);
		assert.equal(attachmentsSettled(items), false);
		assert.equal(attachmentsSettled([item({})]), true);
		assert.equal(attachmentsSettled([]), true);
		assert.equal(attachmentsSettled([item({ status: "error", snapshotId: undefined })]), false);
	});

	it("accepts images and HEIC files the browser leaves untyped", () => {
		assert.equal(isAttachableImage({ type: "image/jpeg", name: "a.jpg" }), true);
		assert.equal(isAttachableImage({ type: "", name: "IMG_0001.HEIC" }), true);
		assert.equal(isAttachableImage({ type: "application/pdf", name: "notes.pdf" }), false);
	});
});

describe("AttachmentTrayView", () => {
	const tray = (items: AttachmentItem[], notice: string | null = null) => renderToStaticMarkup(<AttachmentTrayView items={items} notice={notice} onRemove={() => {}} />);

	it("renders nothing when empty", () => {
		assert.equal(tray([]), "");
	});

	it("shows each photo with a remove button and its status", () => {
		const html = tray([item({}), item({ key: "k2", name: "page2.png", status: "uploading", snapshotId: undefined })]);
		assert.equal(html.match(/data-testid="attachment-item"/g)?.length, 2);
		assert.match(html, /data-status="uploading"/);
		assert.match(html, /aria-label="Remove page2\.png"/);
		assert.doesNotMatch(html, /role="alert"/);
	});

	it("a failed upload says why and how to continue; a notice shows when nothing failed", () => {
		assert.match(tray([item({ status: "error", snapshotId: undefined, error: "Not a supported image: the uploaded photo" })]), /role="alert"[^>]*>Not a supported image: the uploaded photo Remove it to submit\./);
		assert.match(tray([], "Only images can be attached here."), /Only images can be attached here\./);
	});
});

describe("transcript cards", () => {
	it("thumbnails render nothing without ids", () => {
		assert.equal(renderToStaticMarkup(<AttachmentThumbs ids={[]} />), "");
		assert.equal(renderToStaticMarkup(<AttachmentThumbs />), "");
	});

	it("a text-only thinking card is unchanged; a photo-only one drops the empty text block", () => {
		const plain = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "p1", text: "my work" }} />);
		assert.match(plain, /data-testid="thinking-card"/);
		assert.doesNotMatch(plain, /attachment-thumbs/);
		const photoOnly = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "p1", text: "", attachments: [ID_A] }} />);
		assert.doesNotMatch(photoOnly, /data-testid="thinking-card"/);
		assert.match(photoOnly, /data-testid="attachment-thumbs"/);
		const both = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "p1", text: "see photo", attachments: [ID_A] }} />);
		assert.match(both, /data-testid="thinking-card"[\s\S]*data-testid="attachment-thumbs"/);
	});
});

/**
 * Answer attachments (fork, phase 2 — see FORK.md): photos of the learner's
 * work riding an answer.
 *
 * The record stores REFERENCES only — snapshot ids in the answer's
 * `details.attachments`, pointing into ChatRecord.imageSnapshots (upstream's
 * session image pool). The bytes join the conversation at exactly one
 * place, the provider boundary (native-messages.ts toLlmMessages), so
 * reloading a chat never re-downloads its pictures.
 */

import type { ImageSnapshot } from "./contracts/chat.ts";

import { DRAWING_RULE } from "./canvas.ts";
import { PLOT_RULE } from "./plot/model.ts";

export const MAX_ANSWER_ATTACHMENTS = 4;
export const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;

/** What an upload may be. HEIC is converted server-side where the OS can. */
export const ATTACHMENT_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,image/bmp,image/heic,image/heif,.heic,.heif";

/** The session's image pool, by snapshot id. An entry that is a canvas
 *  drawing or a graph also carries its outline as the finished text block
 *  (phases 5a–5b; joined at turn time by server/canvases.ts — the stored
 *  snapshot itself is upstream's shape). */
export type ImagePool = Readonly<Record<string, ImageSnapshot & { outline?: string }>>;

/** The model-facing image block (pi-ai's ImageContent shape). */
export interface AttachmentImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * Parse an input event's attachment list. Absent reads as none; anything
 * malformed is a problem line (the caller turns it into a 400).
 */
export function parseAttachmentIds(value: unknown): { ids: string[]; problem?: string } {
	if (value === undefined) return { ids: [] };
	if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !SNAPSHOT_ID_PATTERN.test(id))) {
		return { ids: [], problem: "attachments must be a list of image snapshot ids" };
	}
	const ids = [...new Set(value as string[])];
	if (ids.length > MAX_ANSWER_ATTACHMENTS) {
		return { ids: [], problem: `an answer can carry at most ${MAX_ANSWER_ATTACHMENTS} photos` };
	}
	return { ids };
}

/** The ids a saved message carries (an answer result or a thinking marker). */
export function attachmentIdsOf(message: unknown): string[] {
	const details = (message as { details?: unknown } | null)?.details;
	const raw = (details as { attachments?: unknown } | null | undefined)?.attachments;
	if (!Array.isArray(raw)) return [];
	return raw.filter((id): id is string => typeof id === "string" && SNAPSHOT_ID_PATTERN.test(id));
}

/** Server-side existence check: every id must be in the session's pool.
 *  Returns the first problem, or null. */
export function missingAttachment(ids: readonly string[], pool: ImagePool | undefined): string | null {
	const missing = ids.find((id) => !pool || !Object.hasOwn(pool, id));
	return missing ? "an attached photo was not uploaded to this session" : null;
}

/** The image blocks for a message's attachments. An id with no snapshot
 *  contributes a text note instead, so the model is never silently shown
 *  fewer pictures than the learner sent. */
export function attachmentBlocks(
	message: unknown,
	pool: ImagePool | undefined,
): Array<AttachmentImageBlock | { type: "text"; text: string }> {
	return attachmentIdsOf(message).flatMap((id) => {
		const image = pool && Object.hasOwn(pool, id) ? pool[id] : undefined;
		if (!image) return [{ type: "text" as const, text: "[An attached photo is no longer available.]" }];
		return [
			// A canvas drawing: its outline goes in front of its picture.
			...(image.outline ? [{ type: "text" as const, text: image.outline }] : []),
			{ type: "image" as const, data: image.data, mimeType: image.mimeType },
		];
	});
}

export function hasPhotoAnswers(messages: readonly unknown[]): boolean {
	return messages.some((message) => attachmentIdsOf(message).length > 0);
}

/** How a photo-only practice submission reads in the marker's text. */
export function photoOnlyText(count: number): string {
	return count === 1 ? "(See the attached photo.)" : `(See the ${count} attached photos.)`;
}

/**
 * The tutor's photo rule (wording approved by the owner, 2026-11-10).
 * Appended to the prompt only for sessions that contain a photo answer.
 */
export const PHOTO_ANSWER_RULE = [
	"# Photos of the learner's work",
	"The learner can answer with photos of handwritten or drawn work. They arrive as images beside the answer.",
	"Before you judge a photo answer, restate in one or two lines what you read from it: the key steps, the values and the final answer as you understood them. Then judge that reading. If part of the image is unclear or cut off, say which part and ask about it. Never mark work wrong on a guess at what it says.",
	DRAWING_RULE,
	PLOT_RULE,
].join("\n\n");

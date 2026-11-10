/**
 * Material conversion (fork, phase 3a): one stored original → the parts of
 * its transcript, one converter per format. Text read directly from the
 * file and text a vision model read from a picture are kept apart, because
 * only the second kind waits for the learner's review.
 */

import * as fs from "node:fs/promises";
import { convertPdf } from "../../agent/subagents/pdf-ops.ts";
import { getHeadless } from "../../agent/subagents/headless.ts";
import type { MaterialFormat } from "../../core/contracts.ts";
import type { TranscriptPart } from "../../core/material.ts";
import { DocumentError, MAX_DOCUMENT_PICTURES, readDocument } from "./docx.ts";
import { DeckError, MAX_DECK_PICTURES, readDeck } from "./pptx.ts";
import type { Transcriber } from "./transcribe.ts";

export interface Conversion {
	parts: TranscriptPart[];
	notice?: string;
}

/** A refusal the learner can act on (shown as the material's error). */
export class ConversionError extends Error {}

const MAX_PDF_PAGES = 1000;
/** Scanned pages sent to the vision model per PDF. */
export const MAX_SCANNED_PAGES = 40;
const SCAN_DPI = 150;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

async function convertText(path: string): Promise<Conversion> {
	const text = (await fs.readFile(path, "utf-8")).trim();
	if (!text) throw new ConversionError("The file has no text.");
	return { parts: [{ label: "Notes", text, aiRead: [] }] };
}

async function convertImage(path: string, transcribe: Transcriber, signal?: AbortSignal): Promise<Conversion> {
	const text = await transcribe(await fs.readFile(path), "Photo", signal);
	if (!text) throw new ConversionError("Nothing could be read from this photo.");
	return { parts: [{ label: "Photo", text: "", aiRead: [text] }] };
}

async function convertDeck(path: string, transcribe: Transcriber, signal?: AbortSignal): Promise<Conversion> {
	let deck;
	try {
		deck = readDeck(await fs.readFile(path));
	} catch (error) {
		if (error instanceof DeckError) throw new ConversionError(error.message);
		throw error;
	}
	const parts: TranscriptPart[] = [];
	for (const slide of deck.slides) {
		const aiRead: string[] = [];
		for (const [index, picture] of slide.pictures.entries()) {
			signal?.throwIfAborted();
			const label = `Slide ${slide.number}, picture ${index + 1}`;
			aiRead.push(await transcribe(picture.bytes, label, signal));
		}
		const text = [slide.text, slide.notes ? `Speaker notes:\n${slide.notes}` : ""].filter(Boolean).join("\n\n");
		parts.push({ label: `Slide ${slide.number}`, text, aiRead });
	}
	if (!parts.some((part) => part.text.trim() || part.aiRead.some((t) => t.trim()))) {
		throw new ConversionError("No text or readable pictures were found in this deck. If its slides are images, export it to PDF and upload that.");
	}
	return {
		parts,
		...(deck.skippedPictures > 0
			? { notice: `${plural(deck.skippedPictures, "picture was", "pictures were")} not read (logos, icons, unsupported formats, or over the ${MAX_DECK_PICTURES}-picture limit).` }
			: {}),
	};
}

async function convertDocument(path: string, transcribe: Transcriber, signal?: AbortSignal): Promise<Conversion> {
	let document;
	try {
		document = readDocument(await fs.readFile(path));
	} catch (error) {
		if (error instanceof DocumentError) throw new ConversionError(error.message);
		throw error;
	}
	const parts: TranscriptPart[] = [{ label: "Document", text: document.text, aiRead: [] }];
	for (const [index, picture] of document.pictures.entries()) {
		signal?.throwIfAborted();
		const label = `Picture ${index + 1}`;
		parts.push({ label, text: "", aiRead: [await transcribe(picture.bytes, label, signal)] });
	}
	if (!parts.some((part) => part.text.trim() || part.aiRead.some((t) => t.trim()))) {
		throw new ConversionError("No text or readable pictures were found in this document.");
	}
	return {
		parts,
		...(document.skippedPictures > 0
			? { notice: `${plural(document.skippedPictures, "picture was", "pictures were")} not read (icons, unsupported formats, or over the ${MAX_DOCUMENT_PICTURES}-picture limit).` }
			: {}),
	};
}

async function convertPdfFile(path: string, transcribe: Transcriber, signal?: AbortSignal): Promise<Conversion> {
	// pdfjs refuses a Node Buffer; it wants a plain Uint8Array.
	const pdf = await convertPdf(new Uint8Array(await fs.readFile(path)), MAX_PDF_PAGES);
	if (pdf.kind === "unreadable") throw new ConversionError("Could not open this PDF.");
	if (pdf.kind === "too-long") throw new ConversionError("Too long. Max 1,000 pages.");
	const scanned = pdf.pages.filter((page) => page.kind === "image-only").map((page) => page.number);
	const toRead = scanned.slice(0, MAX_SCANNED_PAGES);
	const transcripts = new Map<number, string>();
	for (const pageNumber of toRead) {
		signal?.throwIfAborted();
		// One page per render keeps memory flat on long scans.
		const [rendered] = await getHeadless().renderPdfPages(path, [pageNumber], { dpi: SCAN_DPI });
		if (rendered) transcripts.set(pageNumber, await transcribe(rendered.png, `Page ${pageNumber}`, signal));
	}
	const parts: TranscriptPart[] = pdf.pages.map((page) => ({
		label: `Page ${page.number}`,
		text: page.kind === "text" ? page.markdown : "",
		aiRead: transcripts.has(page.number) ? [transcripts.get(page.number)!] : [],
	}));
	if (!parts.some((part) => part.text.trim() || part.aiRead.some((t) => t.trim()))) {
		throw new ConversionError("No text could be read from this PDF.");
	}
	const unread = scanned.length - toRead.length;
	return {
		parts,
		...(unread > 0 ? { notice: `${plural(unread, "scanned page was", "scanned pages were")} not read (limit ${MAX_SCANNED_PAGES} per PDF).` } : {}),
	};
}

export async function convertMaterial(format: MaterialFormat, originalPath: string, transcribe: Transcriber, signal?: AbortSignal): Promise<Conversion> {
	switch (format) {
		case "text":
			return convertText(originalPath);
		case "image":
			return convertImage(originalPath, transcribe, signal);
		case "pptx":
			return convertDeck(originalPath, transcribe, signal);
		case "docx":
			return convertDocument(originalPath, transcribe, signal);
		case "pdf":
			return convertPdfFile(originalPath, transcribe, signal);
		case "epub":
			throw new ConversionError("Books (EPUB) are not supported yet.");
	}
}

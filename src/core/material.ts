/**
 * Material domain logic (fork, phase 3a): pure helpers — format detection,
 * the graph source path, and transcript assembly. No IO.
 */

import type { MaterialFormat } from "./contracts/material.ts";

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) => magic.every((b, i) => bytes[at + i] === b);
const ascii = (bytes: Uint8Array, from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** ISO-BMFF `ftyp` brand check — the iPhone camera's default container. */
export function isHeifBytes(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 12 && ascii(bytes, 4, 4) === "ftyp" && HEIF_BRANDS.has(ascii(bytes, 8, 4));
}

function isImageBytes(bytes: Uint8Array): boolean {
	return (
		startsWith(bytes, [0xff, 0xd8, 0xff]) || // jpeg
		startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || // png
		startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) || // gif
		startsWith(bytes, [0x42, 0x4d]) || // bmp
		(startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") ||
		isHeifBytes(bytes)
	);
}

export type FormatVerdict = { format: MaterialFormat } | { refused: string };

/**
 * What an upload is, by its bytes first and its name second. A name can
 * lie; a zip is only a deck when it is named one (docx/xlsx/epub are zips
 * too), and plain text has no signature at all.
 */
export function detectMaterialFormat(fileName: string, bytes: Uint8Array): FormatVerdict {
	const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
	if (bytes.byteLength === 0) return { refused: "The file is empty." };
	if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { format: "pdf" };
	if (isImageBytes(bytes)) return { format: "image" };
	if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
		return { refused: "Old Office files (.ppt, .doc) are not supported. Open it in Keynote or PowerPoint and export it as .pptx or PDF." };
	}
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
		if (ext === "pptx") return { format: "pptx" };
		if (ext === "epub") return { refused: "Books (EPUB) are not supported yet." };
		return { refused: "This file type is not supported. Upload a PowerPoint (.pptx), PDF, photo or text file." };
	}
	if (["md", "markdown", "txt"].includes(ext)) {
		return bytes.includes(0) ? { refused: "This does not look like a text file." } : { format: "text" };
	}
	return { refused: "This file type is not supported. Upload a PowerPoint (.pptx), PDF, photo or text file." };
}

/** One path segment safe for the graph's source paths (no separators,
 *  control characters or dot-only names). */
function pathSegment(value: string, fallback: string): string {
	const cleaned = value.replace(/[\\/:\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
	return cleaned === "" || /^\.+$/.test(cleaned) ? fallback : cleaned.slice(0, 200);
}

/** The graph source path for a material: `<course>/<file>`. The source's
 *  identity is a hash of this path, and the source browser files it under
 *  a folder named after the course. */
export function materialSourcePath(courseTitle: string, fileName: string): string {
	return `${pathSegment(courseTitle, "Course")}/${pathSegment(fileName, "material")}`;
}

/** The display title: the file name without its extension. */
export function materialTitle(fileName: string): string {
	return fileName.replace(/\.[A-Za-z0-9]+$/, "").trim() || fileName;
}

/** One converted part of a material, in reading order. */
export interface TranscriptPart {
	/** "Slide 3", "Page 12", "Photo". */
	label: string;
	/** Text read directly from the file. */
	text: string;
	/** Text a vision model read from a picture or a scanned page. */
	aiRead: string[];
}

/** The marker put above every AI-read passage in the transcript, so review
 *  can find them. Removed before extraction. */
export const AI_READ_MARK = "> [AI-read — check against the original]";

/** The transcript the learner reviews and the extractor reads. */
export function assembleTranscript(parts: readonly TranscriptPart[]): { text: string; aiReadParts: number } {
	let aiReadParts = 0;
	const blocks: string[] = [];
	for (const part of parts) {
		const body = [part.text.trim(), ...part.aiRead.map((t) => t.trim()).filter(Boolean).map((t) => {
			aiReadParts++;
			return `${AI_READ_MARK}\n\n${t}`;
		})].filter(Boolean);
		if (body.length > 0) blocks.push(`## ${part.label}\n\n${body.join("\n\n")}`);
	}
	return { text: blocks.join("\n\n"), aiReadParts };
}

/** The transcript as the extractor should read it: review markers gone. */
export function transcriptForExtraction(text: string): string {
	return text.split("\n").filter((line) => line.trim() !== AI_READ_MARK).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The vision model's instructions for one image of study material
 * (wording approved by the owner, 2026-11-10).
 */
export const TRANSCRIBE_INSTRUCTIONS = [
	"Transcribe this image of study material exactly.",
	[
		"- Copy all text as written, keeping its order and structure. Use Markdown headings and lists where the page has them.",
		"- Write mathematics in LaTeX between $ signs.",
		"- Describe each diagram, graph or figure in one or two sentences inside [Figure: ...], including its labels and what it shows.",
		"- Where a word, symbol or number is unclear, write your best reading followed by [?]. Never guess silently and never fill gaps from your own knowledge.",
		"- Do not correct mistakes, add explanations or summarise.",
	].join("\n"),
	"Reply with the transcription only.",
].join("\n\n");

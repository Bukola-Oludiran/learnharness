/**
 * Material domain logic (fork, phase 3a): pure helpers — format detection,
 * the graph source path, and transcript assembly. No IO.
 */

import { MAX_BOOK_BYTES, MAX_MATERIAL_BYTES, type MaterialFormat, type MaterialRecord } from "./contracts/material.ts";

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

const OLD_OFFICE_REFUSAL = "Old Office files (.ppt, .doc) are not supported. Open it in PowerPoint, Word, Keynote or Pages and export it as .pptx, .docx or PDF.";
const UNSUPPORTED_REFUSAL = "This file type is not supported. Upload a PowerPoint (.pptx), Word (.docx), PDF, photo or text file.";

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
		return { refused: OLD_OFFICE_REFUSAL };
	}
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
		if (ext === "pptx") return { format: "pptx" };
		if (ext === "docx") return { format: "docx" };
		if (ext === "epub") return { format: "epub" };
		return { refused: UNSUPPORTED_REFUSAL };
	}
	if (["md", "markdown", "txt"].includes(ext)) {
		return bytes.includes(0) ? { refused: "This does not look like a text file." } : { format: "text" };
	}
	return { refused: UNSUPPORTED_REFUSAL };
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

const MAX_SOURCE_FOLDERS = 8;

/** The graph source path for a library upload: the file's own folder path
 *  when it came from a folder upload (`Stats 201/Week 2.pdf`), otherwise
 *  the bare file name, which the source browser files at its root. */
export function librarySourcePath(relativePath: string | null | undefined, fileName: string): string {
	const segments = (relativePath ?? "").split(/[\\/]/).map((segment) => pathSegment(segment, "")).filter(Boolean);
	// The last segment of a relative path is the file itself.
	return [...segments.slice(0, -1).slice(-MAX_SOURCE_FOLDERS), pathSegment(fileName, "material")].join("/");
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];
const NOTES_EXTENSIONS = ["pptx", "docx", "pdf", "md", "markdown", "txt", ...IMAGE_EXTENSIONS];
const BOOK_EXTENSIONS = ["pdf", "epub"];
/** A file name that says "this is a test paper" (words approved by the owner, 2026-11-10). */
const TEST_NAME = /(^|[^a-z])(tests?|exams?|quiz|quizzes|midterms?|finals?|papers?|marked)([^a-z]|$)/i;

export type FolderChoice = "notes" | "test" | "book" | "skip";

export interface FolderFileVerdict {
	/** The pre-selected choice; the learner can change it. */
	choice: FolderChoice;
	/** Whether "Marked test" can be chosen (photos and PDFs only). */
	testable: boolean;
	/** Whether "Book" can be chosen (PDF and EPUB only). */
	bookable: boolean;
	/** Set when the file cannot be uploaded at all; it is listed greyed out. */
	refused?: string;
}

/**
 * The folder checklist's verdict on one file, from its name and size alone
 * — nothing has been read yet. The server still checks the bytes at upload.
 */
export function folderFileVerdict(fileName: string, size: number): FolderFileVerdict {
	const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
	const refuse = (refused: string): FolderFileVerdict => ({ choice: "skip", testable: false, bookable: false, refused });
	if (fileName.startsWith(".") || fileName.startsWith("~$")) return refuse("Hidden or temporary file.");
	if (ext === "ppt" || ext === "doc") return refuse("Old Office file. Export it as .pptx, .docx or PDF.");
	const bookable = BOOK_EXTENSIONS.includes(ext);
	if (!bookable && !NOTES_EXTENSIONS.includes(ext)) return refuse("Not a supported file type.");
	if (size === 0) return refuse("The file is empty.");
	if (size > (bookable ? MAX_BOOK_BYTES : MAX_MATERIAL_BYTES)) return refuse(bookable ? "Too big. Max 200 MB." : "Too big. Max 25 MB.");
	// An EPUB is always a book; a PDF too big for notes can only be one.
	if (ext === "epub" || size > MAX_MATERIAL_BYTES) return { choice: "book", testable: false, bookable: true };
	const testable = ext === "pdf" || IMAGE_EXTENSIONS.includes(ext);
	return { choice: testable && TEST_NAME.test(materialTitle(fileName)) ? "test" : "notes", testable, bookable };
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

/** What one material's state reads as to the tutor (`material_status`). */
export function materialStatusLine(material: Pick<MaterialRecord, "title" | "kind" | "status" | "stage" | "error" | "score" | "pendingChoice"> & { interrupted?: boolean }): string {
	const head = `- ${material.title} (${material.kind === "test" ? "marked test" : material.kind})`;
	if (material.interrupted) return `${head}: interrupted when the app closed. The learner can retry it in the Library.`;
	switch (material.status) {
		case "processing":
			return `${head}: ${material.stage === "queued" ? "waiting its turn" : "being processed"}.`;
		case "review":
			if (material.pendingChoice) return `${head}: it is long; the learner must choose in the Library whether to add it as a book or extract it as notes.`;
			return `${head}: waiting for the learner's review in the Library.`;
		case "ready":
			if (material.kind === "book") return `${head}: stored and split into sections; read it with read_material.`;
			if (material.kind !== "test") return `${head}: in the graph.`;
			return `${head}: results recorded${material.score ? `, score ${material.score.earned}/${material.score.possible}` : ""}.`;
		case "failed":
			return `${head}: failed. ${material.error ?? "Something went wrong."} The learner can retry it in the Library.`;
	}
}

/** The tutor's `ingest_material` result: what started, and what was refused. */
export function ingestResultText(started: readonly { name: string; id: string }[], refused: readonly { name: string; error: string }[]): string {
	const blocks: string[] = [];
	if (started.length > 0) {
		blocks.push(
			[`Started adding ${started.length} ${started.length === 1 ? "file" : "files"} to the learner's library:`, ...started.map((s) => `- ${s.name} (id ${s.id}): processing.`)].join("\n"),
		);
	}
	if (refused.length > 0) blocks.push(["Not added:", ...refused.map((r) => `- ${r.name}: ${r.error}`)].join("\n"));
	return blocks.join("\n\n");
}

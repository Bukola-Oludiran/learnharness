/**
 * Word (.docx) → text and pictures (fork, phase 3b2). A document is a zip
 * of XML: word/document.xml holds the body, its relationships name the
 * pictures. Paragraphs, headings and table rows come out directly as
 * Markdown; pictures are handed back for the vision model, as a deck's are.
 */

import { decodeXml } from "./pptx.ts";
import { readZipEntries, readZipEntry, ZipError, type ZipEntry } from "./zip.ts";

export interface DocumentPicture {
	/** The media file's path in the document (word/media/image1.png). */
	name: string;
	bytes: Uint8Array;
}

export interface WordDocument {
	/** The body as Markdown. */
	text: string;
	/** Pictures in the order the body uses them. */
	pictures: DocumentPicture[];
	/** Pictures left out: tiny icons, unsupported formats, or over the cap. */
	skippedPictures: number;
}

export class DocumentError extends Error {}

const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_PICTURE_BYTES = 25 * 1024 * 1024;
/** Below this a picture is an icon, bullet or logo, not content. */
const MIN_PICTURE_BYTES = 15 * 1024;
export const MAX_DOCUMENT_PICTURES = 40;
const PICTURE_EXTENSIONS = /\.(png|jpe?g|gif|bmp|webp)$/i;

/** One paragraph's text: runs joined, tabs and line breaks kept, equation text included. */
function paragraphText(xml: string): string {
	return [...xml.matchAll(/<(?:w|m):t\b[^>]*>([\s\S]*?)<\/(?:w|m):t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g)]
		.map((m) => (m[1] !== undefined ? decodeXml(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n"))
		.join("")
		.trim();
}

/** A paragraph as a Markdown line: `Heading2` → `## …`, `Title` → `# …`. */
function paragraphLine(xml: string): string {
	const text = paragraphText(xml);
	if (!text) return "";
	const style = /<w:pStyle\b[^>]*\bw:val="([^"]*)"/.exec(xml)?.[1] ?? "";
	if (/^title$/i.test(style)) return `# ${text}`;
	const heading = /^heading\s?([1-6])$/i.exec(style);
	return heading ? `${"#".repeat(Number(heading[1]))} ${text}` : text;
}

/** A table as Markdown rows; a nested table's text stays inside its cell. */
function tableLines(xml: string): string[] {
	return (xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [])
		.map((row) =>
			(row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [])
				.map((cell) => (cell.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []).map(paragraphText).filter(Boolean).join(" "))
				.join(" | "),
		)
		.filter((line) => line.replace(/[|\s]/g, "") !== "")
		.map((line) => `| ${line} |`);
}

/** The body's blocks in reading order: top-level paragraphs and whole tables. */
export function documentText(xml: string): string {
	const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
	const blocks: string[] = [];
	let depth = 0;
	let tableStart = 0;
	// A table is taken whole, so its paragraphs are not also read as body text.
	for (const token of body.matchAll(/<w:tbl\b[^>]*>|<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
		if (token[0].startsWith("<w:tbl")) {
			if (depth++ === 0) tableStart = token.index;
		} else if (token[0] === "</w:tbl>") {
			if (depth > 0 && --depth === 0) {
				const rows = tableLines(body.slice(tableStart, token.index));
				if (rows.length > 0) blocks.push(rows.join("\n"));
			}
		} else if (depth === 0) {
			const line = paragraphLine(token[0]);
			if (line) blocks.push(line);
		}
	}
	return blocks.join("\n\n");
}

export function readDocument(bytes: Uint8Array): WordDocument {
	let entries: ZipEntry[];
	try {
		entries = readZipEntries(bytes);
	} catch {
		throw new DocumentError("Could not open this Word file.");
	}
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const decoder = new TextDecoder();
	const xml = (name: string): string | null => {
		const entry = byName.get(name);
		if (!entry) return null;
		try {
			return decoder.decode(readZipEntry(bytes, entry, MAX_XML_BYTES));
		} catch (error) {
			if (error instanceof ZipError) return null;
			throw error;
		}
	};
	const body = xml("word/document.xml");
	if (body === null) throw new DocumentError("Could not open this Word file.");

	// Picture relationship id → media path; the body's r:embed order is reading order.
	const targets = new Map(
		[...(xml("word/_rels/document.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => {
			const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]!)?.[1] ?? "";
			const target = decodeXml(attr("Target"));
			return [attr("Id"), target.startsWith("/") ? target.slice(1) : `word/${target}`] as const;
		}),
	);
	const media = [...new Set([...body.matchAll(/\br:embed="([^"]+)"/g)].map((m) => targets.get(m[1]!)).filter((t): t is string => t !== undefined))];
	const pictures: DocumentPicture[] = [];
	let skippedPictures = 0;
	for (const name of media) {
		const entry = byName.get(name);
		const usable =
			entry !== undefined &&
			PICTURE_EXTENSIONS.test(name) &&
			entry.uncompressedSize >= MIN_PICTURE_BYTES &&
			entry.uncompressedSize <= MAX_PICTURE_BYTES;
		if (!usable || pictures.length >= MAX_DOCUMENT_PICTURES) {
			skippedPictures++;
			continue;
		}
		try {
			pictures.push({ name, bytes: readZipEntry(bytes, entry, MAX_PICTURE_BYTES) });
		} catch {
			skippedPictures++;
		}
	}
	return { text: documentText(body), pictures, skippedPictures };
}

/**
 * PowerPoint (.pptx) → slides (fork, phase 3a). A deck is a zip of XML:
 * ppt/presentation.xml orders the slides, each slide's relationships name
 * its speaker-notes page and its pictures. Slide text and notes come out
 * directly; pictures are handed back for the vision model.
 */

import { readZipEntries, readZipEntry, ZipError, type ZipEntry } from "./zip.ts";

export interface SlidePicture {
	/** The media file's path in the deck (ppt/media/image3.png). */
	name: string;
	bytes: Uint8Array;
}

export interface Slide {
	number: number;
	text: string;
	notes: string;
	pictures: SlidePicture[];
}

export interface Deck {
	slides: Slide[];
	/** Pictures left out: template art, tiny icons, unsupported formats, or over the cap. */
	skippedPictures: number;
}

export class DeckError extends Error {}

const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_PICTURE_BYTES = 25 * 1024 * 1024;
/** Below this a picture is an icon, bullet or logo, not content. */
const MIN_PICTURE_BYTES = 15 * 1024;
/** A picture on more slides than this is template art (a logo, a footer). */
const MAX_PICTURE_REUSE = 3;
export const MAX_DECK_PICTURES = 40;
const PICTURE_EXTENSIONS = /\.(png|jpe?g|gif|bmp|webp)$/i;

function decodeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&amp;/g, "&");
}

/** The text of one slide or notes page: one line per paragraph, runs joined. */
export function paragraphsOf(xml: string): string[] {
	const paragraphs: string[] = [];
	for (const paragraph of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
		// A line break inside a paragraph is <a:br/>; a field (slide number, date) is <a:fld>.
		const line = [...paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)]
			.map((m) => (m[1] === undefined ? "\n" : decodeXml(m[1])))
			.join("")
			.trim();
		if (line) paragraphs.push(line);
	}
	return paragraphs;
}

/** Relationship id → target, for one .rels file. */
function relationships(xml: string): { id: string; type: string; target: string }[] {
	return [...xml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => {
		const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]!)?.[1] ?? "";
		return { id: attr("Id"), type: attr("Type"), target: decodeXml(attr("Target")) };
	});
}

/** Resolve a relationship target against the part that declares it. */
function resolveTarget(fromPart: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = fromPart.split("/").slice(0, -1);
	for (const segment of target.split("/")) {
		if (segment === "..") parts.pop();
		else if (segment !== "." && segment !== "") parts.push(segment);
	}
	return parts.join("/");
}

const relsPathOf = (part: string) => part.replace(/([^/]+)$/, "_rels/$1.rels");

export function readDeck(bytes: Uint8Array): Deck {
	let entries: ZipEntry[];
	try {
		entries = readZipEntries(bytes);
	} catch {
		throw new DeckError("Could not open this PowerPoint file.");
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

	// Slide order: presentation.xml's sldIdLst, resolved through its rels.
	// A deck missing either falls back to the slide files' numeric order.
	const presentation = xml("ppt/presentation.xml");
	const presentationRels = new Map(relationships(xml("ppt/_rels/presentation.xml.rels") ?? "").map((r) => [r.id, r.target]));
	let slideParts = [...(presentation ?? "").matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
		.map((m) => presentationRels.get(m[1]!))
		.filter((target): target is string => target !== undefined)
		.map((target) => resolveTarget("ppt/presentation.xml", target))
		.filter((part) => byName.has(part));
	if (slideParts.length === 0) {
		slideParts = entries
			.map((entry) => entry.name)
			.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
			.sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
	}
	if (slideParts.length === 0) throw new DeckError("This PowerPoint file has no slides.");

	const perSlide = slideParts.map((part) => {
		const rels = relationships(xml(relsPathOf(part)) ?? "");
		const notesPart = rels.find((r) => r.type.endsWith("/notesSlide"));
		const notes = notesPart ? paragraphsOf(xml(resolveTarget(part, notesPart.target)) ?? "") : [];
		return {
			text: paragraphsOf(xml(part) ?? "").join("\n"),
			// The notes page repeats the slide number as a lone-digits field.
			notes: notes.filter((line) => !/^\d+$/.test(line)).join("\n"),
			media: [...new Set(rels.filter((r) => r.type.endsWith("/image")).map((r) => resolveTarget(part, r.target)))],
		};
	});

	const uses = new Map<string, number>();
	for (const slide of perSlide) for (const media of slide.media) uses.set(media, (uses.get(media) ?? 0) + 1);
	let skippedPictures = 0;
	let taken = 0;
	const slides: Slide[] = perSlide.map((slide, index) => {
		const pictures: SlidePicture[] = [];
		for (const media of slide.media) {
			const entry = byName.get(media);
			const usable =
				entry !== undefined &&
				PICTURE_EXTENSIONS.test(media) &&
				entry.uncompressedSize >= MIN_PICTURE_BYTES &&
				entry.uncompressedSize <= MAX_PICTURE_BYTES &&
				(uses.get(media) ?? 0) <= MAX_PICTURE_REUSE;
			if (!usable || taken >= MAX_DECK_PICTURES) {
				skippedPictures++;
				continue;
			}
			try {
				pictures.push({ name: media, bytes: readZipEntry(bytes, entry, MAX_PICTURE_BYTES) });
				taken++;
			} catch {
				skippedPictures++;
			}
		}
		return { number: index + 1, text: slide.text, notes: slide.notes, pictures };
	});
	return { slides, skippedPictures };
}

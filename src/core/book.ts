/**
 * Book domain logic (fork, phase 4a — see FORK.md): pure helpers. A book is
 * stored as numbered pages (PDF pages, or an EPUB's chapter files) plus
 * sections that are page ranges. It is read section by section and never
 * sent to a model whole. No IO.
 */

import type { BookPage, MaterialRecord, MaterialSection } from "./contracts/material.ts";
import { AI_READ_MARK } from "./material.ts";

/** One table-of-contents entry: where a part begins. */
export interface OutlineEntry {
	title: string;
	/** 1 = chapter, 2 = section within it. Deeper levels are dropped. */
	level: number;
	/** The page it starts on, 1-based. */
	page: number;
}

export const FIXED_SECTION_PAGES = 20;
const MAX_SECTION_LEVEL = 2;
const MAX_SECTIONS = 1500;
/** Above this many entries, sub-sections are dropped: an anthology's
 *  contents can run to thousands of lines. */
const MAX_TWO_LEVEL_SECTIONS = 400;
/** Characters of section text one `read_material` call returns. */
export const SECTION_PART_CHARS = 24_000;

const cleanTitle = (title: string) => title.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Sections from a table of contents. A level-1 section runs to the page
 * before the next level-1 start; a level-2 section to the page before the
 * next entry of either level. Pages before the first entry become "Front
 * matter". Two entries on one page share that page.
 */
export function sectionsFromOutline(entries: readonly OutlineEntry[], pageCount: number): MaterialSection[] {
	const cleaned = entries
		.map((entry) => ({ title: cleanTitle(entry.title), level: Math.max(1, Math.floor(entry.level)), page: Math.floor(entry.page) }))
		.filter((entry) => entry.title !== "" && entry.level <= MAX_SECTION_LEVEL && entry.page >= 1 && entry.page <= pageCount);
	const usable = cleaned.length > MAX_TWO_LEVEL_SECTIONS && cleaned.some((entry) => entry.level === 1) ? cleaned.filter((entry) => entry.level === 1) : cleaned;
	// Past the cap the contents are not a usable split; the caller falls back.
	if (usable.length > MAX_SECTIONS) return [];
	// A table of contents is in reading order; one that is not is unusable.
	for (let i = 1; i < usable.length; i++) if (usable[i]!.page < usable[i - 1]!.page) return [];
	if (usable.length === 0) return [];
	// A book whose first entry is a sub-section has no chapter to hang it on.
	if (usable[0]!.level !== 1) for (const entry of usable) entry.level = 1;
	const sections: MaterialSection[] = [];
	if (usable[0]!.page > 1) sections.push({ id: "s0", title: "Front matter", level: 1, pageStart: 1, pageEnd: usable[0]!.page - 1 });
	let chapter = 0;
	let sub = 0;
	for (const [index, entry] of usable.entries()) {
		const next = usable.slice(index + 1).find((later) => later.level <= entry.level);
		const pageEnd = Math.max(entry.page, (next ? next.page : pageCount + 1) - 1);
		if (entry.level === 1) {
			chapter++;
			sub = 0;
		} else sub++;
		sections.push({ id: entry.level === 1 ? `s${chapter}` : `s${chapter}.${sub}`, title: entry.title, level: entry.level, pageStart: entry.page, pageEnd });
	}
	return sections;
}

/** The last resort: equal runs of pages. */
export function fixedSections(pageCount: number, size = FIXED_SECTION_PAGES): MaterialSection[] {
	const sections: MaterialSection[] = [];
	for (let start = 1; start <= pageCount; start += size) {
		const end = Math.min(pageCount, start + size - 1);
		sections.push({ id: `s${sections.length + 1}`, title: start === end ? `Page ${start}` : `Pages ${start}–${end}`, level: 1, pageStart: start, pageEnd: end });
	}
	return sections;
}

/** The cheap model's instructions when a PDF has no bookmarks (wording
 *  approved by the owner, 2026-11-10). */
export const CHAPTER_SPLIT_INSTRUCTIONS = [
	"Below are the first lines of each page of a book. Find where its chapters or main parts begin.",
	"Reply with one line per chapter, in order: the page number, a tab, then the chapter title as printed. " +
		"Include front matter and back matter only if they are substantial (a preface, an appendix). Do not list sub-sections. " +
		"If you cannot tell where chapters begin, reply with the single word NONE.",
].join("\n\n");

const HEAD_CHARS = 160;
const MAX_HEADS_CHARS = 240_000;

/** What the chapter proposer reads: each text page's opening lines. Null
 *  when the book has too little text to judge (a scanned book). */
export function pageHeads(pages: readonly BookPage[]): string | null {
	const withText = pages.filter((page) => page.kind === "text" && page.text.trim() !== "");
	if (withText.length < Math.max(3, pages.length / 2)) return null;
	const per = Math.max(60, Math.min(HEAD_CHARS, Math.floor(MAX_HEADS_CHARS / withText.length)));
	return withText.map((page) => `--- Page ${page.n} ---\n${page.text.trim().replace(/\s*\n\s*/g, " / ").slice(0, per)}`).join("\n");
}

/** The proposer's reply as outline entries; empty when it declined or the
 *  reply is unusable (fewer than two chapters is not a split). */
export function parseChapterLines(reply: string, pageCount: number): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	for (const line of reply.split("\n")) {
		const match = /^\s*(?:page\s*)?(\d{1,5})\s*[\t:.)-]\s*(.+?)\s*$/i.exec(line);
		if (!match) continue;
		const page = Number(match[1]);
		if (page < 1 || page > pageCount || (entries.length > 0 && page <= entries.at(-1)!.page)) continue;
		entries.push({ title: match[2]!, level: 1, page });
	}
	return entries.length >= 2 ? entries : [];
}

const unitOf = (book: Pick<MaterialRecord, "format">) => (book.format === "epub" ? "chapter file" : "page");
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const range = (section: MaterialSection, unit: string) =>
	section.pageStart === section.pageEnd ? `${unit} ${section.pageStart}` : `${unit}s ${section.pageStart}–${section.pageEnd}`;

/** `read_material` with no arguments: the learner's books. */
export function bookListText(books: readonly Pick<MaterialRecord, "id" | "title" | "status" | "sections" | "pageCount" | "format">[]): string {
	if (books.length === 0) return "The learner has no books in their library.";
	return books
		.map((book) =>
			book.status === "ready"
				? `- ${book.title} (id ${book.id}): ${count(book.sections.length, "section")}, ${count(book.pageCount ?? 0, unitOf(book))}.`
				: `- ${book.title} (id ${book.id}): not ready yet (${book.status}).`,
		)
		.join("\n");
}

/** `read_material` with a book: its sections. */
export function bookContentsText(book: Pick<MaterialRecord, "id" | "title" | "sections" | "format">): string {
	const unit = unitOf(book);
	return [
		`Sections of "${book.title}" (id ${book.id}):`,
		...book.sections.map((section) => `${section.level > 1 ? "  " : ""}- [${section.id}] ${section.title} (${range(section, unit)})`),
	].join("\n");
}

export interface SectionRead {
	text: string;
	/** Scanned pages of this section no vision model has read yet. */
	pending: number[];
}

/**
 * One part of a section, for the tutor. Pages are headed `--- Page N ---`;
 * AI-read pages carry the review mark. Parts break at page boundaries
 * where they can; a single page longer than a part is cut.
 */
export function sectionText(
	book: Pick<MaterialRecord, "title" | "format">,
	section: MaterialSection,
	pages: readonly BookPage[],
	transcripts: ReadonlyMap<number, string>,
	part = 1,
): SectionRead {
	const unit = book.format === "epub" ? "Chapter file" : "Page";
	const inRange = pages.filter((page) => page.n >= (section.pageStart ?? 1) && page.n <= (section.pageEnd ?? Infinity));
	const pending: number[] = [];
	const blocks: string[] = [];
	for (const page of inRange) {
		let body = page.text.trim();
		if (page.kind === "scanned") {
			const read = transcripts.get(page.n);
			if (read === undefined) {
				pending.push(page.n);
				continue;
			}
			body = read.trim() ? `${AI_READ_MARK}\n\n${read.trim()}` : "";
		}
		if (!body) continue;
		for (let at = 0; at < body.length; at += SECTION_PART_CHARS) {
			blocks.push(`--- ${unit} ${page.n}${at > 0 ? " (continued)" : ""} ---\n\n${body.slice(at, at + SECTION_PART_CHARS)}`);
		}
	}
	const parts: string[][] = [[]];
	let size = 0;
	for (const block of blocks) {
		if (size > 0 && size + block.length > SECTION_PART_CHARS) {
			parts.push([]);
			size = 0;
		}
		parts.at(-1)!.push(block);
		size += block.length;
	}
	const index = Math.min(Math.max(1, Math.floor(part)), parts.length);
	const head = `"${book.title}" — [${section.id}] ${section.title}${parts.length > 1 ? ` (part ${index} of ${parts.length})` : ""}`;
	const notes: string[] = [];
	if (pending.length > 0) {
		notes.push(
			`${count(pending.length, "scanned page")} of this section ${pending.length === 1 ? "is" : "are"} still being read (${unit.toLowerCase()}s ${pending.slice(0, 12).join(", ")}${pending.length > 12 ? ", …" : ""}). ` +
				"Tell the learner, and call again shortly for the complete text.",
		);
	}
	if (index < parts.length) notes.push(`This is part ${index} of ${parts.length}. Call again with part ${index + 1} for the next.`);
	const body = parts[index - 1]!.join("\n\n");
	return { text: [head, body || (pending.length > 0 ? "" : "(This section has no readable text.)"), ...notes].filter(Boolean).join("\n\n"), pending };
}

/** How many pages a PDF says it has, read from its bytes without parsing
 *  it — the folder checklist's hint. Undefined when the page tree is
 *  compressed (most modern PDFs), where no hint is given. */
export function pdfPageCountHint(bytes: Uint8Array): number | undefined {
	const text = new TextDecoder("latin1").decode(bytes);
	let best: number | undefined;
	for (const match of text.matchAll(/\/Type\s*\/Pages\b[^>]{0,400}?\/Count\s+(\d{1,6})|\/Count\s+(\d{1,6})[^>]{0,400}?\/Type\s*\/Pages\b/g)) {
		const pages = Number(match[1] ?? match[2]);
		if (best === undefined || pages > best) best = pages;
	}
	return best;
}

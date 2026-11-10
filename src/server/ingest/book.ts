/**
 * Book conversion (fork, phase 4a — see FORK.md): one stored PDF or EPUB →
 * numbered pages plus sections. No model is involved unless a PDF has no
 * bookmarks, when a cheap model proposes chapter starts from each page's
 * opening lines; failing that the book is cut into equal runs of pages.
 * Scanned pages are only marked here — they are read on first use.
 */

import * as fs from "node:fs/promises";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { withBgLlmSlot } from "../../agent/subagents/bg-llm-semaphore.ts";
import { convertPdf } from "../../agent/subagents/pdf-ops.ts";
import { runSubagent } from "../../agent/subagents/pi-run.ts";
import { CHAPTER_SPLIT_INSTRUCTIONS, fixedSections, pageHeads, parseChapterLines, sectionsFromOutline, type OutlineEntry } from "../../core/book.ts";
import { MAX_BOOK_PAGES, type BookPage, type MaterialFormat, type MaterialRecord, type MaterialSection } from "../../core/contracts.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { stores } from "../stores.ts";
import { ConversionError } from "./convert.ts";
import { EpubError, readEpub } from "./epub.ts";
import { readPdfOutline } from "./pdf-outline.ts";

export interface BookConversion {
	pages: BookPage[];
	sections: MaterialSection[];
	sectioning: NonNullable<MaterialRecord["sectioning"]>;
	/** The book's own title, when the file states one (EPUB). */
	title?: string;
}

/** Chapter starts proposed from the pages' opening lines; empty when none could be found. */
export type ChapterProposer = (heads: string, pageCount: number, signal?: AbortSignal) => Promise<OutlineEntry[]>;

export function createChapterProposer(engineFor?: () => PiEngine | null): ChapterProposer {
	const cheapEngine =
		engineFor ??
		(() => {
			const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
			return spec ? piEngineForSpec(spec, true) : null;
		});
	return async (heads, pageCount, signal) => {
		const engine = cheapEngine();
		if (!engine) return []; // no background model: fall back to equal sections
		const { text } = await withBgLlmSlot(signal, () =>
			runSubagent([], {
				role: "extractor",
				engine,
				systemPrompt: CHAPTER_SPLIT_INSTRUCTIONS,
				messages: [{ role: "user", content: [{ type: "text", text: heads }], timestamp: Date.now() }],
				maxTurns: 1,
				abortSignal: signal,
			}),
		);
		return parseChapterLines(text, pageCount);
	};
}

function sectioned(pages: BookPage[], outline: OutlineEntry[], from: "outline" | "model"): Pick<BookConversion, "sections" | "sectioning"> | null {
	const sections = sectionsFromOutline(outline, pages.length);
	// One section is no split at all.
	return sections.length >= 2 ? { sections, sectioning: from } : null;
}

async function convertPdfBook(path: string, propose: ChapterProposer, signal?: AbortSignal): Promise<BookConversion> {
	const bytes = new Uint8Array(await fs.readFile(path));
	const pdf = await convertPdf(bytes.slice(), MAX_BOOK_PAGES);
	if (pdf.kind === "unreadable") throw new ConversionError("Could not open this PDF.");
	if (pdf.kind === "too-long") throw new ConversionError(`Too long. A book can have at most ${MAX_BOOK_PAGES.toLocaleString("en-US")} pages.`);
	const pages: BookPage[] = pdf.pages.map((page) =>
		page.kind === "text" ? { n: page.number, kind: page.markdown.trim() ? "text" : "empty", text: page.markdown } : { n: page.number, kind: "scanned", text: "" },
	);
	if (pages.length === 0) throw new ConversionError("This PDF has no pages.");
	signal?.throwIfAborted();
	let outline: OutlineEntry[] = [];
	try {
		outline = (await readPdfOutline(bytes)).entries;
	} catch {
		// bookmarks are optional; an unreadable outline is no outline
	}
	const fromOutline = sectioned(pages, outline, "outline");
	if (fromOutline) return { pages, ...fromOutline };
	const heads = pageHeads(pages);
	if (heads) {
		let proposed: OutlineEntry[] = [];
		try {
			proposed = await propose(heads, pages.length, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			// a model failure must not lose the book: equal sections still work
		}
		const fromModel = sectioned(pages, proposed, "model");
		if (fromModel) return { pages, ...fromModel };
	}
	return { pages, sections: fixedSections(pages.length), sectioning: "fixed" };
}

async function convertEpubBook(path: string): Promise<BookConversion> {
	let epub;
	try {
		epub = readEpub(new Uint8Array(await fs.readFile(path)));
	} catch (error) {
		if (error instanceof EpubError) throw new ConversionError(error.message);
		throw error;
	}
	const pages: BookPage[] = epub.chapters.map((text, index) => ({ n: index + 1, kind: text ? "text" : "empty", text }));
	if (!pages.some((page) => page.kind === "text")) throw new ConversionError("No text could be read from this EPUB.");
	const fromToc = sectioned(pages, epub.toc, "outline");
	return {
		pages,
		...(fromToc ?? {
			// No usable contents: one section per chapter file, titled by its first heading.
			sections: pages.map((page) => ({
				id: `s${page.n}`,
				title: /^#{1,3}\s+(.+)$/m.exec(page.text)?.[1]?.trim().slice(0, 200) || `Chapter file ${page.n}`,
				level: 1,
				pageStart: page.n,
				pageEnd: page.n,
			})),
			sectioning: "fixed" as const,
		}),
		...(epub.title ? { title: epub.title } : {}),
	};
}

export async function convertBook(format: MaterialFormat, originalPath: string, propose: ChapterProposer, signal?: AbortSignal): Promise<BookConversion> {
	if (format === "pdf") return convertPdfBook(originalPath, propose, signal);
	if (format === "epub") return convertEpubBook(originalPath);
	throw new ConversionError("A book must be a PDF or an EPUB.");
}

/** A PDF's page count, without converting it. Null when it cannot be opened. */
export async function pdfPageCount(path: string): Promise<number | null> {
	try {
		return (await readPdfOutline(new Uint8Array(await fs.readFile(path)))).pageCount;
	} catch {
		return null;
	}
}

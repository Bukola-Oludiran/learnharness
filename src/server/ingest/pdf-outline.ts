/**
 * A PDF's bookmarks (fork, phase 4a): the publisher's own table of
 * contents, as titles pointing at page numbers. Read with pdfjs, the
 * library upstream's PDF converter already uses.
 */

import { standardFontsDir } from "../../agent/subagents/pdf-ops.ts";
import type { OutlineEntry } from "../../core/book.ts";

interface OutlineNode {
	title: string;
	dest: string | unknown[] | null;
	items?: OutlineNode[];
}

const MAX_ENTRIES = 2000;

/** The bookmarks two levels deep, in document order, plus the page count.
 *  Entries whose target cannot be resolved are dropped. Throws when the
 *  file is not a readable PDF. */
export async function readPdfOutline(data: Uint8Array): Promise<{ pageCount: number; entries: OutlineEntry[] }> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	// pdfjs takes ownership of the buffer it is given; hand it a copy.
	const task = pdfjs.getDocument({ data: data.slice(), standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	try {
		const doc = await task.promise;
		const entries: OutlineEntry[] = [];
		const pageOf = async (dest: OutlineNode["dest"]): Promise<number | null> => {
			try {
				const target = typeof dest === "string" ? await doc.getDestination(dest) : dest;
				const ref = Array.isArray(target) ? target[0] : null;
				if (typeof ref === "number") return ref + 1;
				if (ref && typeof ref === "object") return (await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0])) + 1;
			} catch {
				// a dangling bookmark
			}
			return null;
		};
		const walk = async (nodes: OutlineNode[] | undefined, level: number): Promise<void> => {
			for (const node of nodes ?? []) {
				if (entries.length >= MAX_ENTRIES) return;
				const page = await pageOf(node.dest);
				if (page !== null && typeof node.title === "string") entries.push({ title: node.title, level, page });
				if (level < 2) await walk(node.items, level + 1);
			}
		};
		await walk((await doc.getOutline()) as OutlineNode[] | undefined, 1);
		return { pageCount: doc.numPages, entries };
	} finally {
		await task.destroy();
	}
}

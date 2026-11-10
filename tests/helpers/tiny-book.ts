/** Book fixtures (fork, phase 4a): bookmarks added to a tiny PDF by an
 *  incremental update, and a minimal EPUB. */
import { tinyZip } from "./tiny-zip.ts";

export interface TinyBookmark {
	title: string;
	/** 1-based page it points at. */
	page: number;
	children?: TinyBookmark[];
}

/** Append an /Outlines tree to a PDF made by tinyPdf (page N is object 6 + 2(N-1)). */
export function withBookmarks(pdf: Uint8Array, bookmarks: readonly TinyBookmark[]): Uint8Array<ArrayBuffer> {
	const base = Array.from(pdf, (byte) => String.fromCharCode(byte)).join("");
	const previousXref = Number(/startxref\n(\d+)/.exec(base)![1]);
	const size = Number(/\/Size (\d+)/.exec(base)![1]);
	const rootId = size;
	let nextId = size + 1;
	const bodies = new Map<number, string>();
	const build = (items: readonly TinyBookmark[], parent: number): { first: number; last: number } => {
		const ids = items.map(() => nextId++);
		items.forEach((item, i) => {
			const kids = item.children?.length ? build(item.children, ids[i]!) : null;
			bodies.set(
				ids[i]!,
				`<< /Title (${item.title}) /Parent ${parent} 0 R /Dest [${6 + (item.page - 1) * 2} 0 R /Fit]` +
					(i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : "") +
					(i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : "") +
					(kids ? ` /First ${kids.first} 0 R /Last ${kids.last} 0 R /Count ${item.children!.length}` : "") +
					" >>",
			);
		});
		return { first: ids[0]!, last: ids.at(-1)! };
	};
	const top = build(bookmarks, rootId);
	bodies.set(rootId, `<< /Type /Outlines /First ${top.first} 0 R /Last ${top.last} 0 R /Count ${bookmarks.length} >>`);
	bodies.set(1, `<< /Type /Catalog /Pages 2 0 R /Outlines ${rootId} 0 R >>`);
	let out = base;
	const offsets = new Map<number, number>();
	for (const [id, body] of [...bodies].sort((a, b) => a[0] - b[0])) {
		offsets.set(id, out.length);
		out += `${id} 0 obj\n${body}\nendobj\n`;
	}
	const xref = out.length;
	const entry = (id: number) => `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
	const added = [...offsets.keys()].filter((id) => id !== 1).sort((a, b) => a - b);
	out += `xref\n1 1\n${entry(1)}${added[0]} ${added.length}\n${added.map(entry).join("")}`;
	out += `trailer\n<< /Size ${nextId} /Root 1 0 R /Prev ${previousXref} >>\nstartxref\n${xref}\n%%EOF\n`;
	return Uint8Array.from(out, (ch) => ch.charCodeAt(0));
}

export interface TinyChapter {
	file: string;
	title: string;
	body: string;
}

/** An EPUB with the given chapter files; `toc` picks EPUB 3 nav, EPUB 2 NCX, or none. */
export function tinyEpub(chapters: readonly TinyChapter[], options: { toc?: "nav" | "ncx" | "none"; title?: string; nested?: Record<string, string[]> } = {}): Buffer {
	const toc = options.toc ?? "nav";
	const nested = options.nested ?? {};
	const children = new Set(Object.values(nested).flat());
	const tops = chapters.filter((chapter) => !children.has(chapter.file));
	const byFile = new Map(chapters.map((chapter) => [chapter.file, chapter]));
	const files: Record<string, string> = {
		mimetype: "application/epub+zip",
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
	};
	const items = chapters.map((chapter, i) => `<item id="c${i}" href="text/${encodeURIComponent(chapter.file)}" media-type="application/xhtml+xml"/>`);
	if (toc === "nav") {
		items.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
		const li = (chapter: TinyChapter): string =>
			`<li><a href="text/${encodeURIComponent(chapter.file)}#top">${chapter.title}</a>${nested[chapter.file] ? `<ol>${nested[chapter.file]!.map((file) => li(byFile.get(file)!)).join("")}</ol>` : ""}</li>`;
		files["OEBPS/nav.xhtml"] = `<html xmlns:epub="e"><body><nav epub:type="toc"><ol>${tops.map(li).join("")}</ol></nav></body></html>`;
	}
	if (toc === "ncx") {
		items.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
		const point = (chapter: TinyChapter): string =>
			`<navPoint id="p"><navLabel><text>${chapter.title}</text></navLabel><content src="text/${encodeURIComponent(chapter.file)}"/>${(nested[chapter.file] ?? []).map((file) => point(byFile.get(file)!)).join("")}</navPoint>`;
		files["OEBPS/toc.ncx"] = `<ncx><docTitle><text>ignored</text></docTitle><navMap>${tops.map(point).join("")}</navMap></ncx>`;
	}
	files["OEBPS/content.opf"] =
		`<package><metadata><dc:title>${options.title ?? "Tiny Book"}</dc:title></metadata><manifest>${items.join("")}</manifest>` +
		`<spine${toc === "ncx" ? ' toc="ncx"' : ""}>${toc === "nav" ? '<itemref idref="nav"/>' : ""}${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`;
	for (const chapter of chapters) files[`OEBPS/text/${chapter.file}`] = `<html><head><title>x</title><style>p{}</style></head><body>${chapter.body}</body></html>`;
	return tinyZip(files);
}

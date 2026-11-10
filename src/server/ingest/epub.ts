/**
 * EPUB → chapter files and a table of contents (fork, phase 4a). An EPUB
 * is a zip: META-INF/container.xml names the package file, whose manifest
 * lists the content and whose spine orders it; the contents come from the
 * EPUB 3 nav document or the EPUB 2 NCX. Each spine file becomes one
 * "page" of the stored book, as Markdown (linkedom + turndown, which the
 * project already ships). Pictures are dropped.
 */

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { OutlineEntry } from "../../core/book.ts";
import { decodeXml } from "./pptx.ts";
import { readZipEntries, readZipEntry, ZipError, type ZipEntry } from "./zip.ts";

export interface Epub {
	title: string;
	/** The spine's readable files, in reading order, as Markdown. */
	chapters: string[];
	/** Contents entries; `page` is the 1-based index into `chapters`. */
	toc: OutlineEntry[];
}

export class EpubError extends Error {}

const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_CHAPTERS = 3000;
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "nav"] as never);
// turndown's own image rule outranks remove(); pictures are dropped by a rule of ours.
turndown.addRule("no-pictures", { filter: ["img", "svg", "picture"] as never, replacement: () => "" });

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
const dirOf = (file: string) => file.split("/").slice(0, -1).join("/");

/** Resolve a (possibly percent-encoded, fragment-carrying) href against the file that holds it. */
function resolveHref(fromFile: string, href: string): string {
	const bare = href.split("#")[0]!;
	let decoded = bare;
	try {
		decoded = decodeURIComponent(bare);
	} catch {
		// keep the raw spelling
	}
	const parts = decoded.startsWith("/") ? [] : dirOf(fromFile).split("/").filter(Boolean);
	for (const segment of decoded.split("/")) {
		if (segment === "..") parts.pop();
		else if (segment !== "." && segment !== "") parts.push(segment);
	}
	return parts.join("/");
}

function htmlToMarkdown(html: string): string {
	const { document } = parseHTML(html);
	const body = document.querySelector("body") ?? document.documentElement;
	return body ? turndown.turndown(body.innerHTML).replace(/\n{3,}/g, "\n\n").trim() : "";
}

/** EPUB 3: the nav document's toc list, nested <ol><li><a href>. */
function navEntries(html: string, navFile: string): { title: string; level: number; file: string }[] {
	const { document } = parseHTML(html);
	const navs = [...document.querySelectorAll("nav")];
	const toc = navs.find((nav) => /\btoc\b/.test(nav.getAttribute("epub:type") ?? nav.getAttribute("role") ?? "")) ?? navs[0];
	const out: { title: string; level: number; file: string }[] = [];
	for (const link of toc ? [...toc.querySelectorAll("a[href]")] : []) {
		let level = 0;
		for (let el = link.parentElement; el && el !== toc; el = el.parentElement) if (el.tagName.toLowerCase() === "ol") level++;
		out.push({ title: link.textContent ?? "", level: Math.max(1, level), file: resolveHref(navFile, link.getAttribute("href") ?? "") });
	}
	return out;
}

/** EPUB 2: the NCX navMap, nested <navPoint>. */
function ncxEntries(xml: string, ncxFile: string): { title: string; level: number; file: string }[] {
	const out: { title: string; level: number; file: string }[] = [];
	let level = 0;
	let pendingTitle: string | null = null;
	for (const token of xml.matchAll(/<navPoint\b[^>]*>|<\/navPoint>|<text>([\s\S]*?)<\/text>|<content\b[^>]*>/g)) {
		const tag = token[0];
		if (tag.startsWith("<navPoint")) {
			level++;
			pendingTitle = null;
		} else if (tag === "</navPoint>") level = Math.max(0, level - 1);
		else if (tag.startsWith("<text>")) pendingTitle = level > 0 ? decodeXml(token[1] ?? "") : null;
		else if (level > 0 && pendingTitle !== null) {
			out.push({ title: pendingTitle, level, file: resolveHref(ncxFile, decodeXml(attr(tag, "src") ?? "")) });
			pendingTitle = null;
		}
	}
	return out;
}

export function readEpub(bytes: Uint8Array): Epub {
	let entries: ZipEntry[];
	try {
		entries = readZipEntries(bytes);
	} catch {
		throw new EpubError("Could not open this EPUB.");
	}
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const decoder = new TextDecoder();
	const read = (name: string): string | null => {
		const entry = byName.get(name);
		if (!entry) return null;
		try {
			return decoder.decode(readZipEntry(bytes, entry, MAX_XML_BYTES));
		} catch (error) {
			if (error instanceof ZipError) return null;
			throw error;
		}
	};
	if (byName.has("META-INF/encryption.xml") && /EncryptedData/.test(read("META-INF/encryption.xml") ?? "") && byName.has("META-INF/rights.xml")) {
		throw new EpubError("This EPUB is copy-protected (DRM) and cannot be read.");
	}
	const packageFile = attr(/<rootfile\b[^>]*>/.exec(read("META-INF/container.xml") ?? "")?.[0] ?? "", "full-path");
	const opf = packageFile ? read(packageFile) : null;
	if (!packageFile || opf === null) throw new EpubError("Could not open this EPUB.");

	const manifest = new Map<string, { file: string; type: string; properties: string }>();
	for (const item of opf.match(/<item\b[^>]*>/g) ?? []) {
		const id = attr(item, "id");
		const href = attr(item, "href");
		if (id && href) manifest.set(id, { file: resolveHref(packageFile, decodeXml(href)), type: attr(item, "media-type") ?? "", properties: attr(item, "properties") ?? "" });
	}
	const spineFiles = (opf.match(/<itemref\b[^>]*>/g) ?? [])
		.map((ref) => manifest.get(attr(ref, "idref") ?? ""))
		.filter((item): item is NonNullable<typeof item> => item !== undefined && /x?html/.test(item.type))
		.map((item) => item.file);
	if (spineFiles.length > MAX_CHAPTERS) throw new EpubError("This EPUB has too many chapter files to read.");

	const nav = [...manifest.values()].find((item) => /\bnav\b/.test(item.properties));
	const ncx = manifest.get(attr(/<spine\b[^>]*>/.exec(opf)?.[0] ?? "", "toc") ?? "") ?? [...manifest.values()].find((item) => item.type === "application/x-dtbncx+xml");
	let raw = nav ? navEntries(read(nav.file) ?? "", nav.file) : [];
	if (raw.length === 0 && ncx) raw = ncxEntries(read(ncx.file) ?? "", ncx.file);

	// The nav document is contents, not a chapter: leave it out of the pages.
	const chapterFiles = spineFiles.filter((file) => file !== nav?.file);
	if (chapterFiles.length === 0) throw new EpubError("This EPUB has no readable chapters.");
	const pageOf = new Map(chapterFiles.map((file, index) => [file, index + 1]));
	const toc: OutlineEntry[] = [];
	for (const entry of raw) {
		const page = pageOf.get(entry.file);
		// Several entries into one file collapse into the first: sections follow chapter files.
		if (page === undefined || toc.at(-1)?.page === page) continue;
		toc.push({ title: entry.title, level: entry.level, page });
	}
	const title = decodeXml(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? "").replace(/\s+/g, " ").trim();
	return { title, chapters: chapterFiles.map((file) => htmlToMarkdown(read(file) ?? "")), toc };
}

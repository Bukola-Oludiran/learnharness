/**
 * Books (fork, phase 4a — FORK.md): sectioning, the PDF outline and EPUB
 * readers, the materials service's book paths (upload, the long-PDF
 * choice, section reads with scanned pages read on first use), and the
 * tutor's read_material tool. Runs under an isolated LH_DATA_DIR, set
 * before the first config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { tinyEpub, withBookmarks } from "./helpers/tiny-book.ts";
import { tinyPdf, type TinyPage } from "./helpers/tiny-pdf.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-books-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const {
	bookContentsText, bookListText, CHAPTER_SPLIT_INSTRUCTIONS, fixedSections, pageHeads, parseChapterLines, pdfPageCountHint, sectionsFromOutline, sectionText, SECTION_PART_CHARS,
} = await import("../src/core/book.ts");
const { folderFileVerdict, materialStatusLine, AI_READ_MARK } = await import("../src/core/material.ts");
const { readPdfOutline } = await import("../src/server/ingest/pdf-outline.ts");
const { readEpub, EpubError } = await import("../src/server/ingest/epub.ts");
const { convertBook } = await import("../src/server/ingest/book.ts");
const { createMaterialsService } = await import("../src/server/materials.ts");
const { materialToolDeps } = await import("../src/server/material-tools.ts");
const { createMaterialTools } = await import("../src/agent/tools/ingest.ts");
const { stores } = await import("../src/server/stores.ts");
const { BookContentsBody, MaterialRow, materialStatus } = await import("../components/course-materials.tsx");
const { FolderChecklistBody, folderItems, folderSummary } = await import("../components/folder-upload.tsx");
const materialsRoute = await import("../app/api/materials/[id]/route.ts");
import type { BookPage, MaterialView } from "../src/core/contracts.ts";

const textPage = (text: string): TinyPage => ({ runs: [{ text, x: 72, y: 700 }] });
const pdf = (pages: number, scanned: number[] = []) =>
	tinyPdf(Array.from({ length: pages }, (_, i) => (scanned.includes(i + 1) ? { image: true } : textPage(`Body of page ${i + 1}`))));
const noPropose = async () => [];

describe("sections from a table of contents", () => {
	it("gives chapters the pages up to the next chapter and sub-sections the pages up to the next entry", () => {
		const sections = sectionsFromOutline(
			[
				{ title: "  1  Sets ", level: 1, page: 3 },
				{ title: "1.1 Unions", level: 2, page: 3 },
				{ title: "1.2 Maps", level: 2, page: 6 },
				{ title: "Deep", level: 3, page: 7 },
				{ title: "2 Groups", level: 1, page: 9 },
			],
			12,
		);
		assert.deepEqual(sections, [
			{ id: "s0", title: "Front matter", level: 1, pageStart: 1, pageEnd: 2 },
			{ id: "s1", title: "1 Sets", level: 1, pageStart: 3, pageEnd: 8 },
			{ id: "s1.1", title: "1.1 Unions", level: 2, pageStart: 3, pageEnd: 5 },
			{ id: "s1.2", title: "1.2 Maps", level: 2, pageStart: 6, pageEnd: 8 },
			{ id: "s2", title: "2 Groups", level: 1, pageStart: 9, pageEnd: 12 },
		]);
	});

	it("refuses an outline out of reading order, drops entries off the book, and shares a page between two starts", () => {
		assert.deepEqual(sectionsFromOutline([{ title: "B", level: 1, page: 5 }, { title: "A", level: 1, page: 2 }], 9), []);
		assert.deepEqual(sectionsFromOutline([{ title: "Gone", level: 1, page: 40 }, { title: "", level: 1, page: 1 }], 9), []);
		const shared = sectionsFromOutline([{ title: "A", level: 1, page: 1 }, { title: "B", level: 1, page: 1 }], 4);
		assert.deepEqual(shared.map((s) => [s.pageStart, s.pageEnd]), [[1, 1], [1, 4]]);
		// A contents list that starts below chapter level is flattened.
		assert.deepEqual(sectionsFromOutline([{ title: "a", level: 2, page: 1 }, { title: "b", level: 2, page: 3 }], 4).map((s) => [s.id, s.level]), [["s1", 1], ["s2", 1]]);
	});

	it("falls back to equal runs of pages", () => {
		assert.deepEqual(fixedSections(45).map((s) => [s.id, s.title, s.pageStart, s.pageEnd]), [
			["s1", "Pages 1–20", 1, 20], ["s2", "Pages 21–40", 21, 40], ["s3", "Pages 41–45", 41, 45],
		]);
		assert.equal(fixedSections(21).at(-1)!.title, "Page 21");
	});
});

describe("the chapter proposer's reply", () => {
	it("is read as page-tab-title lines, in order, within the book", () => {
		assert.deepEqual(parseChapterLines("1\tPreface\n12\tChapter 1: Sets\nnot a line\n12\tDuplicate\n9\tBackwards\n40: Chapter 2\n900\tOff the end", 100), [
			{ title: "Preface", level: 1, page: 1 }, { title: "Chapter 1: Sets", level: 1, page: 12 }, { title: "Chapter 2", level: 1, page: 40 },
		]);
		assert.deepEqual(parseChapterLines("NONE", 100), []);
		assert.deepEqual(parseChapterLines("5\tOnly one", 100), []);
	});

	it("is asked with each page's opening lines, and not at all for a scanned book", () => {
		const pages: BookPage[] = [
			{ n: 1, kind: "text", text: "Chapter 1\nSets and maps\n" + "x".repeat(500) },
			{ n: 2, kind: "scanned", text: "" },
			{ n: 3, kind: "text", text: "More" },
			{ n: 4, kind: "text", text: "Even more" },
		];
		const heads = pageHeads(pages)!;
		assert.match(heads, /^--- Page 1 ---\nChapter 1 \/ Sets and maps \/ x+\n--- Page 3 ---\nMore\n--- Page 4 ---\nEven more$/);
		assert.ok(heads.split("\n")[1]!.length <= 160);
		assert.equal(pageHeads([{ n: 1, kind: "scanned", text: "" }, { n: 2, kind: "scanned", text: "" }, { n: 3, kind: "text", text: "x" }]), null);
		assert.match(CHAPTER_SPLIT_INSTRUCTIONS, /reply with the single word NONE\.$/);
	});
});

describe("a section's text", () => {
	const book = { title: "Algebra", format: "pdf" as const };
	const section = { id: "s2", title: "Groups", level: 1, pageStart: 2, pageEnd: 4 };
	const pages: BookPage[] = [
		{ n: 1, kind: "text", text: "front" }, { n: 2, kind: "text", text: "Two" }, { n: 3, kind: "scanned", text: "" }, { n: 4, kind: "empty", text: "" }, { n: 5, kind: "text", text: "after" },
	];

	it("covers only its pages, marks AI-read pages, and names scanned pages not read yet", () => {
		const waiting = sectionText(book, section, pages, new Map());
		assert.deepEqual(waiting.pending, [3]);
		assert.match(waiting.text, /^"Algebra" — \[s2\] Groups\n\n--- Page 2 ---\n\nTwo\n\n1 scanned page of this section is still being read \(pages 3\)\. Tell the learner, and call again shortly/);
		const done = sectionText(book, section, pages, new Map([[3, "Three [?]"]]));
		assert.deepEqual(done.pending, []);
		assert.equal(done.text, `"Algebra" — [s2] Groups\n\n--- Page 2 ---\n\nTwo\n\n--- Page 3 ---\n\n${AI_READ_MARK}\n\nThree [?]`);
		assert.doesNotMatch(done.text, /front|after/);
	});

	it("comes in parts that break at page boundaries, each saying how to get the next", () => {
		const long: BookPage[] = [1, 2, 3].map((n) => ({ n, kind: "text", text: `${n}`.repeat(SECTION_PART_CHARS - 5000) }));
		const whole = { id: "s1", title: "Long", level: 1, pageStart: 1, pageEnd: 3 };
		const first = sectionText(book, whole, long, new Map(), 1).text;
		assert.match(first, /\(part 1 of 3\)[\s\S]*--- Page 1 ---[\s\S]*This is part 1 of 3\. Call again with part 2 for the next\.$/);
		assert.doesNotMatch(first, /--- Page 2 ---/);
		const last = sectionText(book, whole, long, new Map(), 9).text;
		assert.match(last, /\(part 3 of 3\)[\s\S]*--- Page 3 ---/);
		assert.doesNotMatch(last, /Call again with part/);
		// One page longer than a part is cut, not dropped.
		const huge = sectionText(book, { ...whole, pageEnd: 1 }, [{ n: 1, kind: "text", text: "z".repeat(SECTION_PART_CHARS * 2 + 10) }], new Map(), 3).text;
		assert.match(huge, /\(part 3 of 3\)\n\n--- Page 1 \(continued\) ---\n\nz{10}$/);
		assert.match(sectionText(book, { ...whole, pageStart: 4, pageEnd: 4 }, pages, new Map()).text, /\(This section has no readable text\.\)$/);
	});

	it("lists books and contents in words, with EPUB units named honestly", () => {
		assert.equal(bookListText([]), "The learner has no books in their library.");
		const ready = { id: "mat_1", title: "Algebra", status: "ready" as const, sections: [section, { ...section, id: "s2.1", level: 2, pageEnd: 2 }], pageCount: 5, format: "pdf" as const };
		assert.equal(bookListText([ready, { ...ready, id: "mat_2", title: "New", status: "processing" as const }]), "- Algebra (id mat_1): 2 sections, 5 pages.\n- New (id mat_2): not ready yet (processing).");
		assert.equal(bookContentsText(ready), 'Sections of "Algebra" (id mat_1):\n- [s2] Groups (pages 2–4)\n  - [s2.1] Groups (page 2)');
		assert.match(bookContentsText({ ...ready, format: "epub" }), /\(chapter files 2–4\)/);
	});
});

describe("the PDF outline reader", () => {
	it("reads bookmarks two levels deep with their pages", async () => {
		const book = withBookmarks(pdf(6), [{ title: "One", page: 1, children: [{ title: "One point one", page: 2, children: [{ title: "too deep", page: 2 }] }] }, { title: "Two", page: 4 }]);
		assert.deepEqual(await readPdfOutline(book), {
			pageCount: 6,
			entries: [{ title: "One", level: 1, page: 1 }, { title: "One point one", level: 2, page: 2 }, { title: "Two", level: 1, page: 4 }],
		});
		assert.deepEqual(await readPdfOutline(pdf(2)), { pageCount: 2, entries: [] });
		await assert.rejects(readPdfOutline(Buffer.from("not a pdf")));
	});

	it("gives the checklist a page-count hint when the page tree is readable", () => {
		assert.equal(pdfPageCountHint(pdf(7)), 7);
		assert.equal(pdfPageCountHint(Buffer.from("%PDF-1.7 compressed object streams only")), undefined);
	});
});

describe("the EPUB reader", () => {
	const chapters = [
		{ file: "ch 1.xhtml", title: "Sets", body: "<h1>Sets</h1><p>A set is a <em>collection</em>.</p><img src='x.png'/><script>bad()</script>" },
		{ file: "ch2.xhtml", title: "Unions", body: "<h2>Unions</h2><ul><li>A ∪ B</li></ul>" },
		{ file: "ch3.xhtml", title: "Groups", body: "<h1>Groups</h1><p>Closure.</p>" },
	];

	it("reads chapters in spine order as Markdown, without the nav page, pictures or scripts", () => {
		const epub = readEpub(tinyEpub(chapters, { title: "Tiny &amp; Algebra" }));
		assert.equal(epub.title, "Tiny & Algebra");
		assert.deepEqual(epub.chapters, ["# Sets\n\nA set is a _collection_.", "## Unions\n\n*   A ∪ B", "# Groups\n\nClosure."]);
		assert.deepEqual(epub.toc, [{ title: "Sets", level: 1, page: 1 }, { title: "Unions", level: 1, page: 2 }, { title: "Groups", level: 1, page: 3 }]);
	});

	it("reads nested contents from an EPUB 3 nav and an EPUB 2 NCX alike", () => {
		for (const toc of ["nav", "ncx"] as const) {
			const epub = readEpub(tinyEpub(chapters, { toc, nested: { "ch 1.xhtml": ["ch2.xhtml"] } }));
			assert.deepEqual(epub.toc, [{ title: "Sets", level: 1, page: 1 }, { title: "Unions", level: 2, page: 2 }, { title: "Groups", level: 1, page: 3 }], toc);
		}
		assert.deepEqual(readEpub(tinyEpub(chapters, { toc: "none" })).toc, []);
	});

	it("refuses what is not an EPUB", () => {
		assert.throws(() => readEpub(Buffer.from("nope")), EpubError);
		assert.throws(() => readEpub(tinyEpub([])), /no readable chapters/);
	});
});

describe("book conversion", () => {
	const write = (name: string, bytes: Uint8Array) => {
		const target = path.join(root, name);
		fs.writeFileSync(target, bytes);
		return target;
	};

	it("sections a bookmarked PDF from its outline without asking a model, and marks scanned pages", async () => {
		let asked = 0;
		const book = await convertBook("pdf", write("b.pdf", withBookmarks(pdf(6, [5]), [{ title: "One", page: 1 }, { title: "Two", page: 4 }])), async () => (asked++, []));
		assert.equal(asked, 0);
		assert.equal(book.sectioning, "outline");
		assert.deepEqual(book.sections.map((s) => [s.id, s.title, s.pageStart, s.pageEnd]), [["s1", "One", 1, 3], ["s2", "Two", 4, 6]]);
		assert.deepEqual(book.pages.map((page) => page.kind), ["text", "text", "text", "text", "scanned", "text"]);
		assert.match(book.pages[0]!.text, /Body of page 1/);
	});

	it("asks the model when there are no bookmarks, and falls back to equal sections when it declines or fails", async () => {
		const file = write("plain.pdf", pdf(5));
		const proposed = await convertBook("pdf", file, async (heads, pageCount) => {
			assert.match(heads, /--- Page 1 ---\nBody of page 1/);
			assert.equal(pageCount, 5);
			return [{ title: "Start", level: 1, page: 1 }, { title: "Middle", level: 1, page: 3 }];
		});
		assert.deepEqual([proposed.sectioning, proposed.sections.map((s) => s.title)], ["model", ["Start", "Middle"]]);
		assert.equal((await convertBook("pdf", file, noPropose)).sectioning, "fixed");
		const failed = await convertBook("pdf", file, async () => { throw new Error("usage limit"); });
		assert.deepEqual([failed.sectioning, failed.sections.length], ["fixed", 1]);
	});

	it("sections an EPUB by its contents, or by chapter file when it has none", async () => {
		const chapters = [{ file: "a.xhtml", title: "Alpha", body: "<h1>Alpha heading</h1><p>a</p>" }, { file: "b.xhtml", title: "Beta", body: "<p>b</p>" }];
		const withToc = await convertBook("epub", write("t.epub", tinyEpub(chapters, { title: "Greek" })), noPropose);
		assert.deepEqual([withToc.title, withToc.sectioning, withToc.sections.map((s) => s.title)], ["Greek", "outline", ["Alpha", "Beta"]]);
		const without = await convertBook("epub", write("n.epub", tinyEpub(chapters, { toc: "none" })), noPropose);
		assert.deepEqual([without.sectioning, without.sections.map((s) => s.title)], ["fixed", ["Alpha heading", "Chapter file 2"]]);
		await assert.rejects(convertBook("pdf", write("bad.pdf", Buffer.from("%PDF-1.7 junk")), noPropose), /Could not open this PDF/);
		await assert.rejects(convertBook("text", "x", noPropose), /must be a PDF or an EPUB/);
	});
});

describe("books in the library", () => {
	const imported: { filePath: string }[] = [];
	const transcribed: string[] = [];
	const behavior = { transcribe: async (_bytes: Uint8Array, label: string) => `read ${label}` };
	const service = createMaterialsService({
		stores,
		transcribe: async (bytes, label) => {
			transcribed.push(label);
			return behavior.transcribe(bytes, label);
		},
		importNotes: async (input) => void imported.push(input),
		registerImport: () => {},
		abortExtraction: () => {},
		readTest: async () => ({ questions: [] }),
		linkTest: async (questions) => questions.map(() => []),
		sourceIdeas: () => [],
		renderPdfPages: async () => [],
		removeEvidence: () => {},
		renderPdfPage: async (_path, page) => Buffer.from(`png ${page}`),
		sectionWaitMs: 2000,
	});
	const get = (id: string) => service.getMaterial(id)!.material;
	async function settled(id: string): Promise<MaterialView> {
		for (let i = 0; i < 600; i++) {
			if (get(id).status !== "processing") return get(id);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("material never settled");
	}
	const bookmarked = withBookmarks(pdf(6, [5, 6]), [{ title: "One", page: 1 }, { title: "Two", page: 4 }]);

	it("stores a book in sections, in no course and out of the graph", async () => {
		const course = stores.courseStore.createCourse("Algebra", "");
		const outcome = service.uploadBook({ courseId: course.id, path: "Uni/Algebra.pdf" }, "Algebra.pdf", bookmarked);
		assert.ok(outcome.ok, JSON.stringify(outcome));
		assert.equal(materialStatus(outcome.material).label, "Splitting into sections…");
		const book = await settled(outcome.material.id);
		assert.deepEqual([book.kind, book.status, book.courseId, book.pageCount, book.sectioning, book.sections.length], ["book", "ready", undefined, 6, "outline", 2]);
		assert.match(book.notice!, /^2 scanned pages: read by the vision model when their section is first used\.$/);
		assert.equal(imported.length, 0);
		assert.equal(transcribed.length, 0);
		assert.deepEqual(materialStatus(book), { label: "2 sections · 6 pages", busy: false, tone: "quiet" });
		assert.equal(materialStatusLine(book), "- Algebra (book): stored and split into sections; read it with read_material.");
		assert.equal(stores.courseStore.getCourse(course.id)!.materialIds?.length ?? 0, 0);
	});

	it("refuses what is not a book, and treats an EPUB as a book whichever way it arrives", async () => {
		assert.equal((service.uploadBook({}, "notes.md", Buffer.from("x")) as { error: string }).error, "A book must be a PDF or an EPUB.");
		assert.equal((service.uploadBook({}, "big.pdf", new Uint8Array(200 * 1024 * 1024 + 1)) as { status: number }).status, 413);
		const epub = tinyEpub([{ file: "a.xhtml", title: "Alpha", body: "<p>a</p>" }, { file: "b.xhtml", title: "Beta", body: "<p>b</p>" }], { title: "Greek" });
		const outcome = service.uploadMaterial({}, "greek.epub", epub);
		assert.ok(outcome.ok);
		const book = await settled(outcome.material.id);
		assert.deepEqual([book.kind, book.title, book.status, book.sections.map((s) => s.title)], ["book", "Greek", "ready", ["Alpha", "Beta"]]);
		assert.equal(materialStatus(book).label, "2 sections · 2 chapter files");
	});

	it("reads a section at once when it has text, and its scanned pages on first use only", async () => {
		const id = service.listMaterials().find((m) => m.title === "Algebra")!.id;
		const contents = await service.readBook(id);
		assert.deepEqual(contents, { ok: true, text: `Sections of "Algebra" (id ${id}):\n- [s1] One (pages 1–3)\n- [s2] Two (pages 4–6)` });
		const one = await service.readBook(id, "s1");
		assert.ok(one.ok && /--- Page 1 ---\n\nBody of page 1[\s\S]*--- Page 3 ---/.test(one.text));
		assert.equal(transcribed.length, 0);
		const two = await service.readBook(id, "[S2]");
		assert.ok(two.ok, JSON.stringify(two));
		assert.match(two.text, /--- Page 4 ---\n\nBody of page 4\n\n--- Page 5 ---\n\n> \[AI-read[^\n]*\n\nread Page 5\n\n--- Page 6 ---[\s\S]*read Page 6$/);
		assert.deepEqual(transcribed, ["Page 5", "Page 6"]);
		assert.ok((await service.readBook(id, "Two")).ok, "a section is also found by its title");
		assert.deepEqual(transcribed, ["Page 5", "Page 6"], "kept pages are not read again");
	});

	it("answers with what is there when scanned pages are slow, and reports a reading failure", async () => {
		const outcome = service.uploadBook({}, "Slow.pdf", withBookmarks(pdf(4, [2, 4]), [{ title: "A", page: 1 }, { title: "B", page: 3 }]));
		assert.ok(outcome.ok);
		const id = (await settled(outcome.material.id)).id;
		let release!: () => void;
		behavior.transcribe = () => new Promise((resolve) => { release = () => resolve("late page"); });
		const slow = createMaterialsService({ stores, transcribe: (b, l) => behavior.transcribe(b, l), importNotes: async () => {}, registerImport: () => {}, abortExtraction: () => {}, readTest: async () => ({ questions: [] }), linkTest: async (q) => q.map(() => []), sourceIdeas: () => [], renderPdfPages: async () => [], removeEvidence: () => {}, renderPdfPage: async () => Buffer.from("png"), sectionWaitMs: 60 });
		const partial = await slow.readBook(id, "s1");
		assert.ok(partial.ok && /Body of page 1[\s\S]*1 scanned page of this section is still being read \(pages 2\)/.test(partial.text), JSON.stringify(partial));
		release();
		await new Promise((resolve) => setTimeout(resolve, 60));
		const complete = await slow.readBook(id, "s1");
		assert.ok(complete.ok && /late page$/.test(complete.text));
		behavior.transcribe = async () => { throw new Error("No vision model is set up."); };
		assert.deepEqual(await slow.readBook(id, "s2"), { ok: false, error: "The scanned pages of this section could not be read: No vision model is set up." });
		behavior.transcribe = async (_bytes, label) => `read ${label}`;
	});

	it("names what it cannot find", async () => {
		const id = service.listMaterials().find((m) => m.title === "Algebra")!.id;
		assert.match(((await service.readBook("mat_nope")) as { error: string }).error, /No book with id mat_nope\. Call read_material with no arguments/);
		assert.match(((await service.readBook(id, "s9")) as { error: string }).error, /has no section s9\. Call read_material with only the material id/);
		assert.match(service.bookList(), /^- Algebra \(id mat_[^)]+\): 2 sections, 6 pages\.\n- Greek /);
	});

	it("pauses a long notes PDF for a choice, and follows either answer", async () => {
		const long = pdf(81);
		const asNotes = service.uploadMaterial({}, "Long lecture notes.pdf", long);
		assert.ok(asNotes.ok);
		const paused = await settled(asNotes.material.id);
		assert.deepEqual([paused.status, paused.pendingChoice, paused.pageCount, paused.kind], ["review", "book-or-notes", 81, "notes"]);
		assert.deepEqual(materialStatus(paused), { label: "81 pages: book or notes?", busy: false, tone: "attention" });
		assert.match(materialStatusLine(paused), /it is long; the learner must choose in the Library/);
		assert.equal((service.approveMaterial(paused.id, {}) as { code: string }).code, "not_in_review");
		assert.equal((service.chooseMaterialKind(paused.id, "maybe") as { code: string }).code, "bad_choice");
		const before = imported.length;
		// Through the route: { choice } answers the pause.
		const res = await materialsRoute.PUT(new Request("http://test/api", { method: "PUT", body: JSON.stringify({ choice: "book" }) }), { params: Promise.resolve({ id: paused.id }) });
		assert.equal(res.status, 200);
		const book = await settled(paused.id);
		assert.deepEqual([book.kind, book.status, book.pendingChoice, book.sectioning, book.sections.length], ["book", "ready", undefined, "fixed", 5]);
		assert.equal(imported.length, before);

		const again = service.uploadMaterial({}, "Long handout.pdf", long);
		assert.ok(again.ok);
		const pausedAgain = await settled(again.material.id);
		assert.ok(service.chooseMaterialKind(pausedAgain.id, "notes").ok);
		const notes = await settled(pausedAgain.id);
		assert.deepEqual([notes.kind, notes.status, notes.lengthAccepted], ["notes", "ready", true]);
		assert.equal(imported.length, before + 1);
		assert.equal((service.chooseMaterialKind(notes.id, "book") as { code: string }).code, "no_choice");
		// A short PDF is never paused.
		const short = service.uploadMaterial({}, "Short.pdf", pdf(3));
		assert.ok(short.ok);
		assert.equal((await settled(short.material.id)).status, "ready");
	});

	it("the tutor adds a book by path and reads it through read_material", async () => {
		const [ingest, , read] = createMaterialTools(materialToolDeps("chat_books", service));
		const run = async (tool: typeof ingest, input: unknown) =>
			((await tool!.execute("call", input as never, undefined as never)).content as { text: string }[]).map((part) => part.text).join("\n");
		const file = path.join(root, "Tutor book.pdf");
		fs.writeFileSync(file, withBookmarks(pdf(4), [{ title: "Intro", page: 1 }, { title: "Body", page: 2 }]));
		const started = await run(ingest, { kind: "book", paths: [file] });
		const id = /\(id (mat_[^)]+)\)/.exec(started)![1]!;
		const book = await settled(id);
		assert.deepEqual([book.kind, book.courseId, book.sections.length], ["book", undefined, 2]);
		assert.match(await run(read, {}), new RegExp(`- Tutor book \\(id ${id}\\): 2 sections, 4 pages\\.`));
		assert.match(await run(read, { material: id }), /- \[s2\] Body \(pages 2–4\)/);
		assert.match(await run(read, { material: id, section: "s2" }), /^"Tutor book" — \[s2\] Body\n\n--- Page 2 ---\n\nBody of page 2/);
		await assert.rejects(run(read, { material: id, section: "s7" }), /has no section s7/);
		assert.match(read!.description, /nothing in it is in their knowledge graph until you teach it/);
		assert.match(read!.description, /Text marked AI-read came from scanned pages and may contain misreadings/);
		assert.match(JSON.stringify(ingest!.parameters), /book: each path \(PDF or EPUB\) is stored and split into sections for read_material/);
	});

	it("deleting a book removes its stored pages", async () => {
		const id = service.listMaterials().find((m) => m.title === "Algebra")!.id;
		assert.equal(service.deleteMaterial(id), true);
		assert.equal(stores.materialStore.readBookPages(id), null);
		assert.equal(stores.materialStore.readPageTranscripts(id).size, 0);
	});
});

describe("books in the Library's views", () => {
	const noop = () => {};
	const book: MaterialView = {
		id: "mat_b", title: "Algebra", kind: "book", format: "pdf", fileName: "Algebra.pdf", status: "ready", aiReadParts: 0, sourcePath: "Algebra.pdf", pageCount: 12, sectioning: "model",
		sections: [{ id: "s1", title: "Sets", level: 1, pageStart: 1, pageEnd: 8 }, { id: "s1.1", title: "Unions", level: 2, pageStart: 3, pageEnd: 3 }],
		createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", interrupted: false,
	};
	const row = (material: MaterialView) =>
		renderToStaticMarkup(<MaterialRow material={material} onReview={noop} onContents={noop} onChoose={noop} onRetry={noop} onAskDelete={noop} onCancelDelete={noop} onDelete={noop} />);

	it("a book row offers Contents; a paused long PDF offers the choice and no Review", () => {
		assert.match(row(book), /Book ·[\s\S]*2 sections · 12 pages[\s\S]*data-testid="material-contents"/);
		const paused = row({ ...book, kind: "notes", status: "review", pendingChoice: "book-or-notes", pageCount: 240, sections: [] });
		assert.match(paused, /240 pages: book or notes\?[\s\S]*data-testid="material-choose-book"[^>]*>Add as book[\s\S]*data-testid="material-choose-notes"[^>]*>Extract as notes/);
		assert.doesNotMatch(paused, /data-testid="material-review"|material-contents/);
	});

	it("the contents list shows every section, its pages and where the split came from", () => {
		const html = renderToStaticMarkup(<BookContentsBody material={book} onClose={noop} />);
		assert.equal(html.match(/data-testid="book-section"/g)!.length, 2);
		assert.match(html, /a model proposed where its chapters begin/);
		assert.match(html, /Sets<\/span>[\s\S]*p\. 1–8[\s\S]*Unions<\/span>[\s\S]*p\. 3</);
		assert.match(renderToStaticMarkup(<BookContentsBody material={{ ...book, sectioning: "outline" }} onClose={noop} />), /the book&#x27;s own table of contents/);
	});

	it("the folder checklist offers Book for PDFs and EPUBs, and only Book for a PDF too big for notes", () => {
		assert.deepEqual(folderFileVerdict("Algebra.epub", 1000), { choice: "book", testable: false, bookable: true });
		assert.deepEqual(folderFileVerdict("Huge textbook.pdf", 60 * 1024 * 1024), { choice: "book", testable: false, bookable: true });
		assert.deepEqual(folderFileVerdict("Week 2.pdf", 1000), { choice: "notes", testable: true, bookable: true });
		assert.match(folderFileVerdict("Too big.pdf", 200 * 1024 * 1024 + 1).refused!, /Max 200 MB/);
		const items = folderItems([
			{ name: "Algebra.epub", size: 1000, path: "U/Algebra.epub" }, { name: "Huge.pdf", size: 60 * 1024 * 1024, path: "U/Huge.pdf" }, { name: "Week 2.pdf", size: 1000, path: "U/Week 2.pdf" },
		]);
		assert.equal(folderSummary(items).label, "1 set of notes · 0 marked tests · 2 books · 0 skipped");
		const html = renderToStaticMarkup(<FolderChecklistBody items={items} progress={null} onChoice={noop} onStart={noop} onClose={noop} />);
		assert.equal(html.match(/<option value="book"/g)!.length, 3);
		assert.equal(html.match(/<option value="notes"/g)!.length, 2, "a PDF over the notes limit cannot be chosen as notes");
		assert.match(html, /A book is only stored and split into sections\./);
		assert.match(html, /Start \(3 files\)/);
	});
});

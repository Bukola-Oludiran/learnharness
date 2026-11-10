/**
 * Materials service (fork, phases 3a–3b — see FORK.md): upload → convert →
 * (review) → extract into the graph.
 *
 *   upload    stores the app's own copy and returns at once; the rest runs
 *             in this process, announced through `materials-changed`.
 *   convert   NOTES: one converter per format (ingest/convert.ts) builds a
 *             transcript. Text read from the file is trusted; text a vision
 *             model read is not. TESTS: the vision model reads the marked
 *             paper into questions, marks and tested ideas.
 *   review    anything a vision model read stops at `review` until the
 *             learner approves it — an editable transcript for notes, an
 *             editable question list for tests. A misread formula or mark
 *             would otherwise be recorded as fact.
 *   extract   upstream's notes pipeline, unchanged: extraction.importNotes
 *             under the source path `<course>/<file>`. A test contributes
 *             only its tested ideas (never the learner's answers), then its
 *             questions are linked to the ideas that source now holds and
 *             each marked question becomes a line of learner evidence.
 *
 * A material belongs to a course or to none (the library, phase 3b2). At
 * most MATERIAL_CONCURRENCY materials convert or extract at once; the rest
 * wait as `queued`, so a folder upload of hundreds of files neither floods
 * the model provider nor holds every file in memory.
 *
 * BOOKS (phase 4a) are stored and split into sections, never extracted:
 * the tutor reads them section by section (readBook), and a scanned page
 * is read by the vision model the first time its section is used. A notes
 * PDF long enough to be a book pauses for the learner's choice.
 *
 * In-flight work lives in a globalThis registry (the turn-liveness idiom:
 * Next dev gives each route its own module instance). A `processing`
 * record with no registry entry was orphaned by a restart and reads as
 * interrupted. Retry resumes at extraction once the learner has approved
 * (their edits are kept); before that it starts over from the stored files.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { abortExtraction, NotesImportError } from "../agent/subagents/extraction.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { emit } from "../core/events.ts";
import { bookContentsText, bookListText, sectionText } from "../core/book.ts";
import { cleanTestReading, testEvidenceOf, testIdeasText, testScore } from "../core/evidence.ts";
import { assembleTranscript, detectMaterialFormat, librarySourcePath, materialSourcePath, materialTitle, transcriptForExtraction } from "../core/material.ts";
import { LONG_NOTES_PAGES, MATERIAL_CONCURRENCY, MAX_BOOK_BYTES, MAX_MATERIAL_BYTES, MAX_TEST_PAGES, type MaterialFormat, type MaterialKind, type MaterialRecord, type MaterialView, type TestReading } from "../core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { extraction } from "./chat-handler.ts";
import { removeMaterialEvidence } from "./evidence.ts";
import { convertBook, createChapterProposer, pdfPageCount, type ChapterProposer } from "./ingest/book.ts";
import { convertMaterial, ConversionError } from "./ingest/convert.ts";
import { createTestLinker, createTestReader, TestReadError, type LinkableIdea, type TestLinker, type TestReader } from "./ingest/test-reader.ts";
import { createTranscriber, TranscriptionError, type Transcriber } from "./ingest/transcribe.ts";
import { sourceDirectory } from "./source-organization.ts";
import { stores, type Stores } from "./stores.ts";

export type MaterialOutcome =
	| { ok: true; material: MaterialView }
	| { ok: false; status: 400 | 404 | 409 | 413; code: string; error: string };

export interface UploadedFile {
	name: string;
	bytes: Uint8Array;
}

/** Where an upload goes: a course, or (no course) the library, filed under
 *  the file's folder-relative `path` when it came from a folder upload. */
export interface UploadTarget {
	courseId?: unknown;
	path?: string | null;
}

export interface MaterialsDeps {
	stores: Pick<Stores, "materialStore" | "courseStore" | "evidenceStore">;
	transcribe: Transcriber;
	readTest: TestReader;
	linkTest: TestLinker;
	/** The ideas a graph source currently holds (the linker's candidates). */
	sourceIdeas: (sourceId: string) => LinkableIdea[];
	/** A PDF's pages as PNGs, at most `limit` of them. */
	renderPdfPages: (path: string, limit: number) => Promise<Uint8Array[]>;
	/** Upstream's notes pipeline (extraction.importNotes). */
	importNotes: (input: { filePath: string; text: string }) => Promise<unknown>;
	/** Files the source in the source browser before extraction runs. */
	registerImport: (filePath: string) => void;
	abortExtraction: (sourceId: string) => void;
	removeEvidence: (materialId: string) => void;
	/** Books: chapter starts for a PDF with no bookmarks. Absent → equal sections. */
	proposeChapters?: ChapterProposer;
	/** Books: one PDF page as a PNG, for a scanned page's first read. */
	renderPdfPage?: (path: string, page: number) => Promise<Uint8Array | null>;
	/** Books: how long a section read waits for its scanned pages (the
	 *  tutor's tools time out at 30 s). */
	sectionWaitMs?: number;
}

export type BookRead = { ok: true; text: string } | { ok: false; error: string };

/** Scanned pages being read for one book, in the background. */
interface BookReadRun {
	queue: number[];
	running: boolean;
	error?: string;
}

interface MaterialSlots {
	active: number;
	waiting: (() => void)[];
}
interface LhMaterialsGlobal {
	__lhMaterialRuns?: Map<string, AbortController>;
	__lhMaterialSlots?: MaterialSlots;
	__lhBookReads?: Map<string, BookReadRun>;
}
function bookReads(): Map<string, BookReadRun> {
	const g = globalThis as typeof globalThis & LhMaterialsGlobal;
	return (g.__lhBookReads ??= new Map());
}
function slots(): MaterialSlots {
	const g = globalThis as typeof globalThis & LhMaterialsGlobal;
	return (g.__lhMaterialSlots ??= { active: 0, waiting: [] });
}
/** Take a slot, waiting in line for one. False when aborted while waiting. */
function acquireSlot(signal: AbortSignal): Promise<boolean> {
	const state = slots();
	if (state.active < MATERIAL_CONCURRENCY) {
		state.active++;
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const grant = () => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		};
		const onAbort = () => {
			state.waiting.splice(state.waiting.indexOf(grant), 1);
			resolve(false);
		};
		state.waiting.push(grant);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/** Hand the slot to the next in line, or free it. */
function releaseSlot(): void {
	const state = slots();
	const next = state.waiting.shift();
	if (next) next();
	else state.active--;
}
function runs(): Map<string, AbortController> {
	const g = globalThis as typeof globalThis & LhMaterialsGlobal;
	return (g.__lhMaterialRuns ??= new Map());
}

const sourceIdOf = (sourcePath: string) => `src_${createHash("sha256").update(sourcePath).digest("hex").slice(0, 12)}`;
const NOT_FOUND = { ok: false, status: 404, code: "material_not_found", error: "No such material" } as const;
const extensionOf = (name: string) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? "bin";
const baseName = (name: string) => name.split(/[\\/]/).pop()?.trim() || "material";
const pages = (count: number) => (count === 1 ? "1 page" : `${count} pages`);

function failureMessage(error: unknown): string {
	if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError) return error.envelope.error;
	if (error instanceof NotesImportError && error.outcome === "partial") {
		return `Only part of this material reached the graph: ${error.message}`;
	}
	if (error instanceof Error) return error.message || "Something went wrong.";
	return String(error);
}

export function createMaterialsService(deps: MaterialsDeps) {
	const { materialStore, courseStore, evidenceStore } = deps.stores;

	const view = (record: MaterialRecord): MaterialView => ({
		...record,
		interrupted: record.status === "processing" && !runs().has(record.id),
	});

	/** Merge a patch into the current record. A material deleted mid-run
	 *  has no record left — the patch is dropped, never recreated. */
	function update(id: string, patch: Partial<MaterialRecord>): MaterialRecord | null {
		const current = materialStore.getMaterial(id);
		if (!current) return null;
		const next = { ...current, ...patch };
		for (const key of Object.keys(patch) as (keyof MaterialRecord)[]) {
			if (patch[key] === undefined) delete next[key];
		}
		materialStore.saveMaterial(next);
		return next;
	}

	async function extractNotes(id: string, signal: AbortSignal): Promise<void> {
		const record = update(id, { status: "processing", stage: "extracting", error: undefined });
		const text = materialStore.readText(id);
		if (!record || text === null) return;
		deps.registerImport(record.sourcePath);
		await deps.importNotes({ filePath: record.sourcePath, text: transcriptForExtraction(text) });
		if (signal.aborted) return;
		update(id, { status: "ready", stage: undefined, graphSourceId: sourceIdOf(record.sourcePath) });
		emit("sources-changed", {});
	}

	/** An approved test: tested ideas → graph, questions → ideas, marks → evidence. */
	async function extractTest(id: string, signal: AbortSignal): Promise<void> {
		const record = update(id, { status: "processing", stage: "extracting", error: undefined });
		const reading = materialStore.readReading(id);
		if (!record || !reading) return;
		const sourceId = sourceIdOf(record.sourcePath);
		const ideasText = testIdeasText(record.title, reading);
		if (ideasText) {
			deps.registerImport(record.sourcePath);
			await deps.importNotes({ filePath: record.sourcePath, text: ideasText });
			if (signal.aborted) return;
			emit("sources-changed", {});
		}
		const candidates = deps.sourceIdeas(sourceId);
		const links = await deps.linkTest(reading.questions, candidates, signal);
		if (signal.aborted) return;
		const known = new Set(candidates.map((idea) => idea.id));
		const linked: TestReading = {
			...reading,
			questions: reading.questions.map((q, i) => ({ ...q, nodeIds: (links[i] ?? []).filter((nodeId) => known.has(nodeId)) })),
		};
		materialStore.writeReading(id, linked);
		// Re-approval replaces the paper's earlier results; the ids are stable.
		deps.removeEvidence(id);
		evidenceStore.append(testEvidenceOf(record, linked, record.createdAt));
		const marked = linked.questions.filter((q) => q.outcome !== "unmarked");
		update(id, {
			status: "ready",
			stage: undefined,
			score: testScore(linked),
			unplaced: marked.filter((q) => (q.nodeIds ?? []).length === 0).length,
			...(ideasText ? { graphSourceId: sourceId } : {}),
		});
	}

	const extract = (id: string, kind: MaterialKind, signal: AbortSignal) => (kind === "test" ? extractTest(id, signal) : extractNotes(id, signal));

	/** Run `work` as this material's one in-flight job, once a slot is free;
	 *  any failure lands on the record as `failed` with a message the
	 *  learner can act on. */
	function start(id: string, work: (signal: AbortSignal) => Promise<void>): void {
		const controller = new AbortController();
		runs().set(id, controller);
		if (slots().active >= MATERIAL_CONCURRENCY) update(id, { status: "processing", stage: "queued" });
		void (async () => {
			let held = false;
			try {
				held = await acquireSlot(controller.signal);
				if (held) await work(controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) {
					const expected = error instanceof ConversionError || error instanceof TranscriptionError || error instanceof TestReadError;
					if (!expected) console.error(`[material ${id}]`, error);
					update(id, { status: "failed", stage: undefined, error: failureMessage(error) });
				}
			} finally {
				if (held) releaseSlot();
				if (runs().get(id) === controller) runs().delete(id);
				// The registry entry is part of the view (`interrupted`).
				emit("materials-changed", {});
			}
		})();
	}

	async function convertNotes(id: string, record: MaterialRecord, signal: AbortSignal): Promise<void> {
		const [original] = materialStore.originalPaths(id);
		if (!original) throw new ConversionError("The stored file is missing. Upload it again.");
		// A PDF this long is probably a book: ask before extracting all of it.
		if (record.format === "pdf" && !record.lengthAccepted) {
			const pageCount = await pdfPageCount(original);
			if (signal.aborted) return;
			if (pageCount !== null && pageCount > LONG_NOTES_PAGES) {
				update(id, { status: "review", stage: undefined, pendingChoice: "book-or-notes", pageCount });
				return;
			}
		}
		const conversion = await convertMaterial(record.format, original, deps.transcribe, signal);
		if (signal.aborted) return;
		const { text, aiReadParts } = assembleTranscript(conversion.parts);
		materialStore.writeText(id, text);
		if (aiReadParts > 0) {
			update(id, { status: "review", stage: undefined, aiReadParts, notice: conversion.notice });
			return;
		}
		update(id, { aiReadParts: 0, notice: conversion.notice, approvedAt: new Date().toISOString() });
		await extractNotes(id, signal);
	}

	/** The paper's pages as images, in upload order; a PDF contributes its pages. */
	async function convertTest(id: string, signal: AbortSignal): Promise<void> {
		const originals = materialStore.originalPaths(id);
		if (originals.length === 0) throw new ConversionError("The stored files are missing. Upload the test again.");
		const images: Uint8Array[] = [];
		for (const original of originals) {
			signal.throwIfAborted();
			if (original.endsWith(".pdf")) images.push(...(await deps.renderPdfPages(original, MAX_TEST_PAGES + 1 - images.length)));
			else images.push(new Uint8Array(await fs.readFile(original)));
		}
		if (images.length === 0) throw new ConversionError("No pages could be read from this test.");
		const over = images.length - MAX_TEST_PAGES;
		const reading = await deps.readTest(images.slice(0, MAX_TEST_PAGES), signal);
		if (signal.aborted) return;
		materialStore.writeReading(id, reading);
		update(id, {
			status: "review",
			stage: undefined,
			aiReadParts: Math.min(images.length, MAX_TEST_PAGES),
			notice: over > 0 ? `Only the first ${MAX_TEST_PAGES} pages were read.` : undefined,
		});
	}

	/** A book: pages and sections, stored. Nothing reaches the graph. */
	async function convertBookWork(id: string, record: MaterialRecord, signal: AbortSignal): Promise<void> {
		const [original] = materialStore.originalPaths(id);
		if (!original) throw new ConversionError("The stored file is missing. Upload it again.");
		const book = await convertBook(record.format, original, deps.proposeChapters ?? (async () => []), signal);
		if (signal.aborted) return;
		materialStore.writeBookPages(id, book.pages);
		const scanned = book.pages.filter((page) => page.kind === "scanned").length;
		update(id, {
			status: "ready",
			stage: undefined,
			sections: book.sections,
			sectioning: book.sectioning,
			pageCount: book.pages.length,
			...(book.title ? { title: book.title } : {}),
			notice: scanned > 0 ? `${scanned === 1 ? "1 scanned page" : `${scanned} scanned pages`}: read by the vision model when their section is first used.` : undefined,
		});
	}

	/** Read a book's queued scanned pages one by one, keeping each as it lands. */
	async function runBookRead(id: string, run: BookReadRun): Promise<void> {
		run.running = true;
		run.error = undefined;
		try {
			const [original] = materialStore.originalPaths(id);
			if (!original || !deps.renderPdfPage) throw new Error("Scanned pages cannot be read here.");
			while (run.queue.length > 0) {
				if (!materialStore.getMaterial(id)) return; // deleted mid-read
				const page = run.queue[0]!;
				const png = await deps.renderPdfPage(original, page);
				materialStore.writePageTranscript(id, page, png ? await deps.transcribe(png, `Page ${page}`) : "");
				run.queue.shift();
			}
		} catch (error) {
			run.error = failureMessage(error);
			run.queue.length = 0;
		} finally {
			run.running = false;
		}
	}

	function startConversion(id: string): void {
		start(id, async (signal) => {
			const record = update(id, { status: "processing", stage: "converting", error: undefined, notice: undefined, aiReadParts: 0, approvedAt: undefined });
			if (!record) return;
			if (record.kind === "book") await convertBookWork(id, record, signal);
			else if (record.kind === "test") await convertTest(id, signal);
			else await convertNotes(id, record, signal);
		});
	}

	function create(target: UploadTarget, kind: MaterialKind, format: MaterialFormat, name: string, files: readonly UploadedFile[]): MaterialOutcome {
		const inLibrary = target.courseId === undefined || target.courseId === null || target.courseId === "";
		const course = typeof target.courseId === "string" && !inLibrary ? courseStore.getCourse(target.courseId) : null;
		if (!inLibrary && !course) return { ok: false, status: 404, code: "course_not_found", error: "No such course" };
		const record = materialStore.createMaterial(
			{
				title: materialTitle(name),
				kind,
				format,
				...(course ? { courseId: course.id } : {}),
				fileName: name,
				sections: [],
				status: "processing",
				stage: "converting",
				aiReadParts: 0,
				sourcePath: course ? materialSourcePath(course.title, name) : librarySourcePath(target.path, name),
			},
			files.map((file) => ({ bytes: file.bytes, extension: extensionOf(file.name) })),
		);
		if (course) courseStore.saveCourse({ ...course, materialIds: [...new Set([...(course.materialIds ?? []), record.id])] });
		startConversion(record.id);
		return { ok: true, material: view(materialStore.getMaterial(record.id) ?? record) };
	}

	const retryable = (record: MaterialRecord) => record.status === "failed" || view(record).interrupted;
	function retry(record: MaterialRecord): void {
		if (record.approvedAt) {
			update(record.id, { status: "processing", stage: "extracting", error: undefined });
			start(record.id, (signal) => extract(record.id, record.kind, signal));
		} else {
			update(record.id, { status: "processing", stage: "converting", error: undefined });
			startConversion(record.id);
		}
	}

	return {
		/** Every material — the library's view — oldest upload first. */
		listMaterials(): MaterialView[] {
			return materialStore.listMaterials().map(view);
		},

		/** A course's materials, oldest upload first. */
		listCourseMaterials(courseId: string): MaterialView[] {
			return materialStore.listMaterials().filter((m) => m.courseId === courseId).map(view);
		},

		/** One material with its transcript (notes) or reading (tests). */
		getMaterial(id: string): { material: MaterialView; text: string | null; reading: TestReading | null } | null {
			const record = materialStore.getMaterial(id);
			return record ? { material: view(record), text: materialStore.readText(id), reading: materialStore.readReading(id) } : null;
		},

		/** Store an upload of notes and start converting it. */
		uploadMaterial(target: UploadTarget, fileName: string, bytes: Uint8Array): MaterialOutcome {
			if (bytes.byteLength > MAX_MATERIAL_BYTES) return { ok: false, status: 413, code: "too_large", error: "Too big. Max 25 MB." };
			const name = baseName(fileName);
			const verdict = detectMaterialFormat(name, bytes);
			if ("refused" in verdict) return { ok: false, status: 400, code: "unsupported", error: verdict.refused };
			// An EPUB is always a book.
			if (verdict.format === "epub") return create({ path: target.path }, "book", "epub", name, [{ name, bytes }]);
			return create(target, "notes", verdict.format, name, [{ name, bytes }]);
		},

		/** Store a book (PDF or EPUB) and split it into sections. A book
		 *  belongs to no course until a syllabus attaches it (phase 4b). */
		uploadBook(target: UploadTarget, fileName: string, bytes: Uint8Array): MaterialOutcome {
			if (bytes.byteLength > MAX_BOOK_BYTES) return { ok: false, status: 413, code: "too_large", error: "Too big. Max 200 MB." };
			const name = baseName(fileName);
			const verdict = detectMaterialFormat(name, bytes);
			if ("refused" in verdict) return { ok: false, status: 400, code: "unsupported", error: verdict.refused };
			if (verdict.format !== "pdf" && verdict.format !== "epub") return { ok: false, status: 400, code: "unsupported", error: "A book must be a PDF or an EPUB." };
			return create({ path: target.path }, "book", verdict.format, name, [{ name, bytes }]);
		},

		/** A long PDF paused for the learner's choice: make it a book, or
		 *  extract it as notes after all. */
		chooseMaterialKind(id: string, choice: unknown): MaterialOutcome {
			const record = materialStore.getMaterial(id);
			if (!record) return NOT_FOUND;
			if (record.pendingChoice !== "book-or-notes") return { ok: false, status: 409, code: "no_choice", error: "This material is not waiting for a choice." };
			if (choice !== "book" && choice !== "notes") return { ok: false, status: 400, code: "bad_choice", error: "Choose book or notes." };
			if (choice === "book") {
				// A book belongs to no course yet.
				const course = record.courseId ? courseStore.getCourse(record.courseId) : null;
				if (course?.materialIds?.includes(id)) courseStore.saveCourse({ ...course, materialIds: course.materialIds.filter((m) => m !== id) });
				update(id, { kind: "book", courseId: undefined, pendingChoice: undefined, status: "processing", stage: "converting" });
			} else update(id, { pendingChoice: undefined, lengthAccepted: true, status: "processing", stage: "converting" });
			startConversion(id);
			return { ok: true, material: view(materialStore.getMaterial(id)!) };
		},

		/** The tutor's view of the library's books (read_material, no arguments). */
		bookList(): string {
			return bookListText(materialStore.listMaterials().filter((m) => m.kind === "book"));
		},

		/** One book's sections, or one section's text. A section's scanned
		 *  pages are read on first use: this waits briefly for them, then
		 *  answers with what is there and says which are still being read. */
		async readBook(id: string, sectionId?: string, part?: number): Promise<BookRead> {
			const record = materialStore.getMaterial(id);
			if (!record || record.kind !== "book") return { ok: false, error: `No book with id ${id}. Call read_material with no arguments to list the learner's books.` };
			if (record.status !== "ready") return { ok: false, error: `"${record.title}" is not ready yet (${record.status}).` };
			if (!sectionId) return { ok: true, text: bookContentsText(record) };
			const wanted = sectionId.trim().replace(/^\[|\]$/g, "").toLowerCase();
			const section = record.sections.find((s) => s.id.toLowerCase() === wanted) ?? record.sections.find((s) => s.title.toLowerCase() === wanted);
			const pages = materialStore.readBookPages(id);
			if (!section || !pages) return { ok: false, error: `"${record.title}" has no section ${sectionId}. Call read_material with only the material id to list its sections.` };
			let read = sectionText(record, section, pages, materialStore.readPageTranscripts(id), part);
			if (read.pending.length > 0) {
				const run = bookReads().get(id) ?? { queue: [], running: false };
				bookReads().set(id, run);
				for (const page of read.pending) if (!run.queue.includes(page)) run.queue.push(page);
				if (!run.running) void runBookRead(id, run);
				const deadline = Date.now() + (deps.sectionWaitMs ?? 20_000);
				while (run.running && Date.now() < deadline && read.pending.some((page) => run.queue.includes(page))) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (run.error) return { ok: false, error: `The scanned pages of this section could not be read: ${run.error}` };
				read = sectionText(record, section, pages, materialStore.readPageTranscripts(id), part);
			}
			return { ok: true, text: read.text };
		},

		/** Store a marked test — its pages as photos, or one scanned PDF — as ONE material. */
		uploadTest(target: UploadTarget, files: readonly UploadedFile[]): MaterialOutcome {
			if (files.length === 0) return { ok: false, status: 400, code: "no_files", error: "Choose the photos or PDF of the marked test." };
			if (files.length > MAX_TEST_PAGES) return { ok: false, status: 400, code: "too_many_pages", error: `A test can have at most ${pages(MAX_TEST_PAGES)}.` };
			if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > 2 * MAX_MATERIAL_BYTES) {
				return { ok: false, status: 413, code: "too_large", error: "Too big. Max 50 MB for one test." };
			}
			const named = files.map((file) => ({ name: baseName(file.name), bytes: file.bytes }));
			const formats: MaterialFormat[] = [];
			for (const file of named) {
				const verdict = detectMaterialFormat(file.name, file.bytes);
				if ("refused" in verdict) return { ok: false, status: 400, code: "unsupported", error: `${file.name}: ${verdict.refused}` };
				if (verdict.format !== "image" && verdict.format !== "pdf") {
					return { ok: false, status: 400, code: "unsupported", error: `${file.name}: a marked test must be photos or a PDF.` };
				}
				formats.push(verdict.format);
			}
			if (formats.includes("pdf") && named.length > 1) {
				return { ok: false, status: 400, code: "unsupported", error: "Upload either one PDF or the pages as photos, not both." };
			}
			return create(target, "test", formats[0]!, named[0]!.name, named);
		},

		/**
		 * Approve a material waiting for review and extract it. Notes send an
		 * edited transcript (`text`); tests send the edited `reading`. Either
		 * may be omitted to approve what was read as it stands.
		 */
		approveMaterial(id: string, edits: { text?: unknown; reading?: unknown }): MaterialOutcome {
			const record = materialStore.getMaterial(id);
			if (!record) return NOT_FOUND;
			if (record.status !== "review" || record.pendingChoice) return { ok: false, status: 409, code: "not_in_review", error: "This material is not waiting for review." };
			if (record.kind === "test") {
				if (edits.reading !== undefined) {
					const reading = cleanTestReading(edits.reading);
					if (!reading) return { ok: false, status: 400, code: "empty_reading", error: "The test has no questions. Discard it instead." };
					materialStore.writeReading(id, reading);
				}
			} else if (edits.text !== undefined) {
				if (typeof edits.text !== "string" || edits.text.trim() === "") {
					return { ok: false, status: 400, code: "empty_text", error: "The transcript is empty. Discard the material instead." };
				}
				materialStore.writeText(id, edits.text);
			}
			// Flip the record before returning so the caller already sees the new state.
			update(id, { status: "processing", stage: "extracting", approvedAt: new Date().toISOString() });
			start(id, (signal) => extract(id, record.kind, signal));
			return { ok: true, material: view(materialStore.getMaterial(id)!) };
		},

		/** Retry a failed or interrupted material: from extraction once
		 *  approved, otherwise from the stored files. */
		retryMaterial(id: string): MaterialOutcome {
			const record = materialStore.getMaterial(id);
			if (!record) return NOT_FOUND;
			if (!retryable(record)) return { ok: false, status: 409, code: "not_retryable", error: "This material is not in a failed state." };
			retry(record);
			return { ok: true, material: view(materialStore.getMaterial(id)!) };
		},

		/** Retry every failed or interrupted material (after a usage limit or
		 *  a restart mid-folder). Returns how many were restarted. */
		retryAllMaterials(): number {
			const stuck = materialStore.listMaterials().filter(retryable);
			for (const record of stuck) retry(record);
			return stuck.length;
		},

		/** Remove the stored files and record, and a test's results with it.
		 *  Ideas already in the graph stay. */
		deleteMaterial(id: string): boolean {
			const record = materialStore.getMaterial(id);
			if (!record) return false;
			runs().get(id)?.abort();
			runs().delete(id);
			bookReads().delete(id);
			if (record.stage === "extracting") deps.abortExtraction(sourceIdOf(record.sourcePath));
			if (record.kind === "test") deps.removeEvidence(id);
			const course = record.courseId ? courseStore.getCourse(record.courseId) : null;
			if (course?.materialIds?.includes(id)) {
				courseStore.saveCourse({ ...course, materialIds: course.materialIds.filter((m) => m !== id) });
			}
			return materialStore.deleteMaterial(id);
		},
	};
}

export const materials = createMaterialsService({
	stores,
	transcribe: createTranscriber(),
	readTest: createTestReader(),
	linkTest: createTestLinker(),
	sourceIdeas: (sourceId) =>
		stores.graphStore
			.readNodes()
			.filter((node) => node.provenance.some((point) => point.chatId === sourceId))
			.map((node) => ({ id: node.id, name: node.name, statement: node.statement })),
	renderPdfPages: async (path, limit) => {
		const wanted = Array.from({ length: Math.max(0, limit) }, (_, i) => i + 1);
		return (await getHeadless().renderPdfPages(path, wanted, { dpi: 150 })).map((page) => new Uint8Array(page.png));
	},
	importNotes: (input) => extraction.importNotes(input),
	registerImport: (filePath) => sourceDirectory.registerImport(filePath),
	abortExtraction: (sourceId) => void abortExtraction(sourceId),
	removeEvidence: removeMaterialEvidence,
	proposeChapters: createChapterProposer(),
	renderPdfPage: async (path, page) => {
		const [rendered] = await getHeadless().renderPdfPages(path, [page], { dpi: 150 });
		return rendered ? new Uint8Array(rendered.png) : null;
	},
});

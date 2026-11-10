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
import { cleanTestReading, testEvidenceOf, testIdeasText, testScore } from "../core/evidence.ts";
import { assembleTranscript, detectMaterialFormat, materialSourcePath, materialTitle, transcriptForExtraction } from "../core/material.ts";
import { MAX_MATERIAL_BYTES, MAX_TEST_PAGES, type MaterialFormat, type MaterialKind, type MaterialRecord, type MaterialView, type TestReading } from "../core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { extraction } from "./chat-handler.ts";
import { removeMaterialEvidence } from "./evidence.ts";
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
}

interface LhMaterialsGlobal {
	__lhMaterialRuns?: Map<string, AbortController>;
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

	/** Run `work` as this material's one in-flight job; any failure lands
	 *  on the record as `failed` with a message the learner can act on. */
	function start(id: string, work: (signal: AbortSignal) => Promise<void>): void {
		const controller = new AbortController();
		runs().set(id, controller);
		void (async () => {
			try {
				await work(controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) {
					const expected = error instanceof ConversionError || error instanceof TranscriptionError || error instanceof TestReadError;
					if (!expected) console.error(`[material ${id}]`, error);
					update(id, { status: "failed", stage: undefined, error: failureMessage(error) });
				}
			} finally {
				if (runs().get(id) === controller) runs().delete(id);
				// The registry entry is part of the view (`interrupted`).
				emit("materials-changed", {});
			}
		})();
	}

	async function convertNotes(id: string, record: MaterialRecord, signal: AbortSignal): Promise<void> {
		const [original] = materialStore.originalPaths(id);
		if (!original) throw new ConversionError("The stored file is missing. Upload it again.");
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

	function startConversion(id: string): void {
		start(id, async (signal) => {
			const record = update(id, { status: "processing", stage: "converting", error: undefined, notice: undefined, aiReadParts: 0, approvedAt: undefined });
			if (!record) return;
			if (record.kind === "test") await convertTest(id, signal);
			else await convertNotes(id, record, signal);
		});
	}

	function create(courseId: unknown, kind: MaterialKind, format: MaterialFormat, name: string, files: readonly UploadedFile[]): MaterialOutcome {
		const course = typeof courseId === "string" ? courseStore.getCourse(courseId) : null;
		if (!course) return { ok: false, status: 404, code: "course_not_found", error: "No such course" };
		const record = materialStore.createMaterial(
			{
				title: materialTitle(name),
				kind,
				format,
				courseId: course.id,
				fileName: name,
				sections: [],
				status: "processing",
				stage: "converting",
				aiReadParts: 0,
				sourcePath: materialSourcePath(course.title, name),
			},
			files.map((file) => ({ bytes: file.bytes, extension: extensionOf(file.name) })),
		);
		courseStore.saveCourse({ ...course, materialIds: [...new Set([...(course.materialIds ?? []), record.id])] });
		startConversion(record.id);
		return { ok: true, material: view(materialStore.getMaterial(record.id) ?? record) };
	}

	return {
		/** A course's materials, oldest upload first. */
		listCourseMaterials(courseId: string): MaterialView[] {
			return materialStore.listMaterials().filter((m) => m.courseId === courseId).map(view);
		},

		/** One material with its transcript (notes) or reading (tests). */
		getMaterial(id: string): { material: MaterialView; text: string | null; reading: TestReading | null } | null {
			const record = materialStore.getMaterial(id);
			return record ? { material: view(record), text: materialStore.readText(id), reading: materialStore.readReading(id) } : null;
		},

		/** Store an upload of notes against a course and start converting it. */
		uploadMaterial(courseId: unknown, fileName: string, bytes: Uint8Array): MaterialOutcome {
			if (bytes.byteLength > MAX_MATERIAL_BYTES) return { ok: false, status: 413, code: "too_large", error: "Too big. Max 25 MB." };
			const name = baseName(fileName);
			const verdict = detectMaterialFormat(name, bytes);
			if ("refused" in verdict) return { ok: false, status: 400, code: "unsupported", error: verdict.refused };
			return create(courseId, "notes", verdict.format, name, [{ name, bytes }]);
		},

		/** Store a marked test — its pages as photos, or one scanned PDF — as ONE material. */
		uploadTest(courseId: unknown, files: readonly UploadedFile[]): MaterialOutcome {
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
			return create(courseId, "test", formats[0]!, named[0]!.name, named);
		},

		/**
		 * Approve a material waiting for review and extract it. Notes send an
		 * edited transcript (`text`); tests send the edited `reading`. Either
		 * may be omitted to approve what was read as it stands.
		 */
		approveMaterial(id: string, edits: { text?: unknown; reading?: unknown }): MaterialOutcome {
			const record = materialStore.getMaterial(id);
			if (!record) return NOT_FOUND;
			if (record.status !== "review") return { ok: false, status: 409, code: "not_in_review", error: "This material is not waiting for review." };
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
			if (!(record.status === "failed" || view(record).interrupted)) {
				return { ok: false, status: 409, code: "not_retryable", error: "This material is not in a failed state." };
			}
			if (record.approvedAt) {
				update(id, { status: "processing", stage: "extracting", error: undefined });
				start(id, (signal) => extract(id, record.kind, signal));
			} else {
				update(id, { status: "processing", stage: "converting", error: undefined });
				startConversion(id);
			}
			return { ok: true, material: view(materialStore.getMaterial(id)!) };
		},

		/** Remove the stored files and record, and a test's results with it.
		 *  Ideas already in the graph stay. */
		deleteMaterial(id: string): boolean {
			const record = materialStore.getMaterial(id);
			if (!record) return false;
			runs().get(id)?.abort();
			runs().delete(id);
			if (record.stage === "extracting") deps.abortExtraction(sourceIdOf(record.sourcePath));
			if (record.kind === "test") deps.removeEvidence(id);
			const course = courseStore.getCourse(record.courseId);
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
});

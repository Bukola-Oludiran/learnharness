/**
 * Materials service (fork, phase 3a — see FORK.md): upload → convert →
 * (review) → extract into the graph.
 *
 *   upload    stores the app's own copy and returns at once; the rest runs
 *             in this process, announced through `materials-changed`.
 *   convert   one converter per format (ingest/convert.ts). Text read from
 *             the file is trusted; text a vision model read is not.
 *   review    a material with ANY AI-read part stops at `review` until the
 *             learner approves the (editable) transcript. A misread formula
 *             would otherwise merge into the graph as fact.
 *   extract   upstream's notes pipeline, unchanged: extraction.importNotes
 *             over the transcript, under the source path `<course>/<file>`.
 *
 * In-flight work lives in a globalThis registry (the turn-liveness idiom:
 * Next dev gives each route its own module instance). A `processing`
 * record with no registry entry was orphaned by a restart and reads as
 * interrupted; Retry starts over from the stored original.
 */

import { createHash } from "node:crypto";
import { abortExtraction, NotesImportError } from "../agent/subagents/extraction.ts";
import { emit } from "../core/events.ts";
import { assembleTranscript, detectMaterialFormat, materialSourcePath, materialTitle, transcriptForExtraction } from "../core/material.ts";
import { MAX_MATERIAL_BYTES, type MaterialRecord, type MaterialView } from "../core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { extraction } from "./chat-handler.ts";
import { convertMaterial, ConversionError } from "./ingest/convert.ts";
import { createTranscriber, TranscriptionError, type Transcriber } from "./ingest/transcribe.ts";
import { sourceDirectory } from "./source-organization.ts";
import { stores, type Stores } from "./stores.ts";

export type MaterialOutcome =
	| { ok: true; material: MaterialView }
	| { ok: false; status: 400 | 404 | 409 | 413; code: string; error: string };

export interface MaterialsDeps {
	stores: Pick<Stores, "materialStore" | "courseStore">;
	transcribe: Transcriber;
	/** Upstream's notes pipeline (extraction.importNotes). */
	importNotes: (input: { filePath: string; text: string }) => Promise<unknown>;
	/** Files the source in the source browser before extraction runs. */
	registerImport: (filePath: string) => void;
	abortExtraction: (sourceId: string) => void;
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

function failureMessage(error: unknown): string {
	if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError) return error.envelope.error;
	if (error instanceof NotesImportError && error.outcome === "partial") {
		return `Only part of this material reached the graph: ${error.message}`;
	}
	if (error instanceof Error) return error.message || "Something went wrong.";
	return String(error);
}

export function createMaterialsService(deps: MaterialsDeps) {
	const { materialStore, courseStore } = deps.stores;

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

	async function extract(id: string, signal: AbortSignal): Promise<void> {
		const record = update(id, { status: "processing", stage: "extracting", error: undefined });
		const text = materialStore.readText(id);
		if (!record || text === null) return;
		deps.registerImport(record.sourcePath);
		await deps.importNotes({ filePath: record.sourcePath, text: transcriptForExtraction(text) });
		if (signal.aborted) return;
		update(id, { status: "ready", stage: undefined, graphSourceId: sourceIdOf(record.sourcePath) });
		emit("sources-changed", {});
	}

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
					if (!(error instanceof ConversionError || error instanceof TranscriptionError)) console.error(`[material ${id}]`, error);
					update(id, { status: "failed", stage: undefined, error: failureMessage(error) });
				}
			} finally {
				if (runs().get(id) === controller) runs().delete(id);
				// The registry entry is part of the view (`interrupted`).
				emit("materials-changed", {});
			}
		})();
	}

	function startConversion(id: string): void {
		start(id, async (signal) => {
			const record = update(id, { status: "processing", stage: "converting", error: undefined, notice: undefined, aiReadParts: 0 });
			const original = materialStore.originalPath(id);
			if (!record || !original) throw new ConversionError("The stored file is missing. Upload it again.");
			const conversion = await convertMaterial(record.format, original, deps.transcribe, signal);
			if (signal.aborted) return;
			const { text, aiReadParts } = assembleTranscript(conversion.parts);
			materialStore.writeText(id, text);
			if (aiReadParts > 0) {
				update(id, { status: "review", stage: undefined, aiReadParts, notice: conversion.notice });
				return;
			}
			update(id, { aiReadParts: 0, notice: conversion.notice });
			await extract(id, signal);
		});
	}

	return {
		/** A course's materials, oldest upload first. */
		listCourseMaterials(courseId: string): MaterialView[] {
			return materialStore.listMaterials().filter((m) => m.courseId === courseId).map(view);
		},

		/** One material and its transcript (null before conversion). */
		getMaterial(id: string): { material: MaterialView; text: string | null } | null {
			const record = materialStore.getMaterial(id);
			return record ? { material: view(record), text: materialStore.readText(id) } : null;
		},

		/** Store an upload against a course and start converting it. */
		uploadMaterial(courseId: unknown, fileName: string, bytes: Uint8Array): MaterialOutcome {
			const course = typeof courseId === "string" ? courseStore.getCourse(courseId) : null;
			if (!course) return { ok: false, status: 404, code: "course_not_found", error: "No such course" };
			if (bytes.byteLength > MAX_MATERIAL_BYTES) return { ok: false, status: 413, code: "too_large", error: "Too big. Max 25 MB." };
			const name = fileName.split(/[\\/]/).pop()?.trim() || "material";
			const verdict = detectMaterialFormat(name, bytes);
			if ("refused" in verdict) return { ok: false, status: 400, code: "unsupported", error: verdict.refused };
			const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? "bin";
			const record = materialStore.createMaterial(
				{
					title: materialTitle(name),
					kind: "notes",
					format: verdict.format,
					courseId: course.id,
					fileName: name,
					sections: [],
					status: "processing",
					stage: "converting",
					aiReadParts: 0,
					sourcePath: materialSourcePath(course.title, name),
				},
				bytes,
				extension,
			);
			courseStore.saveCourse({ ...course, materialIds: [...new Set([...(course.materialIds ?? []), record.id])] });
			startConversion(record.id);
			return { ok: true, material: view(materialStore.getMaterial(record.id) ?? record) };
		},

		/** Approve a reviewed transcript (optionally edited) and extract it. */
		approveMaterial(id: string, editedText: unknown): MaterialOutcome {
			const record = materialStore.getMaterial(id);
			if (!record) return NOT_FOUND;
			if (record.status !== "review") return { ok: false, status: 409, code: "not_in_review", error: "This material is not waiting for review." };
			if (editedText !== undefined) {
				if (typeof editedText !== "string" || editedText.trim() === "") {
					return { ok: false, status: 400, code: "empty_text", error: "The transcript is empty. Discard the material instead." };
				}
				materialStore.writeText(id, editedText);
			}
			// Flip the record before returning so the caller already sees the new state.
			update(id, { status: "processing", stage: "extracting" });
			start(id, (signal) => extract(id, signal));
			return { ok: true, material: view(materialStore.getMaterial(id)!) };
		},

		/** Start over from the stored original (a failed or interrupted material). */
		retryMaterial(id: string): MaterialOutcome {
			const record = materialStore.getMaterial(id);
			if (!record) return NOT_FOUND;
			if (!(record.status === "failed" || view(record).interrupted)) {
				return { ok: false, status: 409, code: "not_retryable", error: "This material is not in a failed state." };
			}
			update(id, { status: "processing", stage: "converting", error: undefined });
			startConversion(id);
			return { ok: true, material: view(materialStore.getMaterial(id)!) };
		},

		/** Remove the stored file and record. Ideas already in the graph stay. */
		deleteMaterial(id: string): boolean {
			const record = materialStore.getMaterial(id);
			if (!record) return false;
			runs().get(id)?.abort();
			runs().delete(id);
			if (record.stage === "extracting") deps.abortExtraction(sourceIdOf(record.sourcePath));
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
	importNotes: (input) => extraction.importNotes(input),
	registerImport: (filePath) => sourceDirectory.registerImport(filePath),
	abortExtraction: (sourceId) => void abortExtraction(sourceId),
});

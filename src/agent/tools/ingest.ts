import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { MAX_MATERIAL_BYTES, MAX_TEST_PAGES, type MaterialKind, type MaterialView } from "../../core/contracts.ts";
import { ingestResultText, materialStatusLine } from "../../core/material.ts";

/**
 * The tutor's material tools (fork, phase 3c — see FORK.md). Teacher only.
 *
 * ingest_material  adds the learner's own files to their library from
 *                  inside a session — the same pipeline as a Library
 *                  upload (formats, size cap, queue, review). It starts
 *                  the work and returns at once (owner, 2026-11-10: the
 *                  lesson carries on; review is the learner's, in the
 *                  Library).
 * material_status  where added files stand.
 *
 * The agent layer may not import the server, so the materials service
 * arrives as `deps` (wired in server/material-tools.ts). Paths go through
 * the shared file-access policy, like read and show_image.
 * Descriptions and result wording approved by the owner, 2026-11-10.
 */

export const MAX_INGEST_PATHS = 10;
const STATUS_DEFAULT = 10;

export type IngestStart = { ok: true; id: string } | { ok: false; error: string };

export interface MaterialToolDeps {
	/** Start one material from files already read. Notes take one file; a
	 *  test takes its pages. Never throws for a refusal the learner can fix. */
	ingest: (kind: Extract<MaterialKind, "notes" | "test">, files: { name: string; bytes: Uint8Array }[]) => IngestStart;
	/** Materials by id, or (no ids) every material, oldest first. */
	materials: (ids?: readonly string[]) => MaterialView[];
}

const ingestInput = Type.Object({
	kind: Type.Union([Type.Literal("notes"), Type.Literal("test")], {
		description: "notes: each path becomes its own material. test: all paths are the pages, in order, of ONE marked test.",
	}),
	paths: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: MAX_INGEST_PATHS,
		description: "Paths to the learner's files (relative or absolute)",
	}),
});

const statusInput = Type.Object({
	ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50, description: "Material ids from ingest_material. Omit to list the ten most recent." })),
});

type Loaded = { name: string; bytes: Uint8Array } | { name: string; error: string };

/** Read one learner file through the file-access policy, bounded before any byte is read. */
async function load(rawPath: string): Promise<Loaded> {
	const name = path.basename(rawPath);
	try {
		const absolute = resolveSourcePath(rawPath);
		const stat = await fs.stat(absolute);
		if (!stat.isFile()) return { name, error: "It is not a file." };
		if (stat.size > MAX_MATERIAL_BYTES) return { name, error: "Too big. Max 25 MB." };
		return { name: path.basename(absolute), bytes: new Uint8Array(await fs.readFile(absolute)) };
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "No such file." : error instanceof Error ? error.message : String(error);
		return { name, error: reason };
	}
}

export function createMaterialTools(deps: MaterialToolDeps): AgentTool<any>[] {
	const ingestMaterial: AgentTool<typeof ingestInput> = {
		name: "ingest_material",
		label: "ingest_material",
		description: [
			"Add the learner's own study files to their library: notes (PowerPoint .pptx, Word .docx, PDF, photos, text) or a marked test (photos of its pages in order, or one PDF). " +
				"The ideas in the files join their knowledge graph; a marked test's results are recorded on the ideas it tests.",
			"Call it only when the learner asks for a file to be added, or after they agree to your offer. Offer at most once per file. To teach from a file, use read; adding it is not needed for that.",
			"It starts the work and returns at once. Processing continues in the background, and anything read from photos or scanned pages waits for the learner's review in the Library before it reaches the graph. " +
				"Tell the learner that, then continue the lesson without waiting. Local paths follow File access settings.",
		].join("\n\n"),
		parameters: ingestInput,
		execute: serverExecute("ingest_material", ingestInput, async ({ kind, paths }): Promise<string> => {
			const started: { name: string; id: string }[] = [];
			const refused: { name: string; error: string }[] = [];
			const begin = (name: string, files: { name: string; bytes: Uint8Array }[]) => {
				const outcome = deps.ingest(kind, files);
				if (outcome.ok) started.push({ name, id: outcome.id });
				else refused.push({ name, error: outcome.error });
			};
			if (kind === "test") {
				if (paths.length > MAX_TEST_PAGES) throw new Error(`A test can have at most ${MAX_TEST_PAGES} pages.`);
				const pages: { name: string; bytes: Uint8Array }[] = [];
				for (const rawPath of paths) {
					const file = await load(rawPath);
					if ("error" in file) refused.push(file);
					else pages.push(file);
				}
				// A test with a missing page is not read at all: its score would be wrong.
				if (refused.length === 0) begin(pages[0]!.name, pages);
			} else {
				for (const rawPath of new Set(paths)) {
					const file = await load(rawPath);
					if ("error" in file) refused.push(file);
					else begin(file.name, [file]);
				}
			}
			// Nothing started: an error result, so the model sees it as a failure.
			if (started.length === 0) throw new Error(ingestResultText([], refused));
			return ingestResultText(started, refused);
		}),
	};

	const materialStatus: AgentTool<typeof statusInput> = {
		name: "material_status",
		label: "material_status",
		description:
			"Check on files added to the learner's library: whether each is waiting, being processed, waiting for the learner's review, in the graph, or failed. " +
			"Call it when the learner asks about a file they added. With no ids it lists the ten most recent.",
		parameters: statusInput,
		execute: serverExecute("material_status", statusInput, ({ ids }): string => {
			const wanted = ids && ids.length > 0 ? ids : undefined;
			const found = wanted ? deps.materials(wanted) : deps.materials().slice(-STATUS_DEFAULT).reverse();
			const missing = (wanted ?? []).filter((id) => !found.some((material) => material.id === id));
			const lines = [...found.map(materialStatusLine), ...missing.map((id) => `- ${id}: no such material (it may have been deleted).`)];
			return lines.length > 0 ? lines.join("\n") : "The learner's library is empty.";
		}),
	};

	return [ingestMaterial, materialStatus];
}

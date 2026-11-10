/**
 * The syllabus builder (fork, phase 4b — see FORK.md): one model call that
 * reads a course's goal and its books' contents lists and submits units.
 * Runs on the strong slot (the teacher's): planning quality matters more
 * than speed here. The submission is validated — unknown sections and
 * forward dependencies go back to the model with the reason.
 */

import { Type } from "typebox";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import { MAX_SYLLABUS_UNITS } from "../core/contracts.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { draftProblem, SYLLABUS_INSTRUCTIONS, syllabusPrompt, type DraftUnit, type SyllabusBook } from "../core/syllabus.ts";
import type { SyllabusUnit } from "../core/contracts.ts";
import { stores } from "./stores.ts";

export interface SyllabusBuildInput {
	title: string;
	goal: string;
	books: SyllabusBook[];
	note?: string;
	covered?: SyllabusUnit[];
}

export type SyllabusBuilder = (input: SyllabusBuildInput, signal?: AbortSignal) => Promise<DraftUnit[]>;

export class SyllabusBuildError extends Error {}

const submitSyllabusInput = Type.Object({
	units: Type.Array(
		Type.Object({
			title: Type.String({ description: "A short title naming what the learner will understand or be able to do" }),
			sections: Type.Array(
				Type.Object({
					book: Type.String({ description: "The book id, exactly as given" }),
					section: Type.String({ description: "The section id, exactly as listed for that book, such as s3 or s3.2" }),
				}),
				{ description: "The book sections this unit draws on; at least one" },
			),
			dependsOn: Type.Array(Type.Integer(), { description: "Numbers of the earlier units this one directly depends on (the first unit is 1); empty when none" }),
		}),
		{ description: `The units in teaching order; at most ${MAX_SYLLABUS_UNITS}` },
	),
});

function strongEngine(): PiEngine {
	const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
	if (!spec) throw new SyllabusBuildError("No model is set up. Choose one in Settings, then retry.");
	return piEngineForSpec(spec, true);
}

export function createSyllabusBuilder(engineFor: () => PiEngine = strongEngine): SyllabusBuilder {
	return (input, signal) =>
		withBgLlmSlot(signal, () =>
			runSubmitAgent<DraftUnit[]>({
				role: "teacher",
				toolName: "submit_syllabus",
				toolDescription: "Submit the course's units in teaching order. Call exactly once.",
				parameters: submitSyllabusInput,
				fill: (raw: { units: { title: string; sections?: { book: string; section: string }[]; dependsOn?: number[] }[] }) =>
					raw.units.map((unit) => ({ title: unit.title, sections: unit.sections ?? [], dependsOn: unit.dependsOn ?? [] })),
				validate: (draft) => draftProblem(draft, input.books),
				systemPrompt: SYLLABUS_INSTRUCTIONS,
				prompt: syllabusPrompt(input),
				engine: engineFor(),
				signal,
				onStep: () => {},
				neverSubmitted: "The syllabus could not be drafted. Retry.",
			}),
		);
}

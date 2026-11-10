/**
 * Marked-test reading and linking (fork, phase 3b).
 *
 *   reader  the vision model sees the page photos and submits each question,
 *           the learner's answer, the mark and the idea tested (one submit
 *           call; a schema-invalid or empty call is retried by the model).
 *   linker  after the tested ideas have gone through the graph pipeline, a
 *           cheap text model matches each question to the ideas the paper's
 *           source now holds. Ids outside that list are refused.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { detectSupportedImageMimeType, processImage } from "../../agent/image-processing/index.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { withBgLlmSlot } from "../../agent/subagents/bg-llm-semaphore.ts";
import { runSubagent } from "../../agent/subagents/pi-run.ts";
import { runSubmitAgent } from "../../agent/subagents/submit-agent.ts";
import { invalidInputResult, toToolResult } from "../../agent/tool-execute.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";
import type { TestQuestion, TestReading } from "../../core/contracts.ts";
import { cleanTestReading, QUIZ_LINKER_INSTRUCTIONS, TEST_LINKER_INSTRUCTIONS, TEST_READER_INSTRUCTIONS } from "../../core/evidence.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import type { ModelRole } from "../../../config.ts";
import { heifToJpeg, isHeif } from "../attachments.ts";
import { stores } from "../stores.ts";

export type TestReader = (pages: readonly Uint8Array[], signal?: AbortSignal) => Promise<TestReading>;
export interface LinkableIdea {
	id: string;
	name: string;
	statement: string;
}
/** One id list per question, aligned with `questions`. */
export type TestLinker = (questions: readonly TestQuestion[], ideas: readonly LinkableIdea[], signal?: AbortSignal) => Promise<string[][]>;

export class TestReadError extends Error {}

function engineFor(role: ModelRole, missing: string): PiEngine {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	if (!spec) throw new TestReadError(missing);
	return piEngineForSpec(spec, true);
}

const submitTestInput = Type.Object({
	questions: Type.Array(
		Type.Object({
			number: Type.String({ description: "The question number as printed" }),
			question: Type.String({ description: "The question text, transcribed" }),
			answer: Type.String({ description: "What the learner wrote" }),
			marksAwarded: Type.Optional(Type.Number({ description: "Marks given, if shown on the paper" })),
			marksAvailable: Type.Optional(Type.Number({ description: "Marks available, if shown on the paper" })),
			outcome: Type.Union([Type.Literal("correct"), Type.Literal("partial"), Type.Literal("wrong"), Type.Literal("unmarked")]),
			whatWentWrong: Type.Optional(Type.String({ description: "One sentence on the error; omit for correct answers" })),
			idea: Type.String({ description: "One true, self-contained sentence stating the idea the question tests" }),
		}),
	),
	total: Type.Optional(Type.Object({ earned: Type.Number(), possible: Type.Number() }, { description: "The total score, if the paper shows one" })),
});

export function createTestReader(visionEngine: () => PiEngine = () => engineFor("pdfReader", "No vision model is set up. Choose one in Settings, then retry.")): TestReader {
	return async (pages, signal) => {
		const engine = visionEngine();
		const images: { data: string; mimeType: string }[] = [];
		for (const [index, raw] of pages.entries()) {
			const bytes = isHeif(raw) ? await heifToJpeg(raw) : raw;
			const mime = detectSupportedImageMimeType(bytes);
			if (!mime) throw new TestReadError(`Page ${index + 1} is not a supported image.`);
			const image = await processImage(bytes, mime, { resizeOptions: engine.model.inputLimits?.images?.resize });
			if (!image.ok) throw new TestReadError(`Page ${index + 1}: ${image.message}`);
			images.push({ data: image.data, mimeType: image.mimeType });
		}
		signal?.throwIfAborted();
		let reading: TestReading | undefined;
		const submit: AgentTool<typeof submitTestInput> = {
			name: "submit_test",
			label: "submit_test",
			description: "Submit everything read from the marked test paper. Call exactly once.",
			parameters: submitTestInput,
			prepareArguments: (args) => healEncodedArguments(args, submitTestInput) as never,
			execute: async (_toolCallId, input) => {
				const cleaned = cleanTestReading(input);
				if (!cleaned) return invalidInputResult("submit_test", ["no questions were reported — list every question on the paper"]);
				reading = cleaned;
				return toToolResult({ received: cleaned.questions.length });
			},
		};
		await withBgLlmSlot(signal, () =>
			runSubagent([submit], {
				role: "pdfReader",
				engine,
				systemPrompt: TEST_READER_INSTRUCTIONS,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: `The marked test paper, ${images.length === 1 ? "1 page" : `${images.length} pages in order`}:` },
							...images.map((image) => ({ type: "image" as const, ...image })),
						],
						timestamp: Date.now(),
					},
				],
				maxTurns: 3,
				abortSignal: signal,
				shouldStop: (_message, toolResults) => toolResults.some((r) => r.toolName === "submit_test" && !r.isError),
			}),
		);
		if (!reading) throw new TestReadError("The test could not be read. Check the photos are sharp and upright, then retry.");
		return reading;
	};
}

const submitLinksInput = Type.Object({
	links: Type.Array(
		Type.Object({
			question: Type.Integer({ description: "The question's position in the list, starting at 1" }),
			ideaIds: Type.Array(Type.String(), { description: "Ids of the listed ideas this question tests; empty when none fits" }),
		}),
	),
});

export function createTestLinker(cheapEngine: () => PiEngine = () => engineFor("extractor", "No background model is set up. Choose one in Settings, then retry.")): TestLinker {
	return createQuestionLinker(TEST_LINKER_INSTRUCTIONS, true, "The test's questions could not be matched to ideas. Retry.", cheapEngine);
}

/** Lesson quiz questions → the ideas that lesson added to the graph
 *  (phase 4c). Same submit-and-validate loop as the test linker; a quiz
 *  question states no idea of its own. */
export type QuizLinker = (questions: readonly { question: string }[], ideas: readonly LinkableIdea[], signal?: AbortSignal) => Promise<string[][]>;

export function createQuizLinker(cheapEngine: () => PiEngine = () => engineFor("extractor", "No background model is set up.")): QuizLinker {
	return createQuestionLinker(QUIZ_LINKER_INSTRUCTIONS, false, "The quiz questions could not be matched to ideas.", cheapEngine);
}

function createQuestionLinker(instructions: string, statesIdea: boolean, neverSubmitted: string, cheapEngine: () => PiEngine) {
	return async (questions: readonly { question: string; idea?: string }[], ideas: readonly LinkableIdea[], signal?: AbortSignal): Promise<string[][]> => {
		if (questions.length === 0 || ideas.length === 0) return questions.map(() => []);
		const known = new Set(ideas.map((idea) => idea.id));
		const prompt = [
			"Questions:",
			...questions.map((q, i) => `${i + 1}. ${q.question || "(no question text)"}${statesIdea ? `\n   Tests: ${q.idea || "(not stated)"}` : ""}`),
			"",
			"Ideas:",
			...ideas.map((idea) => `[${idea.id}] ${idea.name}: ${idea.statement}`),
		].join("\n");
		return withBgLlmSlot(signal, () =>
			runSubmitAgent<string[][]>({
				role: "extractor",
				toolName: "submit_links",
				toolDescription: "Submit, for each question, the ids of the listed ideas it tests. Call exactly once.",
				parameters: submitLinksInput,
				fill: (input: { links: { question: number; ideaIds: string[] }[] }) => {
					const out: string[][] = questions.map(() => []);
					for (const link of input.links) {
						if (link.question >= 1 && link.question <= questions.length) out[link.question - 1] = [...new Set(link.ideaIds)];
					}
					return out;
				},
				validate: (links) => {
					const invented = [...new Set(links.flat().filter((id) => !known.has(id)))];
					return invented.length > 0 ? `unknown idea ids ${JSON.stringify(invented)} — use only ids from the Ideas list` : null;
				},
				systemPrompt: instructions,
				prompt,
				engine: cheapEngine(),
				signal,
				onStep: () => {},
				neverSubmitted,
			}),
		);
	};
}

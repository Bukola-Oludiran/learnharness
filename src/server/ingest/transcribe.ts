/**
 * Vision transcription (fork, phase 3a): one image of study material in,
 * its text out. Runs on the Vision slot through upstream's sub-agent
 * runner, under the shared background-LLM permit pool, so a deck full of
 * pictures queues behind extraction instead of bursting the provider.
 */

import { processImage, detectSupportedImageMimeType } from "../../agent/image-processing/index.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { runSubagent } from "../../agent/subagents/pi-run.ts";
import { withBgLlmSlot } from "../../agent/subagents/bg-llm-semaphore.ts";
import { TRANSCRIBE_INSTRUCTIONS } from "../../core/material.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { isHeif, heifToJpeg } from "../attachments.ts";
import { stores } from "../stores.ts";

/** Transcribe one image. `label` names it in errors and to the model. */
export type Transcriber = (bytes: Uint8Array, label: string, signal?: AbortSignal) => Promise<string>;

export class TranscriptionError extends Error {}

/** The Vision slot's engine, read fresh per call (a settings change lands
 *  on the next image). pdfReader is upstream's vision-tier role. */
function visionEngine(): PiEngine {
	const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
	if (!spec) throw new TranscriptionError("No vision model is set up. Choose one in Settings, then retry.");
	return piEngineForSpec(spec, true);
}

export function createTranscriber(engineFor: () => PiEngine = visionEngine): Transcriber {
	return async (bytes, label, signal) => {
		const source = isHeif(bytes) ? await heifToJpeg(bytes) : bytes;
		const mime = detectSupportedImageMimeType(source);
		if (!mime) throw new TranscriptionError(`${label} is not a supported image.`);
		const engine = engineFor();
		const image = await processImage(source, mime, { resizeOptions: engine.model.inputLimits?.images?.resize });
		if (!image.ok) throw new TranscriptionError(`${label}: ${image.message}`);
		signal?.throwIfAborted();
		const { text } = await withBgLlmSlot(signal, () =>
			runSubagent([], {
				role: "pdfReader",
				engine,
				systemPrompt: TRANSCRIBE_INSTRUCTIONS,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: `${label}:` },
							{ type: "image", data: image.data, mimeType: image.mimeType },
						],
						timestamp: Date.now(),
					},
				],
				maxTurns: 1,
				abortSignal: signal,
			}),
		);
		return text.trim();
	};
}

/**
 * Answer attachments service (fork, phase 2 — see FORK.md): turn an
 * uploaded photo into a session image snapshot.
 *
 * The bytes go through upstream's learner-image processing unchanged
 * (25 MiB / 16 MP in; upright, metadata-free, at most 1600px a side
 * stored) and land in the chat record's image pool under their SHA-256
 * identity — the same pool show_image uses, so an identical photo is
 * stored once per session.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { snapshotImageBytes } from "../agent/tools/learner-image.ts";
import { MAX_LEARNER_IMAGE_BYTES } from "../agent/tools/learner-image-dimensions.ts";
import { stores } from "./stores.ts";

export const MAX_ATTACHMENT_BYTES = MAX_LEARNER_IMAGE_BYTES;

export type AttachmentOutcome =
	| { ok: true; snapshotId: string; mimeType: string; width: number; height: number }
	| { ok: false; status: 400 | 404 | 413; error: string };

/** ISO-BMFF `ftyp` brands that mean HEIC/HEIF — the iPhone camera's default. */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

export function isHeif(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 12) return false;
	const ascii = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4));
	return ascii(4) === "ftyp" && HEIF_BRANDS.has(ascii(8));
}

/** HEIC → JPEG through macOS's own `sips`. The image pipeline has no HEIC
 *  decoder; on other systems the learner is told to convert first. */
export async function heifToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
	if (process.platform !== "darwin") {
		throw new Error("HEIC photos can only be converted on macOS; attach a JPEG or PNG instead");
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-heic-"));
	try {
		const source = path.join(dir, "in.heic");
		const target = path.join(dir, "out.jpg");
		await fs.writeFile(source, bytes);
		await promisify(execFile)("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", source, "--out", target], { timeout: 30_000 });
		return await fs.readFile(target);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("HEIC")) throw error;
		throw new Error("Could not convert the HEIC photo; attach a JPEG or PNG instead");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

export async function saveAttachment(chatId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<AttachmentOutcome> {
	if (!stores.chatStore.getChat(chatId)) return { ok: false, status: 404, error: "No such session" };
	if (bytes.byteLength === 0) return { ok: false, status: 400, error: "The upload was empty" };
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, status: 413, error: "Image exceeds 25 MiB; provide a smaller image" };
	try {
		const source = isHeif(bytes) ? await heifToJpeg(bytes) : bytes;
		const image = await snapshotImageBytes(source, "the uploaded photo", signal);
		stores.chatStore.saveImageSnapshot(chatId, image.snapshotId, image);
		return { ok: true, snapshotId: image.snapshotId, mimeType: image.mimeType, width: image.width, height: image.height };
	} catch (error) {
		// The session may have been deleted during processing.
		if (!stores.chatStore.getChat(chatId)) return { ok: false, status: 404, error: "No such session" };
		return { ok: false, status: 400, error: error instanceof Error ? error.message : "Could not process the image" };
	}
}

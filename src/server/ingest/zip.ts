/**
 * A minimal zip reader (fork, phase 3a) — enough for Office files, with no
 * dependency: central directory in, one entry out at a time, stored or
 * deflated. No ZIP64, no encryption, no writing. Every size is bounded
 * before any byte is inflated.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 20_000;

export class ZipError extends Error {}

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The archive's entries, in central-directory order. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
	const data = view(bytes);
	// The end record sits in the last 22 bytes plus an optional comment (≤ 64 KiB).
	let at = -1;
	for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
		if (data.getUint32(i, true) === EOCD) {
			at = i;
			break;
		}
	}
	if (at < 0) throw new ZipError("Not a zip archive");
	const count = data.getUint16(at + 10, true);
	const directorySize = data.getUint32(at + 12, true);
	let offset = data.getUint32(at + 16, true);
	if (count > MAX_ENTRIES || offset + directorySize > bytes.byteLength) throw new ZipError("Unsupported or damaged zip archive");
	const decoder = new TextDecoder();
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (offset + 46 > bytes.byteLength || data.getUint32(offset, true) !== CENTRAL) throw new ZipError("Damaged zip directory");
		const nameLength = data.getUint16(offset + 28, true);
		const extraLength = data.getUint16(offset + 30, true);
		const commentLength = data.getUint16(offset + 32, true);
		entries.push({
			name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
			method: data.getUint16(offset + 10, true),
			compressedSize: data.getUint32(offset + 20, true),
			uncompressedSize: data.getUint32(offset + 24, true),
			localHeaderOffset: data.getUint32(offset + 42, true),
		});
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** One entry's bytes. `maxBytes` bounds the inflated size (a declared size
 *  is checked first; the inflate itself is capped too, so a lying header
 *  cannot expand past it). */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Uint8Array {
	if (entry.uncompressedSize > maxBytes) throw new ZipError(`${entry.name} is too large`);
	const data = view(bytes);
	const at = entry.localHeaderOffset;
	if (at + 30 > bytes.byteLength || data.getUint32(at, true) !== LOCAL) throw new ZipError("Damaged zip entry");
	const start = at + 30 + data.getUint16(at + 26, true) + data.getUint16(at + 28, true);
	const end = start + entry.compressedSize;
	if (end > bytes.byteLength) throw new ZipError("Damaged zip entry");
	const raw = bytes.subarray(start, end);
	if (entry.method === 0) return raw;
	if (entry.method !== 8) throw new ZipError(`Unsupported zip compression in ${entry.name}`);
	try {
		return inflateRawSync(raw, { maxOutputLength: maxBytes });
	} catch {
		throw new ZipError(`Could not unpack ${entry.name}`);
	}
}

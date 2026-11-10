/**
 * Notes ingest (fork, phase 3a — FORK.md): the zip and PowerPoint readers,
 * format detection, transcript assembly, and the materials service driven
 * end to end with a fake vision model and a fake notes pipeline. Runs under
 * an isolated LH_DATA_DIR, set before the first config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { tinyPdf } from "./helpers/tiny-pdf.ts";
import { tinyDeck, tinyZip } from "./helpers/tiny-zip.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-materials-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { readZipEntries, readZipEntry, ZipError } = await import("../src/server/ingest/zip.ts");
const { readDeck, paragraphsOf, DeckError, MAX_DECK_PICTURES } = await import("../src/server/ingest/pptx.ts");
const { convertMaterial, ConversionError } = await import("../src/server/ingest/convert.ts");
const { createMaterialsService } = await import("../src/server/materials.ts");
const { stores } = await import("../src/server/stores.ts");
const { PATHS } = await import("../config.ts");
const {
	AI_READ_MARK, assembleTranscript, detectMaterialFormat, materialSourcePath, materialTitle, transcriptForExtraction, TRANSCRIBE_INSTRUCTIONS,
} = await import("../src/core/material.ts");
const coursesRoute = await import("../app/api/courses/[id]/route.ts");
import type { MaterialView } from "../src/core/contracts.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20_000, 7)]);
const picture = (seed: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20_000, seed)]);

describe("the zip reader", () => {
	it("reads deflated and stored entries and lists them in directory order", () => {
		for (const store of [false, true]) {
			const zip = tinyZip({ "a.txt": "alpha", "dir/b.txt": "beta ".repeat(500) }, { store });
			const entries = readZipEntries(zip);
			assert.deepEqual(entries.map((e) => e.name), ["a.txt", "dir/b.txt"]);
			assert.equal(Buffer.from(readZipEntry(zip, entries[1]!, 1 << 20)).toString(), "beta ".repeat(500));
		}
	});

	it("refuses non-archives and entries over the caller's size bound", () => {
		assert.throws(() => readZipEntries(Buffer.from("definitely not a zip file, just text")), ZipError);
		const zip = tinyZip({ "big.txt": "x".repeat(10_000) });
		assert.throws(() => readZipEntry(zip, readZipEntries(zip)[0]!, 100), /too large/);
	});

	it("an entry that inflates past its declared size is refused, not expanded", () => {
		const zip = tinyZip({ "bomb.txt": "0".repeat(200_000) });
		const [entry] = readZipEntries(zip);
		assert.throws(() => readZipEntry(zip, { ...entry!, uncompressedSize: 10 }, 1000), ZipError);
	});
});

describe("the PowerPoint reader", () => {
	it("returns slides in presentation order with text, speaker notes and pictures", () => {
		const deck = readDeck(tinyDeck(
			[
				{ paragraphs: ["Second in file, first shown"], notes: ["Say hello"] },
				{ paragraphs: ["Eigenvalues", "A v = λ v"], pictures: ["chart.png"] },
			],
			{ "chart.png": PNG },
			[2, 1],
		));
		assert.deepEqual(deck.slides.map((s) => [s.number, s.text, s.notes, s.pictures.length]), [
			[1, "Eigenvalues\nA v = λ v", "", 1],
			[2, "Second in file, first shown", "Say hello", 0],
		]);
		assert.equal(deck.slides[0]!.pictures[0]!.name, "ppt/media/chart.png");
		assert.equal(deck.skippedPictures, 0);
	});

	it("joins runs inside a paragraph and decodes XML entities", () => {
		assert.deepEqual(
			paragraphsOf('<a:p><a:r><a:t>x &lt; y </a:t></a:r><a:r><a:t>&amp; y &gt; 0</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p><a:p><a:r><a:t>caf&#233;</a:t></a:r></a:p>'),
			["x < y & y > 0", "café"],
		);
	});

	it("skips template art, icons, unsupported formats and pictures over the cap", () => {
		const logo = picture(1);
		const slides = Array.from({ length: 5 }, () => ({ paragraphs: ["s"], pictures: ["logo.png", "icon.png", "vector.emf"] }));
		const skipped = readDeck(tinyDeck(slides, { "logo.png": logo, "icon.png": Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(100)]), "vector.emf": Buffer.alloc(30_000) }));
		assert.equal(skipped.slides.reduce((n, s) => n + s.pictures.length, 0), 0);
		assert.equal(skipped.skippedPictures, 15);

		const many = Array.from({ length: MAX_DECK_PICTURES + 2 }, (_, i) => ({ paragraphs: ["s"], pictures: [`p${i}.png`] }));
		const media = Object.fromEntries(many.map((_, i) => [`p${i}.png`, picture(i + 2)]));
		const capped = readDeck(tinyDeck(many, media));
		assert.equal(capped.slides.reduce((n, s) => n + s.pictures.length, 0), MAX_DECK_PICTURES);
		assert.equal(capped.skippedPictures, 2);
	});

	it("refuses a zip that is not a deck", () => {
		assert.throws(() => readDeck(tinyZip({ "word/document.xml": "<w/>" })), DeckError);
		assert.throws(() => readDeck(Buffer.from("not a zip at all, sorry")), DeckError);
	});
});

describe("format detection and transcript assembly", () => {
	it("trusts bytes over names, and names a zip a deck only when it is called one", () => {
		const zip = tinyZip({ x: "y" });
		assert.deepEqual(detectMaterialFormat("notes.txt", Buffer.from("%PDF-1.7 ...")), { format: "pdf" });
		assert.deepEqual(detectMaterialFormat("scan.pdf", PNG), { format: "image" });
		assert.deepEqual(detectMaterialFormat("deck.pptx", zip), { format: "pptx" });
		assert.deepEqual(detectMaterialFormat("notes.md", Buffer.from("# Title")), { format: "text" });
		assert.match((detectMaterialFormat("essay.docx", zip) as { refused: string }).refused, /not supported/);
		assert.match((detectMaterialFormat("book.epub", zip) as { refused: string }).refused, /not supported yet/);
		assert.match((detectMaterialFormat("old.ppt", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])) as { refused: string }).refused, /Keynote or PowerPoint/);
		assert.match((detectMaterialFormat("blob.txt", Buffer.from([65, 0, 66])) as { refused: string }).refused, /text file/);
		assert.match((detectMaterialFormat("empty.txt", new Uint8Array()) as { refused: string }).refused, /empty/);
	});

	it("builds a source path the graph can file under the course", () => {
		assert.equal(materialSourcePath("Linear algebra", "Week 1.pptx"), "Linear algebra/Week 1.pptx");
		assert.equal(materialSourcePath("AC/DC: theory\\notes", "a/b.txt"), "AC DC theory notes/a b.txt");
		assert.equal(materialSourcePath("..", ""), "Course/material");
		assert.equal(materialTitle("Week 1.final.pptx"), "Week 1.final");
	});

	it("marks AI-read passages, counts them, and strips the marks for extraction", () => {
		const { text, aiReadParts } = assembleTranscript([
			{ label: "Slide 1", text: "Typed text", aiRead: ["From a picture [?]"] },
			{ label: "Slide 2", text: "", aiRead: [] },
			{ label: "Slide 3", text: "", aiRead: ["  ", "Second picture"] },
		]);
		assert.equal(aiReadParts, 2);
		assert.equal(text, `## Slide 1\n\nTyped text\n\n${AI_READ_MARK}\n\nFrom a picture [?]\n\n## Slide 3\n\n${AI_READ_MARK}\n\nSecond picture`);
		const clean = transcriptForExtraction(text);
		assert.ok(!clean.includes("AI-read"));
		assert.equal(clean, "## Slide 1\n\nTyped text\n\nFrom a picture [?]\n\n## Slide 3\n\nSecond picture");
	});

	it("carries the approved transcription wording", () => {
		assert.match(TRANSCRIBE_INSTRUCTIONS, /^Transcribe this image of study material exactly\./);
		assert.match(TRANSCRIBE_INSTRUCTIONS, /followed by \[\?\]\. Never guess silently and never fill gaps from your own knowledge\./);
		assert.match(TRANSCRIBE_INSTRUCTIONS, /Reply with the transcription only\.$/);
	});
});

describe("converters", () => {
	const write = (name: string, bytes: Uint8Array | string) => {
		const p = path.join(root, name);
		fs.writeFileSync(p, bytes);
		return p;
	};
	const seen: string[] = [];
	const transcribe = async (_bytes: Uint8Array, label: string) => {
		seen.push(label);
		return `read ${label}`;
	};

	it("a deck keeps typed text direct and sends only its pictures to the vision model", async () => {
		seen.length = 0;
		const deck = write("c.pptx", tinyDeck([{ paragraphs: ["Typed"], notes: ["Note"], pictures: ["a.png"] }, { paragraphs: ["Plain"] }], { "a.png": PNG }));
		const { parts, notice } = await convertMaterial("pptx", deck, transcribe);
		assert.deepEqual(parts, [
			{ label: "Slide 1", text: "Typed\n\nSpeaker notes:\nNote", aiRead: ["read Slide 1, picture 1"] },
			{ label: "Slide 2", text: "Plain", aiRead: [] },
		]);
		assert.deepEqual(seen, ["Slide 1, picture 1"]);
		assert.equal(notice, undefined);
	});

	it("a text PDF never calls the vision model", async () => {
		seen.length = 0;
		const pdf = write("c.pdf", tinyPdf([{ runs: [{ text: "Bayes theorem relates conditional probabilities.", x: 72, y: 700 }] }]));
		const { parts } = await convertMaterial("pdf", pdf, transcribe);
		assert.equal(parts.length, 1);
		assert.match(parts[0]!.text, /Bayes theorem/);
		assert.deepEqual(parts[0]!.aiRead, []);
		assert.deepEqual(seen, []);
	});

	it("a photo is wholly AI-read; empty and unreadable inputs refuse with a reason", async () => {
		const { parts } = await convertMaterial("image", write("c.png", PNG), transcribe);
		assert.deepEqual(parts, [{ label: "Photo", text: "", aiRead: ["read Photo"] }]);
		await assert.rejects(convertMaterial("image", write("blank.png", PNG), async () => ""), ConversionError);
		await assert.rejects(convertMaterial("text", write("blank.txt", "  \n"), transcribe), /no text/);
		await assert.rejects(convertMaterial("pdf", write("bad.pdf", "%PDF-1.7 garbage"), transcribe), /Could not open this PDF/);
		await assert.rejects(convertMaterial("pptx", write("empty.pptx", tinyDeck([{ paragraphs: [] }])), transcribe), /export it to PDF/);
	});
});

describe("the materials service", () => {
	const imported: { filePath: string; text: string }[] = [];
	const registered: string[] = [];
	const behavior = { transcribe: async (_b: Uint8Array, label: string) => `handwritten ${label} [?]`, importFails: null as Error | null };
	const service = createMaterialsService({
		stores,
		transcribe: (bytes, label) => behavior.transcribe(bytes, label),
		importNotes: async (input) => {
			if (behavior.importFails) throw behavior.importFails;
			imported.push(input);
		},
		registerImport: (filePath) => void registered.push(filePath),
		abortExtraction: () => {},
	});
	const course = stores.courseStore.createCourse("Linear algebra", "");

	async function settled(id: string): Promise<MaterialView> {
		for (let i = 0; i < 400; i++) {
			const found = service.getMaterial(id)!.material;
			if (found.status !== "processing") return found;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("material never settled");
	}
	const upload = (name: string, bytes: Uint8Array | string) => {
		const outcome = service.uploadMaterial(course.id, name, Buffer.from(bytes));
		assert.ok(outcome.ok, JSON.stringify(outcome));
		return outcome.material;
	};

	it("typed notes go straight to the graph under <course>/<file>, with no review", async () => {
		const created = upload("Week 1.md", "# Vectors\n\nA vector has magnitude and direction.");
		assert.deepEqual([created.status, created.stage, created.kind, created.format, created.interrupted], ["processing", "converting", "notes", "text", false]);
		const done = await settled(created.id);
		assert.deepEqual([done.status, done.aiReadParts, done.sourcePath], ["ready", 0, "Linear algebra/Week 1.md"]);
		assert.match(done.graphSourceId!, /^src_[a-f0-9]{12}$/);
		assert.deepEqual(imported.at(-1), { filePath: "Linear algebra/Week 1.md", text: "## Notes\n\n# Vectors\n\nA vector has magnitude and direction." });
		assert.equal(registered.at(-1), "Linear algebra/Week 1.md");
		assert.deepEqual(stores.courseStore.getCourse(course.id)!.materialIds, [created.id]);
		assert.ok(fs.existsSync(path.join(PATHS.materials, created.id, "original.md")), "the app keeps its own copy");
	});

	it("AI-read material waits for review; approval sends the learner's corrected text", async () => {
		const before = imported.length;
		const waiting = await settled(upload("page.png", PNG).id);
		assert.deepEqual([waiting.status, waiting.aiReadParts], ["review", 1]);
		assert.equal(imported.length, before, "nothing reaches the graph before approval");
		const { text } = service.getMaterial(waiting.id)!;
		assert.equal(text, `## Photo\n\n${AI_READ_MARK}\n\nhandwritten Photo [?]`);

		assert.equal((service.approveMaterial(waiting.id, "   ") as { code: string }).code, "empty_text");
		const approved = service.approveMaterial(waiting.id, text!.replace("handwritten Photo [?]", "E = mc^2"));
		assert.ok(approved.ok && approved.material.stage === "extracting");
		assert.equal((await settled(waiting.id)).status, "ready");
		assert.deepEqual(imported.at(-1), { filePath: "Linear algebra/page.png", text: "## Photo\n\nE = mc^2" });
		assert.equal((service.approveMaterial(waiting.id, undefined) as { code: string }).code, "not_in_review");
	});

	it("refuses unsupported files, oversize uploads and unknown courses without storing anything", () => {
		const count = () => stores.materialStore.listMaterials().length;
		const before = count();
		assert.equal((service.uploadMaterial(course.id, "old.ppt", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2])) as { code: string }).code, "unsupported");
		assert.equal((service.uploadMaterial("course_missing", "a.md", Buffer.from("x")) as { code: string }).code, "course_not_found");
		assert.equal((service.uploadMaterial(course.id, "huge.md", new Uint8Array(25 * 1024 * 1024 + 1)) as { status: number }).status, 413);
		assert.equal(count(), before);
	});

	it("a failure lands on the record with its reason; Retry starts over from the stored original", async () => {
		behavior.importFails = new Error("The provider refused the request.");
		const failed = await settled(upload("fails.txt", "Some notes").id);
		assert.deepEqual([failed.status, failed.error], ["failed", "The provider refused the request."]);
		assert.equal((service.retryMaterial(upload("fine.txt", "ok").id) as { code?: string }).code, "not_retryable");
		behavior.importFails = null;
		assert.ok(service.retryMaterial(failed.id).ok);
		const retried = await settled(failed.id);
		assert.deepEqual([retried.status, retried.error], ["ready", undefined]);
	});

	it("a processing record with no live worker reads as interrupted and can be retried", async () => {
		const done = await settled(upload("restart.txt", "Notes").id);
		stores.materialStore.saveMaterial({ ...stores.materialStore.getMaterial(done.id)!, status: "processing", stage: "converting" });
		const orphan = service.getMaterial(done.id)!.material;
		assert.equal(orphan.interrupted, true);
		assert.ok(service.retryMaterial(done.id).ok);
		assert.equal((await settled(done.id)).status, "ready");
	});

	it("delete removes the stored files and the course's reference", async () => {
		const done = await settled(upload("gone.txt", "Notes").id);
		assert.equal(service.deleteMaterial(done.id), true);
		assert.equal(service.getMaterial(done.id), null);
		assert.ok(!fs.existsSync(path.join(PATHS.materials, done.id)));
		assert.ok(!stores.courseStore.getCourse(course.id)!.materialIds.includes(done.id));
		assert.equal(service.deleteMaterial(done.id), false);
	});

	it("deleting a mid-conversion material never resurrects it", async () => {
		let release!: () => void;
		behavior.transcribe = () => new Promise((resolve) => { release = () => resolve("late"); });
		const pending = upload("slow.png", PNG);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(service.deleteMaterial(pending.id), true);
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(service.getMaterial(pending.id), null);
		behavior.transcribe = async (_b, label) => `handwritten ${label} [?]`;
	});

	it("deleting a course deletes its materials", async () => {
		const other = stores.courseStore.createCourse("Short-lived", "");
		const outcome = service.uploadMaterial(other.id, "a.txt", Buffer.from("Notes"));
		assert.ok(outcome.ok);
		await settled(outcome.material.id);
		const res = await coursesRoute.DELETE(new Request("http://test/api", { method: "DELETE" }), { params: Promise.resolve({ id: other.id }) });
		assert.equal(res.status, 200);
		assert.equal(stores.materialStore.getMaterial(outcome.material.id), null);
	});
});

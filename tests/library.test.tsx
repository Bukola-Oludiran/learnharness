/**
 * The library (fork, phase 3b2 — FORK.md): course-free uploads, folder
 * paths, the folder checklist's verdicts, the Word reader, and the
 * two-at-a-time queue. Runs under an isolated LH_DATA_DIR, set before the
 * first config-loading import. Same tsx classic-JSX shim as the render pins.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { tinyZip } from "./helpers/tiny-zip.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { readDocument, documentText, DocumentError } = await import("../src/server/ingest/docx.ts");
const { convertMaterial } = await import("../src/server/ingest/convert.ts");
const { createMaterialsService } = await import("../src/server/materials.ts");
const { stores } = await import("../src/server/stores.ts");
const { detectMaterialFormat, folderFileVerdict, librarySourcePath } = await import("../src/core/material.ts");
const { MATERIAL_CONCURRENCY, MAX_FOLDER_FILES } = await import("../src/core/contracts.ts");
const { FolderChecklistBody, fileSize, folderItems, folderSummary } = await import("../components/folder-upload.tsx");
const { MaterialRow, materialFolder, materialStatus } = await import("../components/course-materials.tsx");
import type { MaterialView } from "../src/core/contracts.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20_000, 7)]);
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const p = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = (body: string, extra: Record<string, string | Uint8Array> = {}) =>
	tinyZip({ "word/document.xml": `<w:document xmlns:w="w" xmlns:r="r"><w:body>${body}<w:sectPr/></w:body></w:document>`, ...extra });

describe("library source paths", () => {
	it("keeps a folder upload's own folders and files a lone upload at the root", () => {
		assert.equal(librarySourcePath("Uni/Stats 201/Week 2.pdf", "Week 2.pdf"), "Uni/Stats 201/Week 2.pdf");
		assert.equal(librarySourcePath(null, "Week 2.pdf"), "Week 2.pdf");
		assert.equal(librarySourcePath("", "Week 2.pdf"), "Week 2.pdf");
	});

	it("cannot be steered outside its folders", () => {
		assert.equal(librarySourcePath("../../etc/x: y/a.md", "a.md"), "etc/x y/a.md");
		assert.equal(librarySourcePath("a\\b\\c.md", "c.md"), "a/b/c.md");
		assert.equal(librarySourcePath(Array.from({ length: 20 }, (_, i) => `d${i}`).join("/") + "/f.md", "f.md").split("/").length, 9);
	});
});

describe("the folder checklist's verdicts", () => {
	it("pre-selects marked tests from the file name, for photos and PDFs only", () => {
		for (const name of ["Midterm 1.pdf", "stats_exam_2019.PDF", "quiz3.jpg", "Final.pdf", "past paper.png", "marked-hw.heic", "Tests.pdf"]) {
			assert.deepEqual([folderFileVerdict(name, 1000).choice, folderFileVerdict(name, 1000).testable], ["test", true], name);
		}
		for (const name of ["Week 2 - Bayes.pdf", "latest.pdf", "contest.png", "protest.pdf"]) {
			assert.deepEqual([folderFileVerdict(name, 1000).choice, folderFileVerdict(name, 1000).testable], ["notes", true], name);
		}
		for (const name of ["exam notes.docx", "midterm review.pptx", "quiz.txt", "test.md"]) {
			assert.deepEqual(folderFileVerdict(name, 1000), { choice: "notes", testable: false, bookable: false }, name);
		}
	});

	it("greys out what cannot be read, with the reason", () => {
		assert.match(folderFileVerdict("old.ppt", 1000).refused!, /Old Office file/);
		assert.match(folderFileVerdict("essay.doc", 1000).refused!, /Old Office file/);
		assert.match(folderFileVerdict("grades.xlsx", 1000).refused!, /Not a supported file type/);
		assert.match(folderFileVerdict("no-extension", 1000).refused!, /Not a supported/);
		assert.match(folderFileVerdict("~$Week 1.docx", 1000).refused!, /temporary/);
		assert.match(folderFileVerdict("empty.pdf", 0).refused!, /empty/);
		assert.match(folderFileVerdict("huge.pptx", 25 * 1024 * 1024 + 1).refused!, /Max 25 MB/);
		assert.equal(folderFileVerdict("old.ppt", 1000).choice, "skip");
	});

	it("lists a folder sorted by path, without hidden files and folders", () => {
		const items = folderItems([
			{ name: "Week 10.pdf", size: 5, path: "Uni/Week 10.pdf" },
			{ name: "Week 2.pdf", size: 5, path: "Uni/Week 2.pdf" },
			{ name: ".DS_Store", size: 5, path: "Uni/.DS_Store" },
			{ name: "config", size: 5, path: "Uni/.git/config" },
			{ name: "exam.pdf", size: 5, path: "Uni/exam.pdf" },
			{ name: "a.xlsx", size: 5, path: "Uni/a.xlsx" },
		]);
		assert.deepEqual(items.map((item) => item.path), ["Uni/a.xlsx", "Uni/exam.pdf", "Uni/Week 2.pdf", "Uni/Week 10.pdf"]);
		assert.deepEqual(folderSummary(items), { notes: 2, tests: 1, books: 0, skipped: 1, label: "2 sets of notes · 1 marked test · 1 skipped" });
		assert.equal(fileSize(340 * 1024), "340 KB");
		assert.equal(fileSize(1.25 * 1024 * 1024), "1.3 MB");
	});
});

describe("FolderChecklistBody", () => {
	const noop = () => {};
	const items = folderItems([
		{ name: "Week 2.pdf", size: 2048, path: "Uni/Week 2.pdf" },
		{ name: "exam.pdf", size: 2048, path: "Uni/exam.pdf" },
		{ name: "notes.docx", size: 2048, path: "Uni/notes.docx" },
		{ name: "old.ppt", size: 2048, path: "Uni/old.ppt" },
	]);
	const body = (overrides: Partial<React.ComponentProps<typeof FolderChecklistBody>> = {}) =>
		renderToStaticMarkup(<FolderChecklistBody items={items} progress={null} onChoice={noop} onStart={noop} onClose={noop} {...overrides} />);

	it("lists every file with its choice and says nothing starts until Start", () => {
		const html = body();
		assert.equal(html.match(/data-testid="folder-item"/g)!.length, 4);
		assert.match(html, /Nothing is uploaded or read until you press Start\./);
		assert.match(html, /data-choice="test"[\s\S]*?Uni\/exam\.pdf/);
		assert.match(html, /data-choice="refused"[\s\S]*?Uni\/old\.ppt[\s\S]*?Old Office file[\s\S]*?Can’t be read/);
		assert.match(html, /2 sets of notes · 1 marked test · 1 skipped/);
		assert.match(html, /data-testid="folder-start"[^>]*>Start \(3 files\)/);
		assert.doesNotMatch(html, /data-testid="folder-start"[^>]* disabled=""/);
	});

	it("offers Marked test only where a test can be read, and no choice on refused files", () => {
		const html = body();
		assert.equal(html.match(/<select/g)!.length, 3);
		assert.equal(html.match(/<option value="test"/g)!.length, 2);
	});

	it("cannot start with nothing chosen, shows progress while uploading, and refuses huge folders", () => {
		const skipped = items.map((item) => ({ ...item, choice: "skip" as const }));
		assert.match(body({ items: skipped }), /data-testid="folder-start"[^>]* disabled=""/);
		const uploading = body({ progress: { done: 1, total: 3 } });
		assert.match(uploading, /Uploading 2 of 3…/);
		assert.match(uploading, /data-testid="folder-cancel"[^>]* disabled=""/);
		const many = Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, i) => ({ path: `f/${i}.md`, size: 1, choice: "notes" as const, testable: false, bookable: false }));
		const tooMany = body({ items: many });
		assert.match(tooMany, /data-testid="folder-too-many"/);
		assert.doesNotMatch(tooMany, /folder-start|folder-item/);
		assert.match(body({ items: [] }), /data-testid="folder-empty"/);
	});
});

describe("the Word reader", () => {
	it("reads paragraphs, headings, tabs, breaks, equations and tables in order", () => {
		const xml = `<w:body>${p("Probability", "Title")}${p("Bayes&apos; rule", "Heading2")}<w:p/>` +
			`<w:p><w:r><w:t xml:space="preserve">P(A|B) </w:t></w:r><w:r><w:tab/><w:t>is</w:t><w:br/><w:t>posterior</w:t></w:r><m:oMath><m:r><m:t>x&lt;1</m:t></m:r></m:oMath></w:p>` +
			`<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/>${p("Term")}</w:tc><w:tc>${p("Meaning")}</w:tc></w:tr><w:tr><w:tc>${p("Prior")}</w:tc><w:tc>${p("P(A)")}${p("before data")}</w:tc></w:tr></w:tbl>` +
			`${p("After the table")}</w:body>`;
		assert.equal(documentText(xml), [
			"# Probability", "## Bayes' rule", "P(A|B) \tis\nposteriorx<1", "| Term | Meaning |\n| Prior | P(A) before data |", "After the table",
		].join("\n\n"));
	});

	it("hands back content pictures in reading order and skips icons", () => {
		const rels = `<Relationships><Relationship Id="rId1" Type="${REL}/image" Target="media/big.png"/><Relationship Id="rId2" Type="${REL}/image" Target="media/icon.png"/><Relationship Id="rId3" Type="${REL}/image" Target="media/chart.emf"/></Relationships>`;
		const pic = (id: string) => `<w:p><w:r><w:drawing><a:blip r:embed="${id}"/></w:drawing></w:r></w:p>`;
		const doc = readDocument(docx(p("Intro") + pic("rId2") + pic("rId1") + pic("rId3") + pic("rId1"), {
			"word/_rels/document.xml.rels": rels, "word/media/big.png": PNG, "word/media/icon.png": PNG.subarray(0, 100), "word/media/chart.emf": PNG,
		}));
		assert.equal(doc.text, "Intro");
		assert.deepEqual(doc.pictures.map((picture) => picture.name), ["word/media/big.png"]);
		assert.equal(doc.skippedPictures, 2);
	});

	it("refuses what is not a Word file", () => {
		assert.throws(() => readDocument(Buffer.from("not a zip")), DocumentError);
		assert.throws(() => readDocument(tinyZip({ "ppt/presentation.xml": "<p/>" })), /Could not open this Word file/);
	});

	it("is detected by name among zips and converts with its pictures AI-read", async () => {
		assert.deepEqual(detectMaterialFormat("Essay.docx", docx(p("x"))), { format: "docx" });
		assert.match((detectMaterialFormat("grades.xlsx", docx(p("x"))) as { refused: string }).refused, /Word \(\.docx\)/);
		const file = path.join(root, "notes.docx");
		fs.writeFileSync(file, docx(p("Typed text") + `<w:p><w:r><a:blip r:embed="rId1"/></w:r></w:p>`, {
			"word/_rels/document.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/image" Target="media/a.png"/></Relationships>`, "word/media/a.png": PNG,
		}));
		const conversion = await convertMaterial("docx", file, async (_bytes, label) => `read ${label}`);
		assert.deepEqual(conversion.parts, [{ label: "Document", text: "Typed text", aiRead: [] }, { label: "Picture 1", text: "", aiRead: ["read Picture 1"] }]);
		const empty = path.join(root, "empty.docx");
		fs.writeFileSync(empty, docx("<w:p/>"));
		await assert.rejects(convertMaterial("docx", empty, async () => ""), /No text or readable pictures/);
	});
});

describe("library materials", () => {
	const imported: { filePath: string; text: string }[] = [];
	const gates: (() => void)[] = [];
	const behavior = { hold: false, importFails: null as Error | null };
	const service = createMaterialsService({
		stores,
		transcribe: async (_bytes, label) => `read ${label}`,
		importNotes: async (input) => {
			if (behavior.hold) await new Promise<void>((resolve) => gates.push(resolve));
			if (behavior.importFails) throw behavior.importFails;
			imported.push(input);
		},
		registerImport: () => {},
		abortExtraction: () => {},
		readTest: async () => ({ questions: [{ number: "1", question: "State Bayes' rule", answer: "P(A|B) = P(B|A)P(A)/P(B)", idea: "Bayes' rule", outcome: "correct" }] }),
		linkTest: async (questions) => questions.map(() => []),
		sourceIdeas: () => [],
		renderPdfPages: async () => [],
		removeEvidence: () => {},
	});
	const get = (id: string) => service.getMaterial(id)!.material;
	async function until(id: string, done: (material: MaterialView) => boolean): Promise<MaterialView> {
		for (let i = 0; i < 400; i++) {
			if (done(get(id))) return get(id);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`material never got there: ${JSON.stringify(get(id))}`);
	}
	const settled = (id: string) => until(id, (material) => material.status !== "processing");
	const upload = (name: string, relativePath?: string) => {
		const outcome = service.uploadMaterial({ path: relativePath }, name, Buffer.from(`# ${name}\n\nSome notes.`));
		assert.ok(outcome.ok, JSON.stringify(outcome));
		return outcome.material;
	};

	it("uploads with no course, filed under the folder it came from", async () => {
		const created = upload("Week 2.md", "Uni/Stats 201/Week 2.md");
		assert.equal(created.courseId, undefined);
		const done = await settled(created.id);
		assert.deepEqual([done.status, done.sourcePath], ["ready", "Uni/Stats 201/Week 2.md"]);
		assert.equal(imported.at(-1)!.filePath, "Uni/Stats 201/Week 2.md");
		assert.equal(materialFolder(done), "Uni/Stats 201");
		const lone = await settled(upload("Loose.md").id);
		assert.equal(lone.sourcePath, "Loose.md");
		assert.equal(materialFolder(lone), undefined);
		// An empty courseId (the route's absent query) is the library too; a wrong one is refused.
		assert.ok(service.uploadMaterial({ courseId: "" }, "b.md", Buffer.from("x")).ok);
		assert.equal((service.uploadMaterial({ courseId: "course_missing" }, "b.md", Buffer.from("x")) as { code: string }).code, "course_not_found");
	});

	it("the library lists every material; a course lists only its own", async () => {
		const course = stores.courseStore.createCourse("Algebra", "");
		const inCourse = service.uploadMaterial({ courseId: course.id }, "c.md", Buffer.from("Notes"));
		assert.ok(inCourse.ok);
		await settled(inCourse.material.id);
		assert.deepEqual(service.listCourseMaterials(course.id).map((m) => m.id), [inCourse.material.id]);
		const all = service.listMaterials();
		assert.ok(all.length >= 4 && all.some((m) => m.id === inCourse.material.id) && all.some((m) => m.courseId === undefined));
	});

	it("a library test records evidence with no course and deletes cleanly", async () => {
		const outcome = service.uploadTest({ path: "Uni/Stats 201/Midterm.png" }, [{ name: "Midterm.png", bytes: PNG }]);
		assert.ok(outcome.ok, JSON.stringify(outcome));
		assert.deepEqual([outcome.material.kind, outcome.material.courseId, outcome.material.sourcePath], ["test", undefined, "Uni/Stats 201/Midterm.png"]);
		await settled(outcome.material.id);
		assert.ok(service.approveMaterial(outcome.material.id, {}).ok);
		const done = await settled(outcome.material.id);
		assert.equal(done.status, "ready");
		const line = stores.evidenceStore.read().find((entry) => entry.materialId === done.id)!;
		assert.equal(line.outcome, "correct");
		assert.equal("courseId" in line, false);
		assert.equal(service.deleteMaterial(done.id), true);
	});

	it("runs two at a time; the rest wait as queued and start as slots free", async () => {
		behavior.hold = true;
		const ids = ["q1.md", "q2.md", "q3.md", "q4.md"].map((name) => upload(name, `Queue/${name}`).id);
		await until(ids[1]!, (material) => material.stage === "extracting");
		assert.equal(gates.length, MATERIAL_CONCURRENCY);
		assert.deepEqual(ids.map((id) => get(id).stage), ["extracting", "extracting", "queued", "queued"]);
		assert.deepEqual(ids.map((id) => get(id).interrupted), [false, false, false, false]);
		assert.deepEqual(materialStatus(get(ids[2]!)), { label: "Waiting…", busy: false, tone: "quiet" });
		// Deleting a waiting material gives its place up without taking a slot.
		assert.equal(service.deleteMaterial(ids[3]!), true);
		gates.shift()!();
		await settled(ids[0]!);
		await until(ids[2]!, (material) => material.stage === "extracting");
		assert.equal(gates.length, MATERIAL_CONCURRENCY);
		behavior.hold = false;
		for (const gate of gates.splice(0)) gate();
		assert.deepEqual((await Promise.all([ids[1]!, ids[2]!].map(settled))).map((m) => m.status), ["ready", "ready"]);
		// The slots are free again.
		assert.equal((await settled(upload("after.md").id)).status, "ready");
	});

	it("retry-all restarts every failed material and leaves the rest alone", async () => {
		behavior.importFails = new Error("You've hit your usage limit.");
		const failed = await Promise.all(["f1.md", "f2.md", "f3.md"].map((name) => settled(upload(name, `Fail/${name}`).id)));
		assert.deepEqual(failed.map((m) => [m.status, m.error]), Array(3).fill(["failed", "You've hit your usage limit."]));
		const before = imported.length;
		behavior.importFails = null;
		assert.equal(service.retryAllMaterials(), 3);
		assert.deepEqual((await Promise.all(failed.map((m) => settled(m.id)))).map((m) => m.status), ["ready", "ready", "ready"]);
		assert.equal(imported.length, before + 3);
		assert.equal(service.retryAllMaterials(), 0);
	});
});

describe("a library row", () => {
	it("shows the folder it came from", () => {
		const noop = () => {};
		const material: MaterialView = {
			id: "mat_1", title: "Week 2", kind: "notes", format: "docx", fileName: "Week 2.docx", sections: [], status: "ready", aiReadParts: 0,
			sourcePath: "Uni/Stats 201/Week 2.docx", createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", interrupted: false,
		};
		const html = renderToStaticMarkup(
			<MaterialRow material={material} where={materialFolder(material)} onReview={noop} onRetry={noop} onAskDelete={noop} onCancelDelete={noop} onDelete={noop} />,
		);
		assert.match(html, /Document · Uni\/Stats 201 ·/);
	});
});

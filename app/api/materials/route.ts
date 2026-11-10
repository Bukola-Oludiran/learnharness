import { materials } from "@/src/server";
import { MAX_MATERIAL_BYTES } from "@/src/core";

/** A marked test: several page photos (or one PDF) in one multipart body. */
const MAX_TEST_BODY_BYTES = 2 * MAX_MATERIAL_BYTES + 1024 * 1024;

export const dynamic = "force-dynamic";

/** GET /api/materials?courseId=… — a course's materials, oldest first;
 *  without a course, every material (the library). */
export async function GET(req: Request) {
	const courseId = new URL(req.url).searchParams.get("courseId");
	return Response.json({ materials: courseId ? materials.listCourseMaterials(courseId) : materials.listMaterials() });
}

/**
 * POST /api/materials?courseId=…&name=… (fork, phase 3a): upload one file to
 * a course — or, with no courseId, to the library, where `path` (the file's
 * folder-relative path in a folder upload) files it under its own folders.
 * The body is the raw file bytes; the name rides the query so no
 * multipart parsing is needed. Returns at once with the new record —
 * conversion runs in the background and is announced by `materials-changed`.
 */
export async function POST(req: Request) {
	const url = new URL(req.url);
	const target = { courseId: url.searchParams.get("courseId"), path: url.searchParams.get("path") };
	// kind=test: multipart, field "files" — the paper's pages become ONE material.
	if (url.searchParams.get("kind") === "test") {
		if (Number(req.headers.get("content-length") ?? "0") > MAX_TEST_BODY_BYTES) {
			return Response.json({ error: "Too big. Max 50 MB for one test.", code: "too_large" }, { status: 413 });
		}
		let form: FormData;
		try {
			form = await req.formData();
		} catch {
			return Response.json({ error: "Could not read the upload. Select the files again.", code: "bad_upload" }, { status: 400 });
		}
		const files = await Promise.all(
			form
				.getAll("files")
				.filter((entry): entry is File => entry instanceof File)
				.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })),
		);
		const outcome = materials.uploadTest(target, files);
		if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
		return Response.json({ material: outcome.material });
	}
	if (Number(req.headers.get("content-length") ?? "0") > MAX_MATERIAL_BYTES) {
		return Response.json({ error: "Too big. Max 25 MB.", code: "too_large" }, { status: 413 });
	}
	const bytes = new Uint8Array(await req.arrayBuffer());
	const outcome = materials.uploadMaterial(target, url.searchParams.get("name") ?? "", bytes);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ material: outcome.material });
}

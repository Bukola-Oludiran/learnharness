import { materials } from "@/src/server";
import { MAX_MATERIAL_BYTES } from "@/src/core";

export const dynamic = "force-dynamic";

/** GET /api/materials?courseId=… — a course's materials, oldest first. */
export async function GET(req: Request) {
	const courseId = new URL(req.url).searchParams.get("courseId") ?? "";
	return Response.json({ materials: materials.listCourseMaterials(courseId) });
}

/**
 * POST /api/materials?courseId=…&name=… (fork, phase 3a): upload one file to
 * a course. The body is the raw file bytes; the name rides the query so no
 * multipart parsing is needed. Returns at once with the new record —
 * conversion runs in the background and is announced by `materials-changed`.
 */
export async function POST(req: Request) {
	const url = new URL(req.url);
	if (Number(req.headers.get("content-length") ?? "0") > MAX_MATERIAL_BYTES) {
		return Response.json({ error: "Too big. Max 25 MB.", code: "too_large" }, { status: 413 });
	}
	const bytes = new Uint8Array(await req.arrayBuffer());
	const outcome = materials.uploadMaterial(url.searchParams.get("courseId"), url.searchParams.get("name") ?? "", bytes);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ material: outcome.material });
}

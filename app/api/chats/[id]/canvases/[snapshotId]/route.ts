import { MAX_SCENE_BYTES } from "@/src/core";
import { readCanvasScene, saveCanvas } from "@/src/server";

export const dynamic = "force-dynamic";

/** The saved scene of one drawing, to reopen and revise it. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; snapshotId: string }> }) {
	const { id, snapshotId } = await params;
	const scene = readCanvasScene(id, snapshotId);
	if (scene === null) return Response.json({ error: "Not found" }, { status: 404 });
	return new Response(scene, { headers: { "Content-Type": "application/json" } });
}

/** PUT (fork, phase 5a): keep the scene of a drawing whose image was just
 *  uploaded through the attachments route. The body is the scene JSON. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; snapshotId: string }> }) {
	const { id, snapshotId } = await params;
	if (Number(req.headers.get("content-length") ?? "0") > MAX_SCENE_BYTES) return Response.json({ error: "The drawing is too large to save" }, { status: 413 });
	const outcome = saveCanvas(id, snapshotId, await req.text());
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ ok: true });
}

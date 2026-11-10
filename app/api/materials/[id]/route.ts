import { materials } from "@/src/server";

export const dynamic = "force-dynamic";

/** One material with its transcript (null before conversion finishes). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const found = materials.getMaterial(id);
	if (!found) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(found);
}

/** Approve a material waiting for review. `text` (notes) or `reading`
 *  (tests), when sent, replaces what was read first — the learner's
 *  corrections. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { text?: unknown; reading?: unknown } | null;
	const outcome = materials.approveMaterial(id, { text: body?.text, reading: body?.reading });
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ material: outcome.material });
}

/** Delete the stored file and record. Ideas already in the graph stay. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!materials.deleteMaterial(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}

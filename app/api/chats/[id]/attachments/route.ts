import { MAX_ATTACHMENT_BYTES, saveAttachment } from "@/src/server";

/**
 * POST /api/chats/[id]/attachments (fork, phase 2): upload one photo of the
 * learner's work. The body is the raw image bytes. The response carries the
 * snapshot id an answer or practice submission then references — the photo
 * itself is served by the session's existing images route.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
		return Response.json({ error: "Image exceeds 25 MiB; provide a smaller image" }, { status: 413 });
	}
	const bytes = new Uint8Array(await req.arrayBuffer());
	const outcome = await saveAttachment(id, bytes, req.signal);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	const { ok: _ok, ...snapshot } = outcome;
	return Response.json(snapshot);
}

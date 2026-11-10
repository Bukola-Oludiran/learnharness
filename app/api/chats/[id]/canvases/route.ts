import { listCanvases } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/chats/[id]/canvases (fork, phase 5a): the session's saved
 *  drawings, oldest first — the canvas's "start from" list. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json({ canvases: listCanvases(id) });
}

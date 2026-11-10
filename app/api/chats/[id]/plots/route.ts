import { listSessionPlots } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/chats/[id]/plots (fork, phase 5b): the session's graphs — the
 *  tutor's and the learner's — for the grapher's "start from" list. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json({ plots: listSessionPlots(id) });
}

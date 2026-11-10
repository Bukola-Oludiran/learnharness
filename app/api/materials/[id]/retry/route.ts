import { materials } from "@/src/server";

/** Start a failed or interrupted material over from its stored original. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = materials.retryMaterial(id);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ material: outcome.material });
}

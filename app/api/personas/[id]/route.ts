import { deletePersona, updatePersona } from "@/src/server";

/** Edit a tutor; an absent key leaves that field alone. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { name?: unknown; engine?: unknown; promptOverlay?: unknown } | null;
	const outcome = updatePersona(id, { name: body?.name, engine: body?.engine, promptOverlay: body?.promptOverlay });
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ persona: outcome.persona });
}

/** Delete a tutor. Sessions and courses that used it fall back to their course's tutor or the default. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!deletePersona(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}

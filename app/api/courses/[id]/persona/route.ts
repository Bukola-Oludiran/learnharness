import { setCoursePersona } from "@/src/server";

/** Choose the course's tutor: a tutor id, or null or "default" for the default tutor. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { personaId?: unknown } | null;
	if (!body || !("personaId" in body)) return Response.json({ error: "personaId is required (a tutor id, \"default\", or null)." }, { status: 400 });
	const outcome = setCoursePersona(id, body.personaId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

import { sessionPersona, setSessionPersona } from "@/src/server";

/** Who teaches this session, and whether that is its own choice, its course's, or the default. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json(sessionPersona(id));
}

/** Choose this session's tutor: a tutor id, "default", or null to follow the course again. Applies from the next turn. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { personaId?: unknown } | null;
	if (!body || !("personaId" in body)) return Response.json({ error: "personaId is required (a tutor id, \"default\", or null)." }, { status: 400 });
	const outcome = setSessionPersona(id, body.personaId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json(outcome.session);
}

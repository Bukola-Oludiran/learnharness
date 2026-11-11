import { createPersona, listPersonas } from "@/src/server";

/** Every tutor (fork, phase 6b — see FORK.md), the default first. */
export async function GET() {
	return Response.json({ personas: listPersonas() });
}

/** Create a tutor: a name, a model from the catalog, and an optional overlay. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { name?: unknown; engine?: unknown; promptOverlay?: unknown } | null;
	const outcome = createPersona({ name: body?.name, engine: body?.engine, promptOverlay: body?.promptOverlay });
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ persona: outcome.persona }, { status: 201 });
}

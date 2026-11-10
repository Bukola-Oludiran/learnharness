import { syllabus } from "@/src/server";

export const dynamic = "force-dynamic";

/** Whether the course's syllabus is being built right now. The syllabus
 *  itself rides the course record. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json({ building: syllabus.isBuilding(id) });
}

/** Start (or restart) the syllabus build, with an optional note to the
 *  builder. Returns at once; `courses-changed` announces the result. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
	const outcome = syllabus.startBuild(id, body?.note);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course, building: true });
}

/** One edit to one unit: { unitId, op: "rename" | "move" | "skip" | "delete", … }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { unitId?: unknown; op?: unknown; title?: unknown; direction?: unknown; skipped?: unknown } | null;
	const unitId = typeof body?.unitId === "string" ? body.unitId : "";
	const outcome =
		body?.op === "rename"
			? syllabus.renameUnit(id, unitId, body.title)
			: body?.op === "move"
				? syllabus.moveUnit(id, unitId, body.direction)
				: body?.op === "skip"
					? syllabus.setUnitSkipped(id, unitId, body.skipped)
					: body?.op === "delete"
						? syllabus.deleteUnit(id, unitId)
						: ({ ok: false, status: 400, code: "bad_op", error: "Unknown edit." } as const);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

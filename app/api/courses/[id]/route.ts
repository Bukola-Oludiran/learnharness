import { deleteCourse, getCourse, materials, updateCourse } from "@/src/server";

/** One course, its sessions projected down to chats that still exist. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const course = getCourse(id);
	if (!course) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ course });
}

/** Edit title and/or goal; an absent key leaves that field alone. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown; goal?: unknown } | null;
	const outcome = updateCourse(id, { title: body?.title, goal: body?.goal });
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

/** Delete the course record. Its sessions are kept and become loose
 *  sessions; its uploaded materials go with it (their stored files would
 *  otherwise be unreachable), while ideas they added stay in the graph. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getCourse(id)) return Response.json({ error: "Not found" }, { status: 404 });
	for (const material of materials.listCourseMaterials(id)) materials.deleteMaterial(material.id);
	if (!deleteCourse(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}

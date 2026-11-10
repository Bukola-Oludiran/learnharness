import { syllabus } from "@/src/server";

/** Add a library book to the course (fork, phase 4b). The book stays in
 *  the library and may serve other courses too. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { materialId?: unknown } | null;
	const outcome = syllabus.addBook(id, body?.materialId);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

/** DELETE /api/courses/[id]/books?materialId=… — take a book out of the
 *  course. It stays in the library. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = syllabus.removeBook(id, new URL(req.url).searchParams.get("materialId") ?? "");
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

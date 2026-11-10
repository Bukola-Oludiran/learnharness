import { addSessionToCourse, removeSessionFromCourse } from "@/src/server";

/** Add an existing session to the course. A session already in another
 *  course moves here (one course per session). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { chatId?: unknown } | null;
	const outcome = addSessionToCourse(id, body?.chatId);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

/** DELETE /api/courses/[id]/sessions?chatId=… — take a session out of the
 *  course. The session itself is untouched. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chatId = new URL(req.url).searchParams.get("chatId") ?? "";
	const outcome = removeSessionFromCourse(id, chatId);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

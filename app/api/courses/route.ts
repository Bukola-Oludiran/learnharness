import { createCourse, listCourseSummaries } from "@/src/server";

/** The sidebar's course list (fork, phase 1): summaries, most recently updated first. */
export async function GET() {
	return Response.json({ courses: listCourseSummaries() });
}

/** Create a course. The title is required; the goal may be empty. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; goal?: unknown } | null;
	const outcome = createCourse({ title: body?.title, goal: body?.goal });
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ course: outcome.course });
}

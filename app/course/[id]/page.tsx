import { notFound } from "next/navigation";
import { CourseHome } from "@/components/course-home";
import { getCourse } from "@/src/server";

export const dynamic = "force-dynamic";

/** The course home (fork, phase 1): the record is server-read for the first
 *  frame; the client refetches it and joins the session list. */
export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const course = getCourse(id);
	if (!course) notFound();
	return <CourseHome key={course.id} initialCourse={course} />;
}

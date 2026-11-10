/**
 * The tutor's material tools, wired (fork, phase 3c — see FORK.md): the
 * agent-layer tools (agent/tools/ingest.ts) over the materials service. A
 * file added from a session goes to the session's course when it is in
 * one, otherwise to the library with no course.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createMaterialTools, type MaterialToolDeps } from "../agent/tools/ingest.ts";
import { createGraphTool } from "../agent/tools/plot.ts";
import { createUnitTool } from "../agent/tools/unit.ts";
import { courseOfSession } from "../core/course.ts";
import { nextUnit } from "../core/syllabus.ts";
import { syllabus } from "./syllabus.ts";
import { materials } from "./materials.ts";
import { stores } from "./stores.ts";

type MaterialsService = Pick<typeof materials, "uploadMaterial" | "uploadTest" | "uploadBook" | "listMaterials" | "bookList" | "readBook">;

export function materialToolDeps(chatId: string, service: MaterialsService = materials): MaterialToolDeps {
	return {
		ingest: (kind, files) => {
			// Resolved per call: the session may have joined or left a course mid-lesson.
			const target = { courseId: courseOfSession(stores.courseStore.listCourses(), chatId)?.id };
			const outcome =
				kind === "test"
					? service.uploadTest(target, files)
					: kind === "book"
						? service.uploadBook({}, files[0]!.name, files[0]!.bytes)
						: service.uploadMaterial(target, files[0]!.name, files[0]!.bytes);
			return outcome.ok ? { ok: true, id: outcome.material.id } : { ok: false, error: outcome.error };
		},
		read: async ({ material, section, part }) => {
			if (!material) return service.bookList();
			const outcome = await service.readBook(material, section, part);
			if (!outcome.ok) throw new Error(outcome.error);
			return outcome.text;
		},
		materials: (ids) => {
			const all = service.listMaterials();
			return ids ? all.filter((material) => ids.includes(material.id)) : all;
		},
	};
}

/** What mark_unit_covered answers the tutor with: done, and what comes next. */
export function coveredResultText(unitTitle: string, next: { title: string } | null): string {
	return `Unit "${unitTitle}" is marked covered. ${next ? `The next unit is "${next.title}".` : "That was the last unit of the syllabus."} Tell the learner.`;
}

/** The session's syllabus unit, when it is scoped to one that still exists. */
function unitOfSession(chatId: string) {
	const course = courseOfSession(stores.courseStore.listCourses(), chatId);
	const unitId = course?.sessions.find((session) => session.chatId === chatId)?.unitIds[0];
	const unit = unitId ? course?.syllabus?.units.find((u) => u.id === unitId) : undefined;
	return course && unit ? { course, unit } : null;
}

/** mark_unit_covered for a session scoped to a unit; null for any other session. */
export function unitToolFor(chatId: string, service: Pick<typeof syllabus, "setUnitCovered"> = syllabus): AgentTool<any> | null {
	if (!unitOfSession(chatId)) return null;
	return createUnitTool({
		markCovered: () => {
			// Resolved at call time: the unit may have been deleted or covered since the turn began.
			const scoped = unitOfSession(chatId);
			if (!scoped) throw new Error("This session's unit is no longer in the syllabus.");
			if (scoped.unit.status !== "covered") {
				const outcome = service.setUnitCovered(scoped.course.id, scoped.unit.id, true);
				if (!outcome.ok) throw new Error(outcome.error);
			}
			const after = stores.courseStore.getCourse(scoped.course.id)?.syllabus;
			return coveredResultText(scoped.unit.title, after ? nextUnit(after) : null);
		},
	});
}

/** The teacher's extra tools for one session. */
export function materialToolsFor(chatId: string): AgentTool<any>[] {
	const unitTool = unitToolFor(chatId);
	return [...createMaterialTools(materialToolDeps(chatId)), createGraphTool(), ...(unitTool ? [unitTool] : [])];
}

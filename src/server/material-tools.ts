/**
 * The tutor's material tools, wired (fork, phase 3c — see FORK.md): the
 * agent-layer tools (agent/tools/ingest.ts) over the materials service. A
 * file added from a session goes to the session's course when it is in
 * one, otherwise to the library with no course.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createMaterialTools, type MaterialToolDeps } from "../agent/tools/ingest.ts";
import { courseOfSession } from "../core/course.ts";
import { materials } from "./materials.ts";
import { stores } from "./stores.ts";

type MaterialsService = Pick<typeof materials, "uploadMaterial" | "uploadTest" | "listMaterials">;

export function materialToolDeps(chatId: string, service: MaterialsService = materials): MaterialToolDeps {
	return {
		ingest: (kind, files) => {
			// Resolved per call: the session may have joined or left a course mid-lesson.
			const target = { courseId: courseOfSession(stores.courseStore.listCourses(), chatId)?.id };
			const outcome = kind === "test" ? service.uploadTest(target, files) : service.uploadMaterial(target, files[0]!.name, files[0]!.bytes);
			return outcome.ok ? { ok: true, id: outcome.material.id } : { ok: false, error: outcome.error };
		},
		materials: (ids) => {
			const all = service.listMaterials();
			return ids ? all.filter((material) => ids.includes(material.id)) : all;
		},
	};
}

/** The teacher's extra tools for one session. */
export function materialToolsFor(chatId: string): AgentTool<any>[] {
	return createMaterialTools(materialToolDeps(chatId));
}

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";

/**
 * mark_unit_covered (fork, phase 4c — see FORK.md): the tutor's judgment
 * that the session's syllabus unit is done, recorded on the course. Teacher
 * only, and only in a session scoped to a unit. The learner can override
 * it on the course page. The agent layer may not import the server, so the
 * write arrives as `markCovered` (wired in server/material-tools.ts).
 * Description approved by the owner, 2026-11-10.
 */

const input = Type.Object({});

export function createUnitTool(deps: {
	/** Mark the session's unit covered; returns the line the tutor reads. Throws when there is no unit to mark. */
	markCovered: () => string;
}): AgentTool<typeof input> {
	return {
		name: "mark_unit_covered",
		label: "mark_unit_covered",
		description:
			"Mark this session's syllabus unit as covered. Call it once, when you have taught the unit's material and the learner's answers show they understood it. " +
			"Do not call it because time has passed or the learner wants to stop early; an unfinished unit stays in progress and can be continued later. " +
			"After calling it, tell the learner the unit is covered and what comes next.",
		parameters: input,
		execute: serverExecute("mark_unit_covered", input, (): string => deps.markCovered()),
	};
}

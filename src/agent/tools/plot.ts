import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { cleanPlotDoc, DEFINITION_START, MAX_LINE_CHARS, resolvePlot, type PlotDoc } from "../../core/plot/index.ts";

/**
 * graph (fork, phase 5b — see FORK.md): the tutor puts an interactive graph
 * into the lesson. Teacher only. Instant and model-free: the expressions
 * are read by the same parser the learner's grapher uses (core/plot), so
 * what the tutor writes, what the learner edits and what comes back in an
 * answer are one language.
 *
 * The record keeps the graph document (`details` → the tool part's output
 * → GraphCard). The tutor's result is text: what was shown, and any line
 * that could not be read. Description approved by the owner, 2026-11-10
 * (the 3D paragraph the same day, phase 5c; the calculus sentence, phase 5c3).
 */

export const MAX_GRAPH_EXPRESSIONS = 20;

const graphInput = Type.Object({
	expressions: Type.Array(Type.String({ minLength: 1, maxLength: MAX_LINE_CHARS }), {
		minItems: 1,
		maxItems: MAX_GRAPH_EXPRESSIONS,
		description: "One expression per entry, as plain text, such as y = a*sin(x) or a = 2",
	}),
	title: Type.Optional(Type.String({ maxLength: 120, description: "One short line shown above the graph" })),
	angles: Type.Optional(Type.Union([Type.Literal("radians"), Type.Literal("degrees")], { description: "The unit trig functions use; radians when omitted" })),
	dimension: Type.Optional(Type.Union([Type.Literal(2), Type.Literal(3)], { description: "2 for a flat graph (the default), 3 for a 3D graph the learner can rotate" })),
	xMin: Type.Optional(Type.Number({ description: "Left edge of the view; -10 when omitted (-5 in 3D)" })),
	xMax: Type.Optional(Type.Number({ description: "Right edge of the view; 10 when omitted (5 in 3D)" })),
	yMin: Type.Optional(Type.Number({ description: "Bottom edge of the view" })),
	yMax: Type.Optional(Type.Number({ description: "Top edge of the view" })),
	zMin: Type.Optional(Type.Number({ description: "3D only: the bottom of the box; -5 when omitted" })),
	zMax: Type.Optional(Type.Number({ description: "3D only: the top of the box; 5 when omitted" })),
	uMin: Type.Optional(Type.Number({ description: "3D only: start of u for parametric surfaces; 0 when omitted" })),
	uMax: Type.Optional(Type.Number({ description: "3D only: end of u; 2π when omitted" })),
	vMin: Type.Optional(Type.Number({ description: "3D only: start of v; 0 when omitted" })),
	vMax: Type.Optional(Type.Number({ description: "3D only: end of v; 2π when omitted" })),
	tMin: Type.Optional(Type.Number({ description: "Start of t or theta for parametric and polar curves; 0 when omitted" })),
	tMax: Type.Optional(Type.Number({ description: "End of t or theta; 2π when omitted" })),
	sliders: Type.Optional(
		Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 1 }), min: Type.Number(), max: Type.Number() }), {
			maxItems: 10,
			description: "Ranges for sliders, by letter; a slider runs from -10 to 10 when not listed",
		}),
	),
});

/** The graph document a tool call describes. Pure — exported for tests. */
export function graphDocOf(input: {
	expressions: string[];
	title?: string;
	dimension?: 2 | 3;
	angles?: "radians" | "degrees";
	zMin?: number;
	zMax?: number;
	uMin?: number;
	uMax?: number;
	vMin?: number;
	vMax?: number;
	xMin?: number;
	xMax?: number;
	yMin?: number;
	yMax?: number;
	tMin?: number;
	tMax?: number;
	sliders?: { name: string; min: number; max: number }[];
}): PlotDoc {
	const ranges = new Map((input.sliders ?? []).map((slider) => [slider.name, slider]));
	const doc = cleanPlotDoc({
		title: input.title,
		...(input.angles === "degrees" ? { angles: "degrees" } : {}),
		lines: input.expressions.map((text) => {
			const range = ranges.get(DEFINITION_START.exec(text)?.[1] ?? "");
			return { text, ...(range ? { min: range.min, max: range.max } : {}) };
		}),
		...(input.dimension === 3
			? { mode: "3d", box: { xMin: input.xMin, xMax: input.xMax, yMin: input.yMin, yMax: input.yMax, zMin: input.zMin, zMax: input.zMax }, uMin: input.uMin, uMax: input.uMax, vMin: input.vMin, vMax: input.vMax }
			: { view: { xMin: input.xMin, xMax: input.xMax, yMin: input.yMin, yMax: input.yMax } }),
		tMin: input.tMin,
		tMax: input.tMax,
	});
	if (!doc) throw new Error("The graph could not be built.");
	return doc;
}

/** What the tutor reads back. Throws when no line could be read at all. */
export function graphResultText(doc: PlotDoc): string {
	const resolved = resolvePlot(doc);
	const problems = resolved.lines.flatMap((line, index) => (line.kind === "error" ? [`- ${JSON.stringify(doc.lines[index]!.text)}: ${line.error}`] : []));
	const shown = doc.lines.length - problems.length;
	if (shown === 0) throw new Error(["No expression could be read, so nothing was shown:", ...problems].join("\n"));
	return [
		`Graph shown to the learner: ${shown} ${shown === 1 ? "expression" : "expressions"}.`,
		...(problems.length > 0 ? ["", "Could not be read (fix and call again):", ...problems] : []),
	].join("\n");
}

export function createGraphTool(): AgentTool<typeof graphInput> {
	return {
		name: "graph",
		label: "graph",
		description: [
			"Put an interactive graph into the lesson. The learner can pan, zoom, drag its sliders and open it in their own grapher. Instant.",
			"Give each expression as plain text: a function of x (y = sin(x), or just x^2 - 1); a function of y (x = y^2); an implicit equation (x^2 + y^2 = 9); " +
				"a parametric curve ((cos(t), sin(2t)), t from 0 to 2π unless you set a range); a polar curve (r = 1 + cos(theta)); points ((1, 2), (3, 4)); " +
				"or a slider (a = 2), which sets a letter the other expressions can use and the learner can drag. Write multiplication as 2x or 2*x and powers with ^. Angles are in radians unless you set angles to degrees. " +
				"You can also write int(expr, var, from, to) for a definite integral, deriv(expr, var) for a derivative, sum(expr, var, from, to) and prod(expr, var, from, to), " +
				"and define a function with f(x) = … to use as f(2), f(x - 1) or f'(x).",
			"Set dimension to 3 for a 3D graph the learner can rotate. There, give a surface as z = x^2 + y^2 (or just an expression in x and y); " +
				"any equation in x, y and z as an implicit surface (x^2 + y^2 + z^2 = 9, or a plane 2x + y - z = 4); a space curve as (cos(t), sin(t), t); " +
				"a parametric surface as (u*cos(v), u*sin(v), v), with u and v from 0 to 2π unless you set ranges; and points as (1, 2, 3). " +
				"The box runs from -5 to 5 on each axis unless you set it.",
			"Use it when seeing the curve teaches something: how a parameter changes a shape, where two curves meet, what a transformation does. " +
				"The result names any expression that could not be read; fix it and call again.",
		].join("\n\n"),
		parameters: graphInput,
		execute: serverExecute("graph", graphInput, (input): ImageFileResult => {
			const doc = graphDocOf(input);
			return { text: graphResultText(doc), details: doc };
		}),
	};
}

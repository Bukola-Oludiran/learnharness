/**
 * The grapher's document model (fork, phase 5b — see FORK.md): what a graph
 * IS (a list of expression lines and a view), how each line is understood,
 * and the text the tutor reads for a graph the learner sends. Pure.
 *
 * A line is one of: a function of x (`y = …` or a bare expression in x), a
 * function of y (`x = …`), a polar curve (`r = …` in theta), a parametric
 * curve (`(x(t), y(t))`), points (`(1, 2), (3, 4)`), an implicit curve (any
 * other equation in x and y), or a definition (`a = 2`) — a number other
 * lines can use, shown as a slider when it is a plain number.
 *
 * The document records its mode ("2d"; 3D arrives in a later phase) and
 * each resolved line its kind, so new kinds extend the format.
 */

import { compile, ExprError, parseTokens, splitEquation, tokenize, variablesOf, type Compiled, type Expr, type Scope } from "./expr.ts";

export interface PlotView {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

export interface PlotLine {
	id: string;
	text: string;
	/** Index into the palette; assigned at creation so a line keeps its colour. */
	color?: number;
	hidden?: boolean;
	/** A definition's slider range. */
	min?: number;
	max?: number;
}

export interface PlotDoc {
	type: "plot";
	mode: "2d";
	title?: string;
	lines: PlotLine[];
	view: PlotView;
	/** The parameter range of parametric and polar curves. */
	tMin?: number;
	tMax?: number;
}

export const DEFAULT_VIEW: PlotView = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
export const DEFAULT_SLIDER = { min: -10, max: 10 };
export const MAX_PLOT_LINES = 30;
export const MAX_LINE_CHARS = 300;
export const PLOT_COLORS = ["#4f9cf9", "#f2545b", "#3fb37f", "#d9a441", "#b07cf7", "#f08a4b", "#39c5cf", "#e56bb5"];

export type ResolvedLine =
	| { id: string; kind: "explicit-y" | "explicit-x" | "polar"; fn: Compiled }
	| { id: string; kind: "implicit"; fn: Compiled }
	| { id: string; kind: "parametric"; x: Compiled; y: Compiled }
	| { id: string; kind: "points"; points: [number, number][] }
	| { id: string; kind: "definition"; name: string; value: number; slider: boolean }
	| { id: string; kind: "empty" }
	| { id: string; kind: "error"; error: string };

const RESERVED = new Set(["x", "y", "t", "r", "theta"]);

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** A line understood but not yet evaluated: points still hold their coordinate expressions. */
type Draft = DistributiveOmit<Exclude<ResolvedLine, { kind: "points" }>, "id"> | { kind: "points"; fns: [Compiled, Compiled][] };

function classify(text: string, defined: ReadonlySet<string>): { line: Draft; define?: { name: string; fn: Compiled } } {
	const tokens = tokenize(text);
	if (tokens.length === 0) return { line: { kind: "empty" } };
	const sides = splitEquation(tokens);
	const undefinedIn = (expr: Expr, allowed: readonly string[]) => [...variablesOf(expr)].filter((name) => !allowed.includes(name) && !defined.has(name));
	const check = (expr: Expr, allowed: readonly string[]) => {
		const missing = undefinedIn(expr, allowed);
		if (missing.length > 0) {
			const name = missing[0]!;
			throw new ExprError(RESERVED.has(name) ? `"${name}" cannot be used in this kind of expression.` : `"${name}" is not defined. Add a line such as ${name} = 1.`);
		}
	};
	const scalar = (list: Expr[]): Expr => {
		if (list.length !== 1 || list[0]!.type === "tuple" || list[0]!.type === "matrix") throw new ExprError("Expected a single expression on each side of =.");
		return list[0]!;
	};

	if (!sides) {
		const list = parseTokens(tokens);
		if (list.some((item) => item.type === "matrix")) throw new ExprError("Matrices arrive in a later version of the grapher.");
		if (list.every((item) => item.type === "tuple")) {
			const tuples = list as Extract<Expr, { type: "tuple" }>[];
			if (tuples.some((tuple) => tuple.items.length !== 2)) throw new ExprError("A point needs two coordinates here; 3D arrives in a later version.");
			if (tuples.length === 1 && variablesOf(tuples[0]!).has("t")) {
				for (const item of tuples[0]!.items) check(item, ["t"]);
				return { line: { kind: "parametric", x: compile(tuples[0]!.items[0]!), y: compile(tuples[0]!.items[1]!) } };
			}
			for (const tuple of tuples) for (const item of tuple.items) check(item, []);
			// Points are constants given the definitions; evaluated by the caller with the scope.
			return { line: { kind: "points", fns: tuples.map((tuple) => [compile(tuple.items[0]!), compile(tuple.items[1]!)]) } };
		}
		const expr = scalar(list);
		const vars = variablesOf(expr);
		if (vars.has("y") && !vars.has("x")) throw new ExprError("Write this as an equation, such as x = … or y = ….");
		check(expr, ["x"]);
		return { line: { kind: "explicit-y", fn: compile(expr) } };
	}

	if (sides.left.length === 0 || sides.right.length === 0) throw new ExprError("Something is missing on one side of =.");
	// f(x) = … reads as f·x to the parser; say what it is instead.
	const [head, open, , close] = sides.left;
	if (sides.left.length === 4 && head?.kind === "name" && head.name.length === 1 && !RESERVED.has(head.name) && open?.kind === "op" && open.op === "(" && close?.kind === "op" && close.op === ")") {
		throw new ExprError("Write this as y = … (function definitions like f(x) = … are not supported yet).");
	}
	const left = scalar(parseTokens(sides.left));
	const right = scalar(parseTokens(sides.right));
	const rightVars = variablesOf(right);
	if (left.type === "call") throw new ExprError("Write this as y = … (function definitions like f(x) = … are not supported yet).");
	if (left.type === "var") {
		const name = left.name;
		if (name === "y" && !rightVars.has("y")) {
			check(right, ["x"]);
			return { line: { kind: "explicit-y", fn: compile(right) } };
		}
		if (name === "x" && !rightVars.has("x")) {
			check(right, ["y"]);
			return { line: { kind: "explicit-x", fn: compile(right) } };
		}
		if (name === "r" && !rightVars.has("x") && !rightVars.has("y") && !defined.has("r")) {
			check(right, ["theta"]);
			return { line: { kind: "polar", fn: compile(right) } };
		}
		if (!RESERVED.has(name) && name !== "e" && name !== "pi") {
			if (defined.has(name)) throw new ExprError(`"${name}" is already defined above.`);
			check(right, []);
			return { line: { kind: "definition", name, value: NaN, slider: right.type === "num" || (right.type === "neg" && right.arg.type === "num") }, define: { name, fn: compile(right) } };
		}
	}
	check(left, ["x", "y"]);
	check(right, ["x", "y"]);
	const l = compile(left);
	const r = compile(right);
	return { line: { kind: "implicit", fn: (scope) => l(scope) - r(scope) } };
}

export interface ResolvedPlot {
	lines: ResolvedLine[];
	/** The values of every definition, by name. */
	scope: Scope;
}

/** Understand every line, top to bottom. A definition is usable by the lines below and above it. */
export function resolvePlot(doc: Pick<PlotDoc, "lines">): ResolvedPlot {
	const scope: Scope = {};
	const defined = new Set<string>();
	// Definitions first, in order, so a curve may use a slider written below it.
	const drafts = new Map<string, ReturnType<typeof classify> | { error: string }>();
	const tryClassify = (line: PlotLine) => {
		try {
			return classify(line.text.slice(0, MAX_LINE_CHARS), defined);
		} catch (error) {
			return { error: error instanceof ExprError ? error.message : "This could not be read." };
		}
	};
	for (const line of doc.lines) {
		if (!/^\s*[A-Za-z]\s*=/.test(line.text)) continue;
		const draft = tryClassify(line);
		if ("error" in draft || !draft.define) continue;
		const value = draft.define.fn(scope);
		scope[draft.define.name] = value;
		defined.add(draft.define.name);
		if (draft.line.kind === "definition") drafts.set(line.id, { line: { ...draft.line, value } });
	}
	const lines: ResolvedLine[] = doc.lines.map((line) => {
		const draft = drafts.get(line.id) ?? tryClassify(line);
		if ("error" in draft) return { id: line.id, kind: "error", error: draft.error };
		if (draft.line.kind === "points") return { id: line.id, kind: "points", points: draft.line.fns.map(([x, y]) => [x(scope), y(scope)]) };
		if (draft.line.kind === "definition" && !drafts.has(line.id)) return { id: line.id, kind: "error", error: "This definition could not be used." };
		return { id: line.id, ...draft.line };
	});
	return { lines, scope };
}

const fmt = (value: number) => (Number.isFinite(value) ? String(Math.round(value * 1e4) / 1e4) : String(value));

/** Replace a definition line's number (a dragged slider). */
export function withSliderValue(doc: PlotDoc, lineId: string, value: number): PlotDoc {
	return {
		...doc,
		lines: doc.lines.map((line) => (line.id === lineId ? { ...line, text: line.text.replace(/=.*$/, `= ${fmt(value)}`) } : line)),
	};
}

/**
 * A graph from untrusted input (the tutor's tool call, a saved file, the
 * learner's upload), bounded and normalised. Null when it is not a graph.
 */
export function cleanPlotDoc(raw: unknown): PlotDoc | null {
	const input = raw as Partial<PlotDoc> | null;
	if (!input || typeof input !== "object" || !Array.isArray(input.lines)) return null;
	const lines: PlotLine[] = [];
	for (const [index, entry] of input.lines.slice(0, MAX_PLOT_LINES).entries()) {
		const line = entry as Partial<PlotLine> | null;
		if (!line || typeof line.text !== "string") continue;
		const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
		const min = num(line.min);
		const max = num(line.max);
		lines.push({
			id: typeof line.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(line.id) ? line.id : `l${index + 1}`,
			text: line.text.slice(0, MAX_LINE_CHARS),
			color: Number.isInteger(line.color) ? Math.abs(line.color as number) % PLOT_COLORS.length : index % PLOT_COLORS.length,
			...(line.hidden === true ? { hidden: true } : {}),
			...(min !== undefined && max !== undefined && min < max ? { min, max } : {}),
		});
	}
	const view = cleanView(input.view);
	const tMin = typeof input.tMin === "number" && Number.isFinite(input.tMin) ? input.tMin : undefined;
	const tMax = typeof input.tMax === "number" && Number.isFinite(input.tMax) ? input.tMax : undefined;
	return {
		type: "plot",
		mode: "2d",
		...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim().slice(0, 120) } : {}),
		lines,
		view,
		...(tMin !== undefined && tMax !== undefined && tMin < tMax ? { tMin, tMax } : {}),
	};
}

export function cleanView(raw: unknown): PlotView {
	const v = raw as Partial<PlotView> | null | undefined;
	const ok = (min: unknown, max: unknown): min is number =>
		typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && max - min > 1e-9 && max - min < 1e12;
	if (!v) return { ...DEFAULT_VIEW };
	return {
		...(ok(v.xMin, v.xMax) ? { xMin: v.xMin, xMax: v.xMax as number } : { xMin: DEFAULT_VIEW.xMin, xMax: DEFAULT_VIEW.xMax }),
		...(ok(v.yMin, v.yMax) ? { yMin: v.yMin, yMax: v.yMax as number } : { yMin: DEFAULT_VIEW.yMin, yMax: DEFAULT_VIEW.yMax }),
	};
}

export function emptyPlotDoc(): PlotDoc {
	return { type: "plot", mode: "2d", lines: [{ id: "l1", text: "", color: 0 }], view: { ...DEFAULT_VIEW } };
}

/** A fresh line id not used in the document. */
export function nextLineId(doc: Pick<PlotDoc, "lines">): string {
	for (let n = doc.lines.length + 1; ; n++) if (!doc.lines.some((line) => line.id === `l${n}`)) return `l${n}`;
}

/** The lines of a graph, numbered, as the tutor reads them. */
export function plotOutline(doc: PlotDoc): string {
	const resolved = resolvePlot(doc);
	const rows: string[] = [];
	for (const [index, line] of doc.lines.entries()) {
		if (!line.text.trim()) continue;
		const meaning = resolved.lines[index]!;
		const notes: string[] = [];
		if (meaning.kind === "definition" && meaning.slider) notes.push(`slider, from ${fmt(line.min ?? DEFAULT_SLIDER.min)} to ${fmt(line.max ?? DEFAULT_SLIDER.max)}`);
		if (meaning.kind === "error") notes.push(`could not be read: ${meaning.error}`);
		if (line.hidden) notes.push("hidden");
		rows.push(`${rows.length + 1}. ${line.text.trim()}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
	}
	if (rows.length === 0) return "";
	const { xMin, xMax, yMin, yMax } = doc.view;
	return [...rows, `View: x from ${fmt(xMin)} to ${fmt(xMax)}, y from ${fmt(yMin)} to ${fmt(yMax)}`].join("\n");
}

/** The text block before a graph's picture in the tutor's input (wording
 *  approved by the owner, 2026-11-10). */
export function plotOutlineBlock(outline: string): string {
	return `The learner's graph, as they entered it. The picture shows the view they had when they sent it.\n\n${outline}`;
}

/** The paragraph the photo rule gains for graphs (approved the same day). */
export const PLOT_RULE =
	"A graph from the learner's grapher arrives with the expressions they entered. Judge those expressions and slider values; use the picture only to see the view they chose.";

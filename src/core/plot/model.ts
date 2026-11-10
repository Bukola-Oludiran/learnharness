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
 * In 3D (phase 5c) a line is a surface (`z = …`, or a bare expression in x
 * and y; likewise `x = …` and `y = …`), an implicit surface (any other
 * equation in x, y and z), a space curve (`(x(t), y(t), z(t))`), a
 * parametric surface (the same in u and v), or points (`(1, 2, 3)`).
 *
 * The document records its mode and each resolved line its kind, so new
 * kinds extend the format. The same line can mean different things in the
 * two modes: `x^2 + y^2 = 4` is a circle in 2D and a cylinder in 3D.
 */

import { compile as compileExpr, ExprError, parseTokens, splitEquation, tokenize, variablesOf, type Compiled, type Expr, type Scope, type UserFunction } from "./expr.ts";

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
	/** The line as typeset in the maths editor (phase 5c3). `text` stays the
	 *  truth — what is parsed, saved and sent to the tutor; this only keeps
	 *  the editor showing exactly what was typed. Absent → derived from text. */
	latex?: string;
	/** Why the editor's contents could not be turned into `text`. */
	problem?: string;
}

/** The box a 3D graph shows. */
export interface PlotBox {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
	zMin: number;
	zMax: number;
}

export type PlotMode = "2d" | "3d";

export interface PlotDoc {
	type: "plot";
	mode: PlotMode;
	title?: string;
	lines: PlotLine[];
	view: PlotView;
	/** The parameter range of parametric and polar curves. */
	tMin?: number;
	tMax?: number;
	/** Trig in degrees (phase 5c2); radians when absent. */
	angles?: "degrees";
	/** 3D: the box shown (the 2D view is kept, so switching back restores it). */
	box?: PlotBox;
	/** 3D: the parameter ranges of parametric surfaces; 0 to 2π when absent. */
	uMin?: number;
	uMax?: number;
	vMin?: number;
	vMax?: number;
}

export const DEFAULT_BOX: PlotBox = { xMin: -5, xMax: 5, yMin: -5, yMax: 5, zMin: -5, zMax: 5 };

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
	// 3D. A surface gives one coordinate (`axis`) from the other two, in x-y-z order.
	| { id: string; kind: "surface"; axis: "x" | "y" | "z"; fn: Compiled }
	| { id: string; kind: "implicit3"; fn: Compiled }
	| { id: string; kind: "curve3"; x: Compiled; y: Compiled; z: Compiled }
	| { id: string; kind: "param-surface"; x: Compiled; y: Compiled; z: Compiled }
	| { id: string; kind: "points3"; points: [number, number, number][] }
	/** A function definition that is not itself drawn (f(t) = … on a 2D graph still defines f). */
	| { id: string; kind: "function"; name: string; params: string[] }
	/** A line with no variables: a calculation, shown as its value and not drawn. */
	| { id: string; kind: "value"; value: number }
	| { id: string; kind: "empty" }
	/** `fix` names the mode in which the line would work, when that is the problem. */
	| { id: string; kind: "error"; error: string; fix?: PlotMode };

/** A line that is right, but for the other mode. */
export class ModeError extends ExprError {
	constructor(
		message: string,
		readonly fix: PlotMode,
	) {
		super(message);
	}
}

/** A line that starts like a definition: one letter (Latin or Greek), then =. */
export const DEFINITION_START = /^\s*([A-Za-zα-ωΑ-Ω])\s*=/;

/** Letters that are coordinates or parameters and so cannot be sliders. `z`
 *  is reserved in 2D too, so a 3D line typed there can say what it needs. */
const RESERVED_2D = new Set(["x", "y", "z", "t", "r", "theta"]);
const RESERVED_3D = new Set(["x", "y", "z", "t", "u", "v", "theta"]);

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** A line understood but not yet evaluated: points still hold their coordinate expressions. */
type Draft =
	| DistributiveOmit<Exclude<ResolvedLine, { kind: "points" | "points3" | "value" }>, "id">
	| { kind: "value"; fn: Compiled }
	| { kind: "points"; fns: [Compiled, Compiled][] }
	| { kind: "points3"; fns: [Compiled, Compiled, Compiled][] };
type Classified = { line: Draft; define?: { name: string; fn: Compiled } };

/** The graph's own functions: the names (known before any body is parsed,
 *  so f(…) reads as a call everywhere) and the table bodies are compiled against. */
interface FunctionContext {
	names: ReadonlySet<string>;
	table: Record<string, UserFunction>;
}

/** A line that starts like a function definition: f(x) = or g(x, y) =. */
const LETTER = "[A-Za-zα-ωΑ-Ω]";
export const FUNCTION_START = new RegExp(`^\\s*(${LETTER})\\s*\\(\\s*(${LETTER}(?:\\s*,\\s*${LETTER})*)\\s*\\)\\s*=`);
const NOT_A_FUNCTION_NAME = new Set(["x", "y", "z", "t", "r", "u", "v", "e"]);

/** The name and parameters a definition line declares, or null when it is not one. */
export function functionHeader(text: string): { name: string; params: string[] } | null {
	const match = FUNCTION_START.exec(text);
	if (!match || NOT_A_FUNCTION_NAME.has(match[1]!)) return null;
	const params = match[2]!.split(",").map((param) => param.trim());
	return new Set(params).size === params.length ? { name: match[1]!, params } : null;
}

function classify(text: string, defined: ReadonlySet<string>, mode: PlotMode, degrees: boolean, fns: FunctionContext): Classified {
	const RESERVED = mode === "3d" ? RESERVED_3D : RESERVED_2D;
	const compile = (expr: Expr) => compileExpr(expr, { degrees, functions: fns.table });
	const parse = (list: ReturnType<typeof tokenize>) => parseTokens(list, fns.names);
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

	const definition = (name: string, right: Expr): Classified => {
		if (defined.has(name)) throw new ExprError(`"${name}" is already defined above.`);
		check(right, []);
		return { line: { kind: "definition", name, value: NaN, slider: right.type === "num" || (right.type === "neg" && right.arg.type === "num") }, define: { name, fn: compile(right) } };
	};
	// f(x) = …: a function definition. On a flat graph a function of one
	// variable is also drawn as y = f(x); in 3D one of two variables as z = f(x, y).
	const header = sides ? functionHeader(text) : null;
	if (header && sides && fns.names.has(header.name)) {
		const body = scalar(parse(sides.right));
		check(body, header.params);
		const fn = compile(body);
		const drawnOn = mode === "2d" && header.params.length === 1 ? ["x"] : mode === "3d" && header.params.length === 2 ? ["x", "y"] : null;
		if (!drawnOn) return { line: { kind: "function", name: header.name, params: header.params } };
		const drawn: Compiled = (scope) => {
			const local: Scope = Object.create(scope);
			header.params.forEach((param, index) => {
				local[param] = scope[drawnOn[index]!] ?? NaN;
			});
			return fn(local);
		};
		return { line: mode === "2d" ? { kind: "explicit-y", fn: drawn } : { kind: "surface", axis: "z", fn: drawn } };
	}
	if (mode === "3d") return classify3d();

	if (!sides) {
		const list = parse(tokens);
		if (list.some((item) => item.type === "matrix")) throw new ExprError("Matrices arrive in a later version of the grapher.");
		if (list.every((item) => item.type === "tuple")) {
			const tuples = list as Extract<Expr, { type: "tuple" }>[];
			if (tuples.some((tuple) => tuple.items.length === 3)) throw new ModeError("A point with three coordinates needs a 3D graph.", "3d");
			if (tuples.some((tuple) => tuple.items.length !== 2)) throw new ExprError("A point needs two coordinates.");
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
		if (vars.has("z")) throw new ModeError("This uses z, so it needs a 3D graph.", "3d");
		if (vars.has("y") && !vars.has("x")) throw new ExprError("Write this as an equation, such as x = … or y = ….");
		check(expr, ["x"]);
		// No x at all: a calculation, not a curve (write y = 5 for the line).
		if (!vars.has("x")) return { line: { kind: "value", fn: compile(expr) } };
		return { line: { kind: "explicit-y", fn: compile(expr) } };
	}

	if (sides.left.length === 0 || sides.right.length === 0) throw new ExprError("Something is missing on one side of =.");
	const left = scalar(parse(sides.left));
	const right = scalar(parse(sides.right));
	const rightVars = variablesOf(right);
	if (variablesOf(left).has("z") || rightVars.has("z")) throw new ModeError("This uses z, so it needs a 3D graph.", "3d");
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
		if (!RESERVED.has(name) && name !== "e" && name !== "pi") return definition(name, right);
	}
	check(left, ["x", "y"]);
	check(right, ["x", "y"]);
	const l = compile(left);
	const r = compile(right);
	return { line: { kind: "implicit", fn: (scope) => l(scope) - r(scope) } };

	function classify3d(): Classified {
		if (!sides) {
			const list = parse(tokens);
			if (list.some((item) => item.type === "matrix")) throw new ExprError("Matrices arrive in a later version of the grapher.");
			if (list.every((item) => item.type === "tuple")) {
				const tuples = list as Extract<Expr, { type: "tuple" }>[];
				if (tuples.some((tuple) => tuple.items.length === 2)) throw new ModeError("A point with two coordinates belongs on a 2D graph; here a point needs three.", "2d");
				if (tuples.some((tuple) => tuple.items.length !== 3)) throw new ExprError("A point needs three coordinates.");
				const only = tuples.length === 1 ? tuples[0]! : null;
				const vars = only ? variablesOf(only) : new Set<string>();
				const three = (tuple: Extract<Expr, { type: "tuple" }>) => [compile(tuple.items[0]!), compile(tuple.items[1]!), compile(tuple.items[2]!)] as [Compiled, Compiled, Compiled];
				if (only && (vars.has("u") || vars.has("v"))) {
					for (const item of only.items) check(item, ["u", "v"]);
					const [x, y, z] = three(only);
					return { line: { kind: "param-surface", x, y, z } };
				}
				if (only && vars.has("t")) {
					for (const item of only.items) check(item, ["t"]);
					const [x, y, z] = three(only);
					return { line: { kind: "curve3", x, y, z } };
				}
				for (const tuple of tuples) for (const item of tuple.items) check(item, []);
				return { line: { kind: "points3", fns: tuples.map(three) } };
			}
			const expr = scalar(list);
			if (variablesOf(expr).has("z")) throw new ExprError("Write this as an equation, such as z = … or … = 0.");
			check(expr, ["x", "y"]);
			if (!variablesOf(expr).has("x") && !variablesOf(expr).has("y")) return { line: { kind: "value", fn: compile(expr) } };
			return { line: { kind: "surface", axis: "z", fn: compile(expr) } };
		}
		if (sides.left.length === 0 || sides.right.length === 0) throw new ExprError("Something is missing on one side of =.");
		const left = scalar(parse(sides.left));
		const right = scalar(parse(sides.right));
		const rightVars = variablesOf(right);
		if (left.type === "var") {
			const name = left.name;
			if (name === "r" && !defined.has("r") && rightVars.has("theta")) throw new ModeError("Polar curves only work on a 2D graph.", "2d");
			const others = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] }[name as "x" | "y" | "z"];
			// z = f(x, y) is drawn directly; so are x = f(y, z) and y = f(x, z).
			if (others && !rightVars.has(name)) {
				check(right, others);
				return { line: { kind: "surface", axis: name as "x" | "y" | "z", fn: compile(right) } };
			}
			if (!RESERVED.has(name) && name !== "e" && name !== "pi") return definition(name, right);
		}
		check(left, ["x", "y", "z"]);
		check(right, ["x", "y", "z"]);
		const l = compile(left);
		const r = compile(right);
		return { line: { kind: "implicit3", fn: (scope) => l(scope) - r(scope) } };
	}
}

export interface ResolvedPlot {
	lines: ResolvedLine[];
	/** The values of every definition, by name. */
	scope: Scope;
	/** Lines whose every point is an integral: drawn with fewer samples. */
	costly: Set<string>;
}

const COSTLY = /\bint\s*\(|∫/;

/** Understand every line, top to bottom. A definition is usable by the lines below and above it. */
export function resolvePlot(doc: Pick<PlotDoc, "lines"> & { mode?: PlotMode }): ResolvedPlot {
	const mode = doc.mode ?? "2d";
	const degrees = (doc as { angles?: unknown }).angles === "degrees";
	const scope: Scope = {};
	const defined = new Set<string>();
	// Function names first: f(…) must read as a call on every line, including
	// inside other functions' bodies and above the definition.
	const names = new Set<string>();
	const duplicates = new Set<string>();
	for (const line of doc.lines) {
		const header = functionHeader(line.text);
		if (!header) continue;
		if (names.has(header.name)) duplicates.add(line.id);
		else names.add(header.name);
	}
	const fns: FunctionContext = { names, table: {} };
	for (const line of doc.lines) {
		const header = functionHeader(line.text);
		if (!header || duplicates.has(line.id) || line.problem) continue;
		try {
			const tokens = tokenize(line.text.slice(0, MAX_LINE_CHARS));
			const sides = splitEquation(tokens);
			const body = sides ? parseTokens(sides.right, names) : [];
			if (body.length === 1 && body[0]!.type !== "tuple" && body[0]!.type !== "matrix") fns.table[header.name] = { params: header.params, body: body[0]! };
		} catch {
			// the line reports its own error when it is classified below
		}
	}
	// Definitions next, in order, so a curve may use a slider written below it.
	const drafts = new Map<string, Classified | { error: string; fix?: PlotMode }>();
	const tryClassify = (line: PlotLine): Classified | { error: string; fix?: PlotMode } => {
		if (line.problem) return { error: line.problem };
		if (duplicates.has(line.id)) return { error: `"${functionHeader(line.text)!.name}" is already defined above.` };
		try {
			return classify(line.text.slice(0, MAX_LINE_CHARS), defined, mode, degrees, fns);
		} catch (error) {
			if (error instanceof ModeError) return { error: error.message, fix: error.fix };
			return { error: error instanceof ExprError ? error.message : "This could not be read." };
		}
	};
	for (const line of doc.lines) {
		if (!DEFINITION_START.test(line.text) || functionHeader(line.text)) continue;
		const draft = tryClassify(line);
		if ("error" in draft || !draft.define) continue;
		const value = draft.define.fn(scope);
		scope[draft.define.name] = value;
		defined.add(draft.define.name);
		if (draft.line.kind === "definition") drafts.set(line.id, { line: { ...draft.line, value } });
	}
	const lines: ResolvedLine[] = doc.lines.map((line) => {
		const draft = drafts.get(line.id) ?? tryClassify(line);
		if ("error" in draft) return { id: line.id, kind: "error", error: draft.error, ...(draft.fix ? { fix: draft.fix } : {}) };
		if (draft.line.kind === "points") return { id: line.id, kind: "points", points: draft.line.fns.map(([x, y]) => [x(scope), y(scope)]) };
		if (draft.line.kind === "value") return { id: line.id, kind: "value", value: draft.line.fn(scope) };
		if (draft.line.kind === "points3") return { id: line.id, kind: "points3", points: draft.line.fns.map(([x, y, z]) => [x(scope), y(scope), z(scope)]) };
		if (draft.line.kind === "definition" && !drafts.has(line.id)) return { id: line.id, kind: "error", error: "This definition could not be used." };
		return { id: line.id, ...draft.line };
	});
	return { lines, scope, costly: new Set(doc.lines.filter((line) => COSTLY.test(line.text)).map((line) => line.id)) };
}

const fmt = (value: number) => (Number.isFinite(value) ? String(Math.round(value * 1e4) / 1e4) : String(value));

/** A calculation's answer: up to ten significant digits, scientific notation when very large or small. */
export function formatValue(value: number): string {
	if (Number.isNaN(value)) return "undefined";
	if (!Number.isFinite(value)) return value > 0 ? "∞" : "−∞";
	if (value === 0) return "0";
	const magnitude = Math.abs(value);
	if (magnitude >= 1e12 || magnitude < 1e-7) return value.toExponential(9).replace(/\.?0+e/, "e").replace("e+", "e");
	return String(Number(value.toPrecision(10)));
}

/** The parameter ranges curves use when the document sets none: a full turn, in the document's angle unit. */
export function parameterRanges(doc: PlotDoc): { t: [number, number]; u: [number, number]; v: [number, number] } {
	const turn = doc.angles === "degrees" ? 360 : 2 * Math.PI;
	return { t: [doc.tMin ?? 0, doc.tMax ?? turn], u: [doc.uMin ?? 0, doc.uMax ?? turn], v: [doc.vMin ?? 0, doc.vMax ?? turn] };
}

/** The line without what the editor remembered: its text now speaks for itself. */
export function withoutTypeset(line: PlotLine): PlotLine {
	const { latex: _latex, problem: _problem, ...rest } = line;
	return rest;
}

/** Replace a definition line's number (a dragged slider). */
export function withSliderValue(doc: PlotDoc, lineId: string, value: number): PlotDoc {
	return {
		...doc,
		// The typeset form is dropped: the editor re-typesets from the new text.
		lines: doc.lines.map((line) => (line.id === lineId ? { ...withoutTypeset(line), text: line.text.replace(/=.*$/, `= ${fmt(value)}`) } : line)),
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
			...(typeof line.latex === "string" && line.latex.length <= MAX_LINE_CHARS * 6 ? { latex: line.latex } : {}),
			color: Number.isInteger(line.color) ? Math.abs(line.color as number) % PLOT_COLORS.length : index % PLOT_COLORS.length,
			...(line.hidden === true ? { hidden: true } : {}),
			...(min !== undefined && max !== undefined && min < max ? { min, max } : {}),
		});
	}
	const view = cleanView(input.view);
	const tMin = typeof input.tMin === "number" && Number.isFinite(input.tMin) ? input.tMin : undefined;
	const tMax = typeof input.tMax === "number" && Number.isFinite(input.tMax) ? input.tMax : undefined;
	const range = (min: unknown, max: unknown) => (typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && min < max ? ([min, max] as const) : null);
	const u = range(input.uMin, input.uMax);
	const v = range(input.vMin, input.vMax);
	return {
		type: "plot",
		mode: input.mode === "3d" ? "3d" : "2d",
		...(input.angles === "degrees" ? { angles: "degrees" as const } : {}),
		...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim().slice(0, 120) } : {}),
		lines,
		view,
		...(tMin !== undefined && tMax !== undefined && tMin < tMax ? { tMin, tMax } : {}),
		...(input.mode === "3d" || input.box ? { box: cleanBox(input.box) } : {}),
		...(u ? { uMin: u[0], uMax: u[1] } : {}),
		...(v ? { vMin: v[0], vMax: v[1] } : {}),
	};
}

export function cleanBox(raw: unknown): PlotBox {
	const b = (raw ?? {}) as Partial<PlotBox>;
	const pair = (min: unknown, max: unknown, fallbackMin: number, fallbackMax: number): [number, number] =>
		typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && max - min > 1e-9 && max - min < 1e9 ? [min, max] : [fallbackMin, fallbackMax];
	const [xMin, xMax] = pair(b.xMin, b.xMax, DEFAULT_BOX.xMin, DEFAULT_BOX.xMax);
	const [yMin, yMax] = pair(b.yMin, b.yMax, DEFAULT_BOX.yMin, DEFAULT_BOX.yMax);
	const [zMin, zMax] = pair(b.zMin, b.zMax, DEFAULT_BOX.zMin, DEFAULT_BOX.zMax);
	return { xMin, xMax, yMin, yMax, zMin, zMax };
}

/** The document in the other mode: its lines are kept (each is re-read under
 *  the new mode's rules) and a 3D graph gets a box. */
export function withMode(doc: PlotDoc, mode: PlotMode): PlotDoc {
	if (doc.mode === mode) return doc;
	return { ...doc, mode, ...(mode === "3d" && !doc.box ? { box: { ...DEFAULT_BOX } } : {}) };
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
		if (meaning.kind === "value") notes.push(`= ${formatValue(meaning.value)}`);
		if (meaning.kind === "error") notes.push(`could not be read: ${meaning.error}`);
		if (line.hidden) notes.push("hidden");
		rows.push(`${rows.length + 1}. ${line.text.trim()}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
	}
	if (rows.length === 0) return "";
	if (doc.angles === "degrees") rows.unshift("Angles in degrees.");
	if (doc.mode === "3d") {
		const box = doc.box ?? DEFAULT_BOX;
		return ["3D graph.", ...rows, `Box: x from ${fmt(box.xMin)} to ${fmt(box.xMax)}, y from ${fmt(box.yMin)} to ${fmt(box.yMax)}, z from ${fmt(box.zMin)} to ${fmt(box.zMax)}`].join("\n");
	}
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

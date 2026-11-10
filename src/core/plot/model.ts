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
 * Linear algebra (phase 5d): `v = (2, 1)` names a vector, drawn as an arrow
 * from the origin (an unnamed `(2, 1)` stays a point), and `A = [[1, 2],
 * [3, 4]]` names a matrix. A line built from them (`u + v`, `A v`,
 * `det(A)`) is evaluated by linalg.ts: a vector is drawn, a number or a
 * matrix is shown as its value. `span(u, v)` draws what the vectors span.
 *
 * The visual tools (phase 5d-2) are lines too: `transform(A)` shows what a
 * matrix does, with a before/after slider whose position the line keeps
 * (`at`); `eigen(A)` draws eigenvector lines and lists eigenvalues. Where
 * the graph's straight lines (planes in 3D) meet is worked out for the
 * whole graph and marked (`ResolvedPlot.meet`).
 *
 * The document records its mode and each resolved line its kind, so new
 * kinds extend the format. The same line can mean different things in the
 * two modes: `x^2 + y^2 = 4` is a circle in 2D and a cylinder in 3D.
 */

import { compile as compileExpr, ExprError, isConstantName, parseTokens, splitEquation, tokenize, variablesOf, type Compiled, type Expr, type Scope, type UserFunction } from "./expr.ts";
import {
	det, eigen, evaluate, formatEntry, involvesLinear, isMatrix, solveSystem, spanBasis, withTranspose, type Eigenpair, type LinearEnv, type Matrix, type Value, type Vector,
} from "./linalg.ts";

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
	/** A transform line's slider: 0 is before, 1 (and absent) is after. */
	at?: number;
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
	/** A vector (phase 5d): an arrow from the origin when its size fits the graph. `literal` — the line
	 *  spells its numbers out, so its value need not be shown; `draggable` — its tip can be moved on a
	 *  2D graph; `guide` — for a sum, the first vector, from whose tip the second is drawn dashed. */
	| { id: string; kind: "vector"; name?: string; value: Vector; literal: boolean; draggable: boolean; guide?: { from: Vector } }
	| { id: string; kind: "matrix"; name?: string; value: Matrix; literal: boolean }
	/** What vectors span: `basis` is orthonormal (one vector: a line; two in 3D: a plane); `note` says it in words. */
	| { id: string; kind: "span"; basis: Vector[]; note: string }
	/** transform(A) (phase 5d-2): the grid, the unit square and the named vectors, moved `at` of the way from where they are to where A sends them. */
	| { id: string; kind: "transform"; matrix: Matrix; at: number; det: number }
	/** eigen(A): the real eigenvalues with their eigenvectors; `rows` says each in words. Drawn when the matrix's size fits the graph. */
	| { id: string; kind: "eigen"; pairs: Eigenpair[]; size: number; rows: string[] }
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
type Settled = DistributiveOmit<ResolvedLine, "id">;
type ValueOf = (scope: Scope) => Value;
/** A line of vectors and matrices, before its value is known: it may turn out a number, a vector or a matrix. */
interface LinearDraft {
	kind: "linear";
	name?: string;
	literal: boolean;
	value: ValueOf;
	/** The first operand of a top-level sum. */
	first?: ValueOf;
}
type Draft =
	| DistributiveOmit<Exclude<ResolvedLine, { kind: "points" | "points3" | "value" | "vector" | "matrix" | "span" | "transform" | "eigen" }>, "id">
	| { kind: "value"; fn: Compiled }
	| { kind: "points"; fns: [Compiled, Compiled][] }
	| { kind: "points3"; fns: [Compiled, Compiled, Compiled][] }
	| LinearDraft
	| { kind: "span-of"; vectors: ValueOf[] }
	| { kind: "transform-of"; matrix: ValueOf }
	| { kind: "eigen-of"; matrix: ValueOf };
type Classified = { line: Draft; define?: { name: string; value: ValueOf } };

/** The graph's own functions: the names (known before any body is parsed,
 *  so f(…) reads as a call everywhere) and the table bodies are compiled against. */
interface FunctionContext {
	names: ReadonlySet<string>;
	table: Record<string, UserFunction>;
	/** The graph's named vectors and matrices, filled as their definitions are evaluated. */
	values: Record<string, Value>;
	cache: WeakMap<object, Compiled>;
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
	const env: LinearEnv = { values: fns.values, options: { degrees, functions: fns.table }, cache: fns.cache };
	const linear = (expr: Expr) => involvesLinear(expr, (name) => Object.hasOwn(fns.values, name));
	// A number built from vectors (y = norm(v) x) is evaluated by linalg.ts; anything that is not a number there is undefined.
	const compile = (expr: Expr): Compiled => {
		if (!linear(expr)) return compileExpr(expr, env.options);
		return (scope) => {
			try {
				const value = evaluate(expr, scope, env);
				return typeof value === "number" ? value : NaN;
			} catch {
				return NaN;
			}
		};
	};
	const parse = (list: ReturnType<typeof tokenize>) => parseTokens(list, fns.names).map((expr) => withTranspose(expr, (name) => defined.has(name)));
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
		return { line: { kind: "definition", name, value: NaN, slider: right.type === "num" || (right.type === "neg" && right.arg.type === "num") }, define: { name, value: compile(right) } };
	};
	// Vectors and matrices. A line of them has no coordinate in it: it is one value, not a curve.
	const isConstant = (expr: Expr) => {
		const vars = variablesOf(expr);
		return !vars.has("x") && !vars.has("y") && !vars.has("z");
	};
	const isNumeral = (expr: Expr) => expr.type === "num" || (expr.type === "neg" && expr.arg.type === "num");
	const valueLine = (expr: Expr, name?: string): Draft => {
		check(expr, []);
		if (!name && expr.type === "call" && (expr.fn === "transform" || expr.fn === "eigen")) {
			const of = expr.args[0]!;
			const matrix = (scope: Scope) => evaluate(of, scope, env);
			return expr.fn === "transform" ? { kind: "transform-of", matrix } : { kind: "eigen-of", matrix };
		}
		if (!name && expr.type === "call" && expr.fn === "span") return { kind: "span-of", vectors: expr.args.map((arg) => (scope: Scope) => evaluate(arg, scope, env)) };
		const literal = (expr.type === "tuple" && expr.items.every(isNumeral)) || (expr.type === "matrix" && expr.rows.every((row) => row.every(isNumeral)));
		const sum = expr.type === "bin" && expr.op === "+" ? expr.left : null;
		return { kind: "linear", ...(name ? { name } : {}), literal, value: (scope) => evaluate(expr, scope, env), ...(sum ? { first: (scope: Scope) => evaluate(sum, scope, env) } : {}) };
	};
	/** v = (2, 1), A = [[1, 2], [3, 4]], w = u + v: a name for a vector, a matrix, or a number worked out from them.
	 *  In 3D u and v may be named too; while a surface is sampled its own u and v take over. */
	const valueDefinition = (leftList: Expr[], rightList: Expr[]): Classified | null => {
		const left = leftList.length === 1 ? leftList[0]! : null;
		const right = rightList.length === 1 ? rightList[0]! : null;
		if (left?.type !== "var" || !right || !(right.type === "tuple" || linear(right)) || !isConstant(right)) return null;
		const name = left.name;
		if ((RESERVED.has(name) && !(mode === "3d" && (name === "u" || name === "v"))) || isConstantName(name)) return null;
		if (defined.has(name)) throw new ExprError(`"${name}" is already defined above.`);
		const line = valueLine(right, name) as LinearDraft;
		return { line, define: { name, value: line.value } };
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
		if (list.length === 1 && list[0]!.type !== "tuple" && linear(list[0]!) && isConstant(list[0]!)) return { line: valueLine(list[0]!) };
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
	const leftList = parse(sides.left);
	const rightList = parse(sides.right);
	const named = valueDefinition(leftList, rightList);
	if (named) return named;
	const left = scalar(leftList);
	const right = scalar(rightList);
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
			if (list.length === 1 && list[0]!.type !== "tuple" && linear(list[0]!) && isConstant(list[0]!)) return { line: valueLine(list[0]!) };
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
		const leftList = parse(sides.left);
		const rightList = parse(sides.right);
		const named = valueDefinition(leftList, rightList);
		if (named) return named;
		const left = scalar(leftList);
		const right = scalar(rightList);
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
	/** Where the straight lines or planes meet, when the graph has two or more. */
	meet?: Meet;
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
	const fns: FunctionContext = { names, table: {}, values: {}, cache: new WeakMap() };
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
	// Definitions next, so a curve may use a slider written below it.
	const settled = new Map<string, Settled>();
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
	// Round after round until nothing more settles: a definition may use one written below it.
	const pending = doc.lines.filter((line) => DEFINITION_START.test(line.text) && !functionHeader(line.text));
	for (let progress = true; progress && pending.length > 0; ) {
		progress = false;
		for (const line of [...pending]) {
			const draft = tryClassify(line);
			if ("error" in draft || !draft.define) continue;
			let value: Value;
			try {
				value = draft.define.value(scope);
			} catch {
				continue; // the line reports its own error below
			}
			if (typeof value === "number") scope[draft.define.name] = value;
			else fns.values[draft.define.name] = value;
			defined.add(draft.define.name);
			if (draft.line.kind === "definition") settled.set(line.id, { ...draft.line, value: value as number });
			else if (draft.line.kind === "linear") settled.set(line.id, settleLinear(draft.line, value, scope, mode));
			pending.splice(pending.indexOf(line), 1);
			progress = true;
		}
	}
	const failure = (error: unknown): Settled => ({ kind: "error", error: error instanceof ExprError ? error.message : "This could not be read." });
	const lines: ResolvedLine[] = doc.lines.map((line) => {
		const done = settled.get(line.id);
		if (done) return { id: line.id, ...done };
		const draft = tryClassify(line);
		if ("error" in draft) return { id: line.id, kind: "error", error: draft.error, ...(draft.fix ? { fix: draft.fix } : {}) };
		if (draft.line.kind === "linear" || draft.line.kind === "span-of" || draft.line.kind === "transform-of" || draft.line.kind === "eigen-of") {
			try {
				if (draft.line.kind === "transform-of") return { id: line.id, ...settleTransform(draft.line.matrix(scope), mode, line.at) };
				if (draft.line.kind === "eigen-of") return { id: line.id, ...settleEigen(draft.line.matrix(scope)) };
				if (draft.line.kind === "span-of") return { id: line.id, ...settleSpan(draft.line.vectors.map((vector) => vector(scope)), mode) };
				const value = draft.line.value(scope);
				// A definition that reaches here never settled above.
				if (draft.define) return { id: line.id, kind: "error", error: "This definition could not be used." };
				return { id: line.id, ...settleLinear(draft.line, value, scope, mode) };
			} catch (error) {
				return { id: line.id, ...failure(error) };
			}
		}
		if (draft.line.kind === "points") return { id: line.id, kind: "points", points: draft.line.fns.map(([x, y]) => [x(scope), y(scope)]) };
		if (draft.line.kind === "value") return { id: line.id, kind: "value", value: draft.line.fn(scope) };
		if (draft.line.kind === "points3") return { id: line.id, kind: "points3", points: draft.line.fns.map(([x, y, z]) => [x(scope), y(scope), z(scope)]) };
		if (draft.line.kind === "definition") return { id: line.id, kind: "error", error: "This definition could not be used." };
		return { id: line.id, ...draft.line };
	});
	const meet = meetOf(lines, doc.lines, scope, mode);
	return { lines, scope, costly: new Set(doc.lines.filter((line) => COSTLY.test(line.text)).map((line) => line.id)), ...(meet ? { meet } : {}) };
}

/** Where the graph's straight lines (planes in 3D) meet. */
export interface Meet {
	/** Indexes into the document's lines of the equations involved. */
	lines: number[];
	result: { kind: "point"; at: Vector } | { kind: "line"; point: Vector; direction: Vector } | { kind: "none" };
}

/** a·x + b·y (+ c·z) = d for a line that is straight, read off its compiled form by sampling; null for a curve. */
function straightRow(line: ResolvedLine, scope: Scope, mode: PlotMode): { row: Vector; rhs: number } | null {
	const names = mode === "3d" ? (["x", "y", "z"] as const) : (["x", "y"] as const);
	let f: ((point: readonly number[]) => number) | null = null;
	const at = (fn: Compiled) => (point: readonly number[]) => {
		const local: Scope = Object.create(scope);
		names.forEach((name, i) => {
			local[name] = point[i]!;
		});
		return fn(local);
	};
	// Each kind as F(point) = 0.
	if ((mode === "2d" && line.kind === "implicit") || (mode === "3d" && line.kind === "implicit3")) f = at(line.fn);
	else if (mode === "2d" && (line.kind === "explicit-y" || line.kind === "explicit-x")) {
		const value = at(line.fn);
		const axis = line.kind === "explicit-y" ? 1 : 0;
		f = (point) => value(point) - point[axis]!;
	} else if (mode === "3d" && line.kind === "surface") {
		const value = at(line.fn);
		const axis = (names as readonly string[]).indexOf(line.axis);
		f = (point) => value(point) - point[axis]!;
	}
	if (!f) return null;
	const origin = names.map(() => 0);
	const constant = f(origin);
	const row = names.map((_, i) => f!(origin.map((_, j) => (i === j ? 1 : 0))) - constant);
	if (!Number.isFinite(constant) || row.some((x) => !Number.isFinite(x)) || row.every((x) => Math.abs(x) < 1e-12)) return null;
	// Straight means the same slope everywhere: check away from where it was measured.
	const size = Math.max(Math.abs(constant), ...row.map(Math.abs), 1);
	for (const point of [[2, 3, -1.5], [-1.5, 0.7, 4], [5, -4, 2.5], [-7.3, -2.1, -6]]) {
		const expected = constant + row.reduce((sum, x, i) => sum + x * point[i]!, 0);
		if (!(Math.abs(f(point.slice(0, names.length)) - expected) <= 1e-8 * size * 10)) return null;
	}
	return { row, rhs: -constant };
}

function meetOf(resolved: readonly ResolvedLine[], source: readonly PlotLine[], scope: Scope, mode: PlotMode): Meet | null {
	const rows: Vector[] = [];
	const rhs: number[] = [];
	const lines: number[] = [];
	resolved.forEach((line, index) => {
		const straight = source[index]!.hidden ? null : straightRow(line, scope, mode);
		if (!straight) return;
		rows.push(straight.row);
		rhs.push(straight.rhs);
		lines.push(index);
	});
	if (lines.length < 2) return null;
	const solution = solveSystem(rows, rhs);
	if (solution.kind === "point") return { lines, result: solution };
	// Two planes share a line; so may three. Lines in the plane that coincide meet nowhere in particular.
	if (solution.kind === "many" && mode === "3d" && solution.directions.length === 1) return { lines, result: { kind: "line", point: solution.point, direction: solution.directions[0]! } };
	return { lines, result: { kind: "none" } };
}

/** A vector's entries must match the graph for it to be drawn; one made for the other mode says so. */
function sizeProblem(size: number, mode: PlotMode, what: string): Settled | null {
	if (mode === "2d" && size === 3) return { kind: "error", error: `${what} with three entries needs a 3D graph.`, fix: "3d" };
	if (mode === "3d" && size === 2) return { kind: "error", error: `${what} with two entries belongs on a 2D graph.`, fix: "2d" };
	return null;
}

/** What a line of vectors and matrices turned out to be. */
function settleLinear(draft: LinearDraft, value: Value, scope: Scope, mode: PlotMode): Settled {
	const name = draft.name ? { name: draft.name } : {};
	if (typeof value === "number") return draft.name ? { kind: "definition", name: draft.name, value, slider: false } : { kind: "value", value };
	if (isMatrix(value)) return { kind: "matrix", ...name, value, literal: draft.literal };
	const problem = sizeProblem(value.length, mode, "A vector");
	if (problem) return problem;
	let guide: { from: Vector } | undefined;
	try {
		const first = draft.first?.(scope);
		if (first !== undefined && typeof first !== "number" && !isMatrix(first) && first.length === value.length) guide = { from: first };
	} catch {
		// no guide
	}
	return { kind: "vector", ...name, value, literal: draft.literal, draggable: draft.literal && draft.name !== undefined && mode === "2d" && value.length === 2, ...(guide ? { guide } : {}) };
}

function settleTransform(value: Value, mode: PlotMode, at: number | undefined): Settled {
	const size = mode === "3d" ? 3 : 2;
	if (typeof value === "number" || !isMatrix(value)) throw new ExprError("transform needs a matrix, such as transform(A).");
	if (value.length !== size || value[0]!.length !== size) {
		const other = mode === "3d" ? 2 : 3;
		const error = `On a ${mode.toUpperCase()} graph transform needs a ${size} × ${size} matrix; this one is ${value.length} × ${value[0]!.length}.`;
		return value.length === other && value[0]!.length === other ? { kind: "error", error, fix: mode === "3d" ? "2d" : "3d" } : { kind: "error", error };
	}
	return { kind: "transform", matrix: value, at: typeof at === "number" && at >= 0 && at <= 1 ? at : 1, det: det(value) };
}

/** The matrix a transform line shows at its slider's position: a straight blend from the identity to A. */
export function blendMatrix(matrix: Matrix, at: number): Matrix {
	return matrix.map((row, i) => row.map((x, j) => (1 - at) * (i === j ? 1 : 0) + at * x));
}

function settleEigen(value: Value): Settled {
	if (typeof value === "number" || !isMatrix(value)) throw new ExprError("eigen needs a matrix, such as eigen(A).");
	const pairs = eigen(value);
	const size = value.length;
	const rows = pairs.map(({ value: lambda, vectors }) => {
		const shown = vectors.map((vector) => formatResult(vector));
		const what = vectors.length === size ? "every vector" : vectors.length === 1 ? shown[0]! : `every vector in the plane of ${shown.join(" and ")}`;
		return `λ = ${formatEntry(lambda)}: ${what}`;
	});
	return { kind: "eigen", pairs, size, rows: rows.length > 0 ? rows : ["no real eigenvalues"] };
}

function settleSpan(values: Value[], mode: PlotMode): Settled {
	const vectors = values.filter((value): value is Vector => typeof value !== "number" && !isMatrix(value));
	if (vectors.length !== values.length) throw new ExprError("span needs vectors, such as span(u, v).");
	const size = vectors[0]!.length;
	if (vectors.some((vector) => vector.length !== size)) throw new ExprError("span needs vectors of the same size.");
	const problem = sizeProblem(size, mode, "A span of vectors");
	if (problem) return problem;
	if (size !== 2 && size !== 3) throw new ExprError("span is drawn for vectors with two or three entries.");
	const basis = spanBasis(vectors);
	const note = basis.length === 0 ? "only the origin" : basis.length === 1 ? "a line through the origin" : basis.length === size ? (size === 2 ? "the whole plane" : "all of 3D space") : "a plane through the origin";
	return { kind: "span", basis, note };
}

/** A result as text: -2, (3, 4), [[7, 10], [15, 22]]. */
export function formatResult(value: Value): string {
	if (typeof value === "number") return formatValue(value);
	if (isMatrix(value)) return `[${value.map((row) => `[${row.map(formatEntry).join(", ")}]`).join(", ")}]`;
	return `(${value.map(formatEntry).join(", ")})`;
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

/** Replace a named vector's numbers (its tip was dragged). */
export function withVectorValue(doc: PlotDoc, lineId: string, value: readonly number[]): PlotDoc {
	return {
		...doc,
		lines: doc.lines.map((line) => (line.id === lineId ? { ...withoutTypeset(line), text: line.text.replace(/=.*$/, `= (${value.map(formatEntry).join(", ")})`) } : line)),
	};
}

/** Move a transform line's before/after slider. */
export function withTransformAt(doc: PlotDoc, lineId: string, at: number): PlotDoc {
	const clamped = Math.max(0, Math.min(1, Math.round(at * 1000) / 1000));
	return { ...doc, lines: doc.lines.map((line) => (line.id === lineId ? { ...line, at: clamped } : line)) };
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
			...(typeof line.at === "number" && line.at >= 0 && line.at < 1 ? { at: line.at } : {}),
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
	/** Document line index → its number in the outline. */
	const numberOf = new Map<number, number>();
	for (const [index, line] of doc.lines.entries()) {
		if (!line.text.trim()) continue;
		numberOf.set(index, rows.length + 1);
		const meaning = resolved.lines[index]!;
		const notes: string[] = [];
		if (meaning.kind === "definition" && meaning.slider) notes.push(`slider, from ${fmt(line.min ?? DEFAULT_SLIDER.min)} to ${fmt(line.max ?? DEFAULT_SLIDER.max)}`);
		if (meaning.kind === "value" || (meaning.kind === "definition" && !meaning.slider)) notes.push(`= ${formatValue(meaning.value)}`);
		if ((meaning.kind === "vector" || meaning.kind === "matrix") && !meaning.literal) notes.push(`= ${formatResult(meaning.value)}`);
		if (meaning.kind === "span") notes.push(`= ${meaning.note}`);
		if (meaning.kind === "transform") notes.push(`slider at ${fmt(meaning.at)}, where 0 is before and 1 is after; det = ${formatValue(meaning.det)}`);
		if (meaning.kind === "eigen") notes.push(meaning.rows.join("; "));
		if (meaning.kind === "error") notes.push(`could not be read: ${meaning.error}`);
		if (line.hidden) notes.push("hidden");
		rows.push(`${rows.length + 1}. ${line.text.trim()}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
	}
	if (rows.length === 0) return "";
	if (resolved.meet) rows.push(meetSentence(resolved.meet, numberOf, doc.mode));
	if (doc.angles === "degrees") rows.unshift("Angles in degrees.");
	if (doc.mode === "3d") {
		const box = doc.box ?? DEFAULT_BOX;
		return ["3D graph.", ...rows, `Box: x from ${fmt(box.xMin)} to ${fmt(box.xMax)}, y from ${fmt(box.yMin)} to ${fmt(box.yMax)}, z from ${fmt(box.zMin)} to ${fmt(box.zMax)}`].join("\n");
	}
	const { xMin, xMax, yMin, yMax } = doc.view;
	return [...rows, `View: x from ${fmt(xMin)} to ${fmt(xMax)}, y from ${fmt(yMin)} to ${fmt(yMax)}`].join("\n");
}

/** "Lines 2 and 3 meet at (1.6667, 0.6667)." */
function meetSentence(meet: Meet, numberOf: ReadonlyMap<number, number>, mode: PlotMode): string {
	const numbers = meet.lines.map((index) => String(numberOf.get(index) ?? index + 1));
	const list = numbers.length === 2 ? numbers.join(" and ") : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
	const what = mode === "3d" ? "Planes" : "Lines";
	if (meet.result.kind === "point") return `${what} ${list} meet at ${formatResult(meet.result.at)}.`;
	if (meet.result.kind === "line") return `${what} ${list} meet in a line.`;
	return `${what} ${list} do not meet at one point.`;
}

/** The text block before a graph's picture in the tutor's input (wording
 *  approved by the owner, 2026-11-10). */
export function plotOutlineBlock(outline: string): string {
	return `The learner's graph, as they entered it. The picture shows the view they had when they sent it.\n\n${outline}`;
}

/** The paragraph the photo rule gains for graphs (approved the same day). */
export const PLOT_RULE =
	"A graph from the learner's grapher arrives with the expressions they entered. Judge those expressions and slider values; use the picture only to see the view they chose.";

/**
 * Vectors and matrices (fork, phase 5d — see FORK.md). The grapher's number
 * language (expr.ts) compiles an expression to one number; here the same
 * expression tree is evaluated to a value that may be a number, a vector or
 * a matrix, with the usual rules for which combinations are allowed:
 *
 *   u + v, u - v, 2u, u / 2    entry by entry
 *   u * v, u · v, dot(u, v)    the dot product
 *   u × v, cross(u, v)         the cross product (three entries each)
 *   A v, A B, A^2, A^-1, A^T   matrix products, powers, inverse, transpose
 *   norm(v), |v|               length
 *   det(A), trace(A), transpose(A), inv(A)
 *
 * A combination that makes no sense (u + A, a 2 × 2 matrix times a vector
 * with three entries) throws an ExprError worded for the learner. Pure.
 */

import {
	applyFunction, compile, constantValue, ExprError, isConstantName, isLinearFunction, power, type CompileOptions, type Compiled, type Expr, type Scope,
} from "./expr.ts";

export type Vector = number[];
/** Rows of entries. */
export type Matrix = number[][];
export type Value = number | Vector | Matrix;

export const isMatrix = (value: Value): value is Matrix => Array.isArray(value) && Array.isArray(value[0]);
export const isVector = (value: Value): value is Vector => Array.isArray(value) && !Array.isArray(value[0]);

/** What an expression is evaluated against, besides the numbers in scope. */
export interface LinearEnv {
	/** The graph's named vectors and matrices. */
	values: Readonly<Record<string, Value>>;
	options: CompileOptions;
	/** Sub-expressions handed to the number compiler (integrals, sums, f(x)), compiled once. */
	cache: WeakMap<object, Compiled>;
}

const describe = (value: Value): string =>
	typeof value === "number" ? "a number" : isMatrix(value) ? `a ${value.length} × ${value[0]!.length} matrix` : `a vector with ${value.length} ${value.length === 1 ? "entry" : "entries"}`;
const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);

export const dot = (a: Vector, b: Vector): number => a.reduce((sum, x, i) => sum + x * b[i]!, 0);
export const norm = (v: Vector): number => Math.sqrt(dot(v, v));
export const cross = (a: Vector, b: Vector): Vector => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
export const transpose = (m: Matrix): Matrix => m[0]!.map((_, column) => m.map((row) => row[column]!));
export const identity = (size: number): Matrix => Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)));
export const timesVector = (m: Matrix, v: Vector): Vector => m.map((row) => dot(row, v));
export function timesMatrix(a: Matrix, b: Matrix): Matrix {
	const columns = transpose(b);
	return a.map((row) => columns.map((column) => dot(row, column)));
}

/** Gauss–Jordan elimination with partial pivoting: the determinant, and the inverse when there is one. */
function eliminate(matrix: Matrix): { det: number; inverse: Matrix | null } {
	const n = matrix.length;
	const a = matrix.map((row, i) => [...row, ...identity(n)[i]!]);
	const scale = Math.max(...matrix.flat().map(Math.abs), 0);
	let det = 1;
	for (let column = 0; column < n; column++) {
		let pivot = column;
		for (let row = column + 1; row < n; row++) if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row;
		const value = a[pivot]![column]!;
		if (Number.isNaN(value)) return { det: NaN, inverse: null };
		// Relative to the matrix's size, so 1e-9 times a singular matrix is still singular.
		if (Math.abs(value) <= 1e-12 * scale || value === 0) return { det: 0, inverse: null };
		if (pivot !== column) {
			[a[pivot], a[column]] = [a[column]!, a[pivot]!];
			det = -det;
		}
		det *= value;
		for (let j = 0; j < 2 * n; j++) a[column]![j]! /= value;
		for (let row = 0; row < n; row++) {
			const factor = a[row]![column]!;
			if (row === column || factor === 0) continue;
			for (let j = 0; j < 2 * n; j++) a[row]![j]! -= factor * a[column]![j]!;
		}
	}
	return { det, inverse: a.map((row) => row.slice(n)) };
}

const isSquare = (m: Matrix) => m.length === m[0]!.length;

export function det(m: Matrix): number {
	if (!isSquare(m)) throw new ExprError(`det needs a square matrix; this one is ${m.length} × ${m[0]!.length}.`);
	return eliminate(m).det;
}

export function inverse(m: Matrix): Matrix {
	if (!isSquare(m)) throw new ExprError(`Only a square matrix has an inverse; this one is ${m.length} × ${m[0]!.length}.`);
	const result = eliminate(m).inverse;
	if (!result) throw new ExprError("This matrix has no inverse: its determinant is 0.");
	return result;
}

const MAX_MATRIX_POWER = 1000;

function matrixPower(m: Matrix, exponent: number): Matrix {
	if (!isSquare(m)) throw new ExprError("Only a square matrix can be raised to a power.");
	if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_MATRIX_POWER) throw new ExprError("A matrix power must be a whole number.");
	let base = exponent < 0 ? inverse(m) : m;
	let result = identity(m.length);
	// Repeated squaring.
	for (let n = Math.abs(exponent); n > 0; n = Math.floor(n / 2)) {
		if (n % 2 === 1) result = timesMatrix(result, base);
		base = timesMatrix(base, base);
	}
	return result;
}

/** An orthonormal basis of what the vectors span (Gram–Schmidt); its length is the dimension. */
export function spanBasis(vectors: readonly Vector[]): Vector[] {
	const scale = Math.max(...vectors.map(norm).filter(Number.isFinite), 1);
	const basis: Vector[] = [];
	for (const vector of vectors) {
		let rest = [...vector];
		for (const b of basis) {
			const along = dot(rest, b);
			rest = rest.map((x, i) => x - along * b[i]!);
		}
		const length = norm(rest);
		if (length > 1e-9 * scale) basis.push(rest.map((x) => x / length));
	}
	return basis;
}

function sameShape(a: Value, b: Value): boolean {
	if (typeof a === "number" || typeof b === "number") return typeof a === typeof b;
	if (isMatrix(a) !== isMatrix(b) || a.length !== b.length) return false;
	return !isMatrix(a) || a[0]!.length === (b as Matrix)[0]!.length;
}

/** Apply a number operation to every entry. */
function each(value: Value, fn: (x: number) => number): Value {
	if (typeof value === "number") return fn(value);
	return isMatrix(value) ? value.map((row) => row.map(fn)) : value.map(fn);
}
function pairwise(a: Value, b: Value, fn: (x: number, y: number) => number): Value {
	if (typeof a === "number") return fn(a, b as number);
	if (isMatrix(a)) return a.map((row, i) => row.map((x, j) => fn(x, (b as Matrix)[i]![j]!)));
	return a.map((x, i) => fn(x, (b as Vector)[i]!));
}

function multiply(a: Value, b: Value, isCross: boolean): Value {
	if (typeof a === "number") return each(b, (x) => a * x);
	if (typeof b === "number") return each(a, (x) => x * b);
	if (isVector(a) && isVector(b)) {
		if (isCross) {
			if (a.length !== 3 || b.length !== 3) throw new ExprError("The cross product needs two vectors with three entries each.");
			return cross(a, b);
		}
		if (a.length !== b.length) throw new ExprError(`The dot product needs two vectors of the same size; these have ${a.length} and ${b.length} entries.`);
		return dot(a, b);
	}
	if (isCross) throw new ExprError("× between a matrix and something else is not a product the grapher knows; write them side by side, as in A v.");
	if (isMatrix(a) && isVector(b)) {
		if (a[0]!.length !== b.length) throw new ExprError(`${capital(describe(a))} needs a vector with ${a[0]!.length} entries; this one has ${b.length}.`);
		return timesVector(a, b);
	}
	if (isMatrix(a) && isMatrix(b)) {
		if (a[0]!.length !== b.length) throw new ExprError(`These matrices cannot be multiplied: the first has ${a[0]!.length} columns and the second has ${b.length} rows.`);
		return timesMatrix(a, b);
	}
	throw new ExprError("Write the matrix first and the vector after it, as in A v.");
}

const numberOf = (value: Value, what: string): number => {
	if (typeof value !== "number") throw new ExprError(`${what} must be a number, not ${describe(value)}.`);
	return value;
};
const vectorOf = (value: Value, fn: string): Vector => {
	if (!isVector(value)) throw new ExprError(`${fn} needs a vector, not ${describe(value)}.`);
	return value;
};
const matrixOf = (value: Value, fn: string): Matrix => {
	if (!isMatrix(value)) throw new ExprError(`${fn} needs a matrix, not ${describe(value)}.`);
	return value;
};

function linearCall(fn: string, args: Value[]): Value {
	switch (fn) {
		case "dot": {
			const [a, b] = [vectorOf(args[0]!, "dot"), vectorOf(args[1]!, "dot")];
			return multiply(a, b, false);
		}
		case "cross":
			return multiply(vectorOf(args[0]!, "cross"), vectorOf(args[1]!, "cross"), true);
		case "norm":
			return typeof args[0] === "number" ? Math.abs(args[0]) : norm(vectorOf(args[0]!, "norm"));
		case "det":
			return det(matrixOf(args[0]!, "det"));
		case "trace": {
			const m = matrixOf(args[0]!, "trace");
			if (!isSquare(m)) throw new ExprError(`trace needs a square matrix; this one is ${m.length} × ${m[0]!.length}.`);
			return m.reduce((sum, row, i) => sum + row[i]!, 0);
		}
		case "transpose":
			// A vector has no rows or columns here, so its transpose is itself: v^T v is the dot product.
			return isVector(args[0]!) ? args[0]! : transpose(matrixOf(args[0]!, "transpose"));
		case "inv":
			return typeof args[0] === "number" ? 1 / args[0] : inverse(matrixOf(args[0]!, "inv"));
		default:
			throw new ExprError("span(…) goes on a line of its own.");
	}
}

/** The value of an expression: a number, a vector or a matrix. Throws an ExprError where the shapes do not fit. */
export function evaluate(expr: Expr, scope: Scope, env: LinearEnv): Value {
	const value = (inner: Expr) => evaluate(inner, scope, env);
	switch (expr.type) {
		case "num":
			return expr.value;
		case "var": {
			if (isConstantName(expr.name)) return constantValue(expr.name);
			// A number in scope wins: u and v are a surface's parameters while it is being sampled.
			const number = scope[expr.name];
			if (number !== undefined) return number;
			return Object.hasOwn(env.values, expr.name) ? env.values[expr.name]! : NaN;
		}
		case "neg":
			return each(value(expr.arg), (x) => -x);
		case "tuple":
			return expr.items.map((item) => numberOf(value(item), "Each entry of a vector"));
		case "matrix": {
			const rows = expr.rows.map((row) => row.map((cell) => numberOf(value(cell), "Each entry of a matrix")));
			// [1, 2, 3] and a single column are vectors: that is how they are used.
			if (rows.length === 1) return rows[0]!;
			if (rows[0]!.length === 1) return rows.map((row) => row[0]!);
			return rows;
		}
		case "bin": {
			const left = value(expr.left);
			const right = value(expr.right);
			switch (expr.op) {
				case "+":
				case "-": {
					if (!sameShape(left, right)) throw new ExprError(`${capital(describe(left))} and ${describe(right)} cannot be ${expr.op === "+" ? "added" : "subtracted"}.`);
					return pairwise(left, right, expr.op === "+" ? (x, y) => x + y : (x, y) => x - y);
				}
				case "*":
					return multiply(left, right, expr.cross === true);
				case "/": {
					if (typeof right !== "number") throw new ExprError(`You cannot divide by ${describe(right)}.`);
					return each(left, (x) => x / right);
				}
				case "^": {
					if (typeof left === "number") return power(left, numberOf(right, "A power"));
					if (isMatrix(left)) return matrixPower(left, numberOf(right, "A matrix power"));
					throw new ExprError("A vector cannot be raised to a power; use dot(v, v) for its length squared.");
				}
			}
		}
		// falls through: every operator returned above
		case "call": {
			const args = expr.args.map(value);
			if (isLinearFunction(expr.fn)) return linearCall(expr.fn, args);
			// |v| is the length of v.
			if (expr.fn === "abs" && isVector(args[0]!)) return norm(args[0]);
			if (expr.fn === "abs" && isMatrix(args[0]!)) throw new ExprError("For a matrix, write det(A) for its determinant.");
			return applyFunction(expr.fn, args.map((arg) => numberOf(arg, `What ${expr.fn} applies to`)), env.options.degrees);
		}
		case "binder":
		case "apply": {
			// Integrals, sums and the graph's own functions work on numbers.
			let compiled = env.cache.get(expr);
			if (!compiled) env.cache.set(expr, (compiled = compile(expr, env.options)));
			return compiled(scope);
		}
	}
}

/** Whether an expression needs this evaluator: it names a vector or matrix, builds one, or calls one of their functions. */
export function involvesLinear(expr: Expr, isValueName: (name: string) => boolean): boolean {
	const any = (inner: Expr) => involvesLinear(inner, isValueName);
	switch (expr.type) {
		case "num":
			return false;
		case "var":
			return isValueName(expr.name);
		case "neg":
			return any(expr.arg);
		case "bin":
			return any(expr.left) || any(expr.right);
		case "call":
			return isLinearFunction(expr.fn) || expr.args.some(any);
		case "tuple":
		case "matrix":
			return true;
		case "binder":
		case "apply":
			return false;
	}
}

/** A^T as transpose(A), wherever T is not a name the graph defines. */
export function withTranspose(expr: Expr, isDefined: (name: string) => boolean): Expr {
	const walk = (inner: Expr): Expr => withTranspose(inner, isDefined);
	switch (expr.type) {
		case "num":
		case "var":
			return expr;
		case "neg":
			return { ...expr, arg: walk(expr.arg) };
		case "bin":
			if (expr.op === "^" && expr.right.type === "var" && expr.right.name === "T" && !isDefined("T")) return { type: "call", fn: "transpose", args: [walk(expr.left)] };
			return { ...expr, left: walk(expr.left), right: walk(expr.right) };
		case "call":
			return { ...expr, args: expr.args.map(walk) };
		case "tuple":
			return { ...expr, items: expr.items.map(walk) };
		case "matrix":
			return { ...expr, rows: expr.rows.map((row) => row.map(walk)) };
		case "binder":
			return { ...expr, body: walk(expr.body), ...(expr.lower && expr.upper ? { lower: walk(expr.lower), upper: walk(expr.upper) } : {}) };
		case "apply":
			return { ...expr, args: expr.args.map(walk) };
	}
}

/** One entry of a result: four decimal places, and never "-0". */
export function formatEntry(value: number): string {
	if (Number.isNaN(value)) return "undefined";
	if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
	const rounded = Math.round(value * 1e4) / 1e4;
	return String(rounded === 0 ? 0 : rounded);
}

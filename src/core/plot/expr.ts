/**
 * The grapher's expression language (fork, phase 5b — see FORK.md): a small
 * parser and evaluator, written here so the tutor's `graph` tool, the
 * learner's grapher and the outline sent back to the tutor all read
 * expressions with exactly the same rules. Pure; no dependency.
 *
 *   2x, x(x+1), ax^2      implicit multiplication (each letter is a variable
 *                         unless it spells a known function or constant)
 *   sin x, sin 2x         a function applies to the product that follows it
 *   -x^2                  is -(x^2); ^ is right-associative
 *   |x|                   absolute value
 *   5!, x!                factorial, smooth between whole numbers (gamma)
 *   α, β, λ …             Greek letters are variables like any other letter
 *   int(x^2, x, 0, 1)     a definite integral; likewise deriv(x^3, x),
 *                         sum(n^2, n, 1, 10) and prod(k, k, 1, 5) — the
 *                         second argument is a variable bound inside the first
 *   f(2), f(x - 1), f'(x) a call to a function the graph defines (f(x) = …);
 *                         only letters the caller names as functions are read so
 *   (1, 2), [[1,2],[3,4]] tuples and matrices: points, vectors and matrices.
 *                         Their arithmetic (u + v, A v, det(A), u × v) is
 *                         evaluated by core/plot/linalg.ts (phase 5d); this
 *                         file only parses it. × between two vectors is the
 *                         cross product, so the parser keeps it apart from *.
 */

export type Expr =
	| { type: "num"; value: number }
	| { type: "var"; name: string }
	| { type: "call"; fn: string; args: Expr[] }
	/** `cross` marks a product written with ×: the cross product between vectors, plain multiplication between numbers. */
	| { type: "bin"; op: "+" | "-" | "*" | "/" | "^"; left: Expr; right: Expr; cross?: true }
	| { type: "neg"; arg: Expr }
	/** int / deriv / sum / prod: `variable` is bound inside `body`. Limits are absent for deriv. */
	| { type: "binder"; op: BinderOp; body: Expr; variable: string; lower?: Expr; upper?: Expr }
	/** A call to a user-defined function; `primes` derivatives are taken first (f''(x) → 2). */
	| { type: "apply"; name: string; args: Expr[]; primes: number }
	| { type: "tuple"; items: Expr[] }
	| { type: "matrix"; rows: Expr[][] };

export type BinderOp = "int" | "deriv" | "sum" | "prod";
const BINDERS: readonly BinderOp[] = ["int", "deriv", "sum", "prod"];
export const isBinderName = (name: string): name is BinderOp => (BINDERS as readonly string[]).includes(name);

export class ExprError extends Error {}

/** Γ(x), by the Lanczos approximation; exact enough for graphing and for 10-digit answers. */
export function gamma(x: number): number {
	if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
	const g = 7;
	const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
	const y = x - 1;
	let sum = c[0]!;
	for (let i = 1; i < g + 2; i++) sum += c[i]! / (y + i);
	const t = y + g + 0.5;
	return Math.sqrt(2 * Math.PI) * Math.pow(t, y + 0.5) * Math.exp(-t) * sum;
}

/** n!, exact for whole numbers up to 170 and gamma(n + 1) in between; undefined at negative whole numbers. */
export function factorial(n: number): number {
	if (Number.isInteger(n)) {
		if (n < 0) return NaN;
		if (n > 170) return Infinity;
		let out = 1;
		for (let i = 2; i <= n; i++) out *= i;
		return out;
	}
	return gamma(n + 1);
}

function gcd(a: number, b: number): number {
	if (!Number.isInteger(a) || !Number.isInteger(b)) return NaN;
	let [x, y] = [Math.abs(a), Math.abs(b)];
	while (y !== 0) [x, y] = [y, x % y];
	return x;
}
const wholeAndOrdered = (n: number, r: number) => Number.isInteger(n) && Number.isInteger(r) && r >= 0 && n >= r;

const FUNCTIONS: Record<string, { arity: number | [number, number]; fn: (...args: number[]) => number; angle?: "in" | "out" }> = {
	sqrt: { arity: 1, fn: Math.sqrt },
	cbrt: { arity: 1, fn: Math.cbrt },
	abs: { arity: 1, fn: Math.abs },
	// `angle: "in"` functions take an angle; "out" functions return one —
	// what the degrees setting converts.
	sin: { arity: 1, fn: Math.sin, angle: "in" },
	cos: { arity: 1, fn: Math.cos, angle: "in" },
	tan: { arity: 1, fn: Math.tan, angle: "in" },
	sec: { arity: 1, fn: (x) => 1 / Math.cos(x), angle: "in" },
	csc: { arity: 1, fn: (x) => 1 / Math.sin(x), angle: "in" },
	cot: { arity: 1, fn: (x) => Math.cos(x) / Math.sin(x), angle: "in" },
	asin: { arity: 1, fn: Math.asin, angle: "out" },
	acos: { arity: 1, fn: Math.acos, angle: "out" },
	atan: { arity: 1, fn: Math.atan, angle: "out" },
	asec: { arity: 1, fn: (x) => Math.acos(1 / x), angle: "out" },
	acsc: { arity: 1, fn: (x) => Math.asin(1 / x), angle: "out" },
	acot: { arity: 1, fn: (x) => Math.PI / 2 - Math.atan(x), angle: "out" },
	arcsin: { arity: 1, fn: Math.asin, angle: "out" },
	arccos: { arity: 1, fn: Math.acos, angle: "out" },
	arctan: { arity: 1, fn: Math.atan, angle: "out" },
	sinh: { arity: 1, fn: Math.sinh },
	cosh: { arity: 1, fn: Math.cosh },
	tanh: { arity: 1, fn: Math.tanh },
	asinh: { arity: 1, fn: Math.asinh },
	acosh: { arity: 1, fn: Math.acosh },
	atanh: { arity: 1, fn: Math.atanh },
	ln: { arity: 1, fn: Math.log },
	// log(x) is base 10; log(x, b) is base b.
	log: { arity: [1, 2], fn: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)) },
	// root(x, n): the nth root, real for odd n of a negative x.
	root: { arity: 2, fn: (x, n) => power(x, 1 / n) },
	factorial: { arity: 1, fn: factorial },
	gamma: { arity: 1, fn: gamma },
	ncr: { arity: 2, fn: (n, r) => (wholeAndOrdered(n, r) ? Math.round(factorial(n) / (factorial(r) * factorial(n - r))) : NaN) },
	npr: { arity: 2, fn: (n, r) => (wholeAndOrdered(n, r) ? Math.round(factorial(n) / factorial(n - r)) : NaN) },
	// mod takes the sign of the divisor, as in mathematics: mod(-1, 3) is 2.
	mod: { arity: 2, fn: (a, b) => a - b * Math.floor(a / b) },
	gcd: { arity: 2, fn: gcd },
	lcm: { arity: 2, fn: (a, b) => (gcd(a, b) > 0 ? Math.abs(a * b) / gcd(a, b) : a === 0 || b === 0 ? 0 : NaN) },
	exp: { arity: 1, fn: Math.exp },
	floor: { arity: 1, fn: Math.floor },
	ceil: { arity: 1, fn: Math.ceil },
	round: { arity: 1, fn: Math.round },
	sign: { arity: 1, fn: Math.sign },
	min: { arity: [1, 8], fn: Math.min },
	max: { arity: [1, 8], fn: Math.max },
};
/** Functions of vectors and matrices (phase 5d), by how many values each takes. Evaluated in linalg.ts. */
const LINEAR_FUNCTIONS: Record<string, number | [number, number]> = { dot: 2, cross: 2, norm: 1, det: 1, trace: 1, transpose: 1, inv: 1, span: [1, 3], solve: 2, transform: 1, eigen: 1 };
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const DEG = Math.PI / 180;
/** Multi-letter names that are variables, not products of letters. */
const NAMED_VARIABLES = ["theta"];
const WORDS = [...Object.keys(FUNCTIONS), ...Object.keys(LINEAR_FUNCTIONS), ...BINDERS, ...Object.keys(CONSTANTS), ...NAMED_VARIABLES].sort((a, b) => b.length - a.length);

export const isLinearFunction = (name: string) => Object.hasOwn(LINEAR_FUNCTIONS, name);
export const isFunctionName = (name: string) => Object.hasOwn(FUNCTIONS, name) || isLinearFunction(name);
export const isConstantName = (name: string) => Object.hasOwn(CONSTANTS, name);
export const constantValue = (name: string): number => CONSTANTS[name] ?? NaN;

/** One of the number functions applied to numbers (what the vector evaluator calls for sin, sqrt and the rest). */
export function applyFunction(name: string, args: number[], degrees = false): number {
	const spec = FUNCTIONS[name];
	if (!spec) return NaN;
	if (!degrees || !spec.angle) return spec.fn(...args);
	return spec.angle === "in" ? spec.fn(args[0]! * DEG) : spec.fn(...args) / DEG;
}

type Token =
	| { kind: "num"; value: number }
	| { kind: "name"; name: string }
	| { kind: "op"; op: string };

const SYMBOLS: Record<string, string> = {
	"·": "*", "⋅": "*", "÷": "/", "−": "-", "–": "-", "π": "pi", "θ": "theta", "√": "sqrt",
	"∫": "int", "Σ": "sum", "∑": "sum", "Π": "prod", "∏": "prod", "′": "'", "’": "'",
};

export function tokenize(source: string): Token[] {
	const text = [...source].map((ch) => SYMBOLS[ch] ?? ch).join("");
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(i));
		// "2e" is 2·e, not a broken exponent: the exponent part needs its digits (the regex demands them).
		if (number) {
			tokens.push({ kind: "num", value: Number(number[0]) });
			i += number[0].length;
			continue;
		}
		// Greek letters are variables (π and θ were already mapped to their names).
		if (/[α-ωΑ-Ω]/.test(ch)) {
			tokens.push({ kind: "name", name: ch });
			i++;
			continue;
		}
		if (/[A-Za-z]/.test(ch)) {
			const rest = text.slice(i).toLowerCase();
			const word = WORDS.find((w) => rest.startsWith(w));
			// A known word wins only where it starts; otherwise one letter is one variable.
			// A capital E is a name (a matrix, say), not the constant e.
			if (word && !(word === "e" && ch === "E")) {
				tokens.push({ kind: "name", name: word });
				i += word.length;
			} else {
				tokens.push({ kind: "name", name: ch });
				i++;
			}
			continue;
		}
		if ("+-*/^(),|[]=<>!'×".includes(ch)) {
			tokens.push({ kind: "op", op: ch });
			i++;
			continue;
		}
		throw new ExprError(`"${ch}" is not something the grapher understands.`);
	}
	return tokens;
}

class Parser {
	private at = 0;
	/** Depth of open |…| pairs: inside one, a bar closes it rather than opening another. */
	private bars = 0;
	constructor(
		private readonly tokens: Token[],
		/** Letters the graph defines as functions: f(…) is then a call, not f times (…). */
		private readonly functions: ReadonlySet<string> = new Set(),
	) {}

	private peek(): Token | undefined {
		return this.tokens[this.at];
	}
	private isOp(op: string): boolean {
		const token = this.peek();
		return token?.kind === "op" && token.op === op;
	}
	private eat(op: string): boolean {
		if (!this.isOp(op)) return false;
		this.at++;
		return true;
	}
	private expect(op: string): void {
		if (!this.eat(op)) throw new ExprError(`Expected "${op}".`);
	}
	done(): boolean {
		return this.at >= this.tokens.length;
	}

	/** A comma-separated list of expressions, to the end of the input. */
	list(): Expr[] {
		const out = [this.expression()];
		while (this.eat(",")) out.push(this.expression());
		if (!this.done()) throw new ExprError("That expression has something extra at the end.");
		return out;
	}

	/** expr := term (("+" | "-") term)* */
	expression(): Expr {
		let left = this.term();
		for (;;) {
			if (this.eat("+")) left = { type: "bin", op: "+", left, right: this.term() };
			else if (this.eat("-")) left = { type: "bin", op: "-", left, right: this.term() };
			else return left;
		}
	}

	/** term := unary (("*" | "/") unary | <juxtaposed factor>)* */
	private term(): Expr {
		let left = this.unary();
		for (;;) {
			if (this.eat("*")) left = { type: "bin", op: "*", left, right: this.unary() };
			else if (this.eat("/")) left = { type: "bin", op: "/", left, right: this.unary() };
			else if (this.eat("×")) left = { type: "bin", op: "*", left, right: this.unary(), cross: true };
			else if (this.startsFactor()) left = { type: "bin", op: "*", left, right: this.power() };
			else return left;
		}
	}

	/** Whether the next token can begin a factor written right after another (2x, x(x+1)). */
	private startsFactor(): boolean {
		const token = this.peek();
		if (!token) return false;
		if (token.kind === "num" || token.kind === "name") return true;
		return token.op === "(" || token.op === "[" || (token.op === "|" && this.bars === 0);
	}

	private unary(): Expr {
		if (this.eat("-")) return { type: "neg", arg: this.unary() };
		if (this.eat("+")) return this.unary();
		return this.power();
	}

	/** atom with any trailing "!" — 5!, (n+1)!, x!!. */
	private postfix(): Expr {
		let expr = this.atom();
		while (this.eat("!")) expr = { type: "call", fn: "factorial", args: [expr] };
		return expr;
	}

	/** power := postfix ("^" unary)?  — right-associative, and -x^2 is -(x^2). */
	private power(): Expr {
		const base = this.postfix();
		if (this.eat("^")) return { type: "bin", op: "^", left: base, right: this.unary() };
		return base;
	}

	private atom(): Expr {
		const token = this.peek();
		if (!token) throw new ExprError("The expression ends too soon.");
		if (token.kind === "num") {
			this.at++;
			return { type: "num", value: token.value };
		}
		if (token.kind === "name") {
			this.at++;
			if (isBinderName(token.name)) return this.binder(token.name);
			if (isFunctionName(token.name)) return this.call(token.name);
			if (this.functions.has(token.name)) {
				let primes = 0;
				while (this.eat("'")) primes++;
				if (this.eat("(")) {
					const saved = this.bars;
					this.bars = 0;
					const args = [this.expression()];
					while (this.eat(",")) args.push(this.expression());
					this.expect(")");
					this.bars = saved;
					return { type: "apply", name: token.name, args, primes };
				}
				throw new ExprError(`${token.name} is a function: write ${token.name}(…).`);
			}
			return { type: "var", name: token.name };
		}
		if (this.eat("(")) {
			const saved = this.bars;
			this.bars = 0;
			const items = [this.expression()];
			while (this.eat(",")) items.push(this.expression());
			this.expect(")");
			this.bars = saved;
			return items.length === 1 ? items[0]! : { type: "tuple", items };
		}
		if (this.eat("[")) return this.matrix();
		if (this.isOp("|") && this.bars === 0) {
			this.at++;
			this.bars++;
			const inner = this.expression();
			this.bars--;
			this.expect("|");
			return { type: "call", fn: "abs", args: [inner] };
		}
		throw new ExprError(`Unexpected "${token.op}".`);
	}

	/** int(body, var, from, to) and its kin: the second argument names the bound variable. */
	private binder(op: BinderOp): Expr {
		const shape = op === "deriv" ? `${op}(expression, variable)` : `${op}(expression, variable, from, to)`;
		this.expect("(");
		const saved = this.bars;
		this.bars = 0;
		const body = this.expression();
		this.expect(",");
		const name = this.peek();
		if (name?.kind !== "name" || isFunctionName(name.name) || isBinderName(name.name) || isConstantName(name.name)) throw new ExprError(`Write ${shape}.`);
		this.at++;
		let lower: Expr | undefined;
		let upper: Expr | undefined;
		if (op !== "deriv") {
			this.expect(",");
			lower = this.expression();
			this.expect(",");
			upper = this.expression();
		}
		if (!this.eat(")")) throw new ExprError(`Write ${shape}.`);
		this.bars = saved;
		return { type: "binder", op, body, variable: name.name, ...(lower && upper ? { lower, upper } : {}) };
	}

	/** f(a, b) — or, without parentheses, f applied to the product that follows (sin 2x). */
	private call(fn: string): Expr {
		let args: Expr[];
		if (this.eat("(")) {
			const saved = this.bars;
			this.bars = 0;
			args = [this.expression()];
			while (this.eat(",")) args.push(this.expression());
			this.expect(")");
			this.bars = saved;
		} else {
			if (!this.startsFactor()) throw new ExprError(`${fn} needs something to apply to.`);
			let product = this.power();
			while (this.startsFactor() && !(this.peek()?.kind === "name" && (isFunctionName((this.peek() as { name: string }).name) || isBinderName((this.peek() as { name: string }).name)))) {
				product = { type: "bin", op: "*", left: product, right: this.power() };
			}
			args = [product];
		}
		const arity = LINEAR_FUNCTIONS[fn] ?? FUNCTIONS[fn]!.arity;
		const [min, max] = typeof arity === "number" ? [arity, arity] : arity;
		if (args.length < min || args.length > max) throw new ExprError(`${fn} takes ${min === max ? min : `${min} to ${max}`} ${max === 1 ? "value" : "values"}.`);
		return { type: "call", fn, args };
	}

	/** [1, 2, 3] is one row; [[1, 2], [3, 4]] is rows. */
	private matrix(): Expr {
		const rows: Expr[][] = [];
		if (this.isOp("[")) {
			do {
				this.expect("[");
				const row = [this.expression()];
				while (this.eat(",")) row.push(this.expression());
				this.expect("]");
				rows.push(row);
			} while (this.eat(","));
		} else {
			const row = [this.expression()];
			while (this.eat(",")) row.push(this.expression());
			rows.push(row);
		}
		this.expect("]");
		if (rows.some((row) => row.length !== rows[0]!.length)) throw new ExprError("Every row of a matrix needs the same number of entries.");
		return { type: "matrix", rows };
	}
}

/** Parse one side of an expression line. A top-level comma list becomes a tuple list. */
export function parseTokens(tokens: Token[], functions?: ReadonlySet<string>): Expr[] {
	if (tokens.length === 0) throw new ExprError("Nothing to graph.");
	return new Parser(tokens, functions).list();
}

export function parseExpr(source: string, functions?: ReadonlySet<string>): Expr {
	const all = parseTokens(tokenize(source), functions);
	if (all.length !== 1) throw new ExprError("Expected one expression, not a list.");
	return all[0]!;
}

/** The variable names an expression uses (constants excluded). */
export function variablesOf(expr: Expr, into = new Set<string>()): Set<string> {
	switch (expr.type) {
		case "num":
			break;
		case "var":
			if (!isConstantName(expr.name)) into.add(expr.name);
			break;
		case "call":
			for (const arg of expr.args) variablesOf(arg, into);
			break;
		case "bin":
			variablesOf(expr.left, into);
			variablesOf(expr.right, into);
			break;
		case "neg":
			variablesOf(expr.arg, into);
			break;
		case "binder": {
			// The bound variable is free only if something outside the body also uses it.
			const inner = variablesOf(expr.body);
			inner.delete(expr.variable);
			for (const name of inner) into.add(name);
			if (expr.lower) variablesOf(expr.lower, into);
			if (expr.upper) variablesOf(expr.upper, into);
			// deriv(x^3, x) is evaluated AT the current x, so x stays free.
			if (expr.op === "deriv") into.add(expr.variable);
			break;
		}
		case "apply":
			for (const arg of expr.args) variablesOf(arg, into);
			break;
		case "tuple":
			for (const item of expr.items) variablesOf(item, into);
			break;
		case "matrix":
			for (const row of expr.rows) for (const cell of row) variablesOf(cell, into);
			break;
	}
	return into;
}

export type Scope = Record<string, number>;
export type Compiled = (scope: Scope) => number;

/** A function the graph defines: f(x) = body. */
export interface UserFunction {
	params: string[];
	body: Expr;
}

export interface CompileOptions {
	/** Trig functions take degrees and inverse trig functions return them. */
	degrees?: boolean;
	/** The graph's own functions, by name. */
	functions?: Readonly<Record<string, UserFunction>>;
}

export const MAX_SUM_TERMS = 10_000;
const MAX_CALL_DEPTH = 40;

/** ∫ f over [a, b] by adaptive Simpson's rule; NaN where f is undefined. */
export function integrate(f: (x: number) => number, a: number, b: number, tolerance = 1e-9): number {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
	if (a === b) return 0;
	if (a > b) return -integrate(f, b, a, tolerance);
	const simpson = (fa: number, fm: number, fb: number, width: number) => (width / 6) * (fa + 4 * fm + fb);
	const step = (lo: number, hi: number, fa: number, fm: number, fb: number, whole: number, eps: number, depth: number): number => {
		const mid = (lo + hi) / 2;
		const flm = f((lo + mid) / 2);
		const frm = f((mid + hi) / 2);
		const left = simpson(fa, flm, fm, mid - lo);
		const right = simpson(fm, frm, fb, hi - mid);
		const delta = left + right - whole;
		if (depth <= 0 || Math.abs(delta) <= 15 * eps) return left + right + delta / 15;
		return step(lo, mid, fa, flm, fm, left, eps / 2, depth - 1) + step(mid, hi, fm, frm, fb, right, eps / 2, depth - 1);
	};
	// Start from several panels so a narrow feature between three sample points is not missed.
	const panels = 8;
	let total = 0;
	for (let i = 0; i < panels; i++) {
		const lo = a + ((b - a) * i) / panels;
		const hi = a + ((b - a) * (i + 1)) / panels;
		const fa = f(lo);
		const fm = f((lo + hi) / 2);
		const fb = f(hi);
		total += step(lo, hi, fa, fm, fb, simpson(fa, fm, fb, hi - lo), tolerance / panels, 18);
	}
	return total;
}

/** f′(x) by a central difference with one step of Richardson extrapolation. */
export function differentiate(f: (x: number) => number, x: number): number {
	const h = Math.max(Math.abs(x), 1) * 1e-3;
	const d = (step: number) => (f(x + step) - f(x - step)) / (2 * step);
	return (4 * d(h / 2) - d(h)) / 3;
}

/** Compile a scalar expression to a function of its variables. Tuples and
 *  matrices are not numbers and are refused here. */
export function compile(expr: Expr, options: CompileOptions = {}): Compiled {
	return compileWith(expr, options);
}

interface FunctionBody {
	compiled: Compiled;
	depth: number;
}
const BODIES = new WeakMap<object, Map<string, FunctionBody>>();

/** The compiled body of one of the graph's functions, cached per function table. */
function bodyOf(options: CompileOptions, name: string, fn: UserFunction): FunctionBody {
	const table = options.functions!;
	let bodies = BODIES.get(table);
	if (!bodies) BODIES.set(table, (bodies = new Map()));
	const key = `${options.degrees ? "deg" : "rad"}:${name}`;
	let body = bodies.get(key);
	if (!body) {
		// Registered before compiling, so a body that calls itself finds this entry.
		body = { compiled: () => NaN, depth: 0 };
		bodies.set(key, body);
		body.compiled = compileWith(fn.body, options);
	}
	return body;
}

function compileWith(expr: Expr, options: CompileOptions): Compiled {
	const compile = (inner: Expr) => compileWith(inner, options);
	switch (expr.type) {
		case "num": {
			const value = expr.value;
			return () => value;
		}
		case "var": {
			const name = expr.name;
			if (isConstantName(name)) {
				const value = CONSTANTS[name]!;
				return () => value;
			}
			return (scope) => scope[name] ?? NaN;
		}
		case "neg": {
			const arg = compile(expr.arg);
			return (scope) => -arg(scope);
		}
		case "call": {
			if (isLinearFunction(expr.fn)) throw new ExprError(`${expr.fn} works on vectors and matrices and cannot be used here.`);
			const spec = FUNCTIONS[expr.fn]!;
			const raw = spec.fn;
			const fn = !options.degrees || !spec.angle ? raw : spec.angle === "in" ? (x: number) => raw(x * DEG) : (x: number) => raw(x) / DEG;
			const args = expr.args.map(compile);
			if (args.length === 1) {
				const only = args[0]!;
				return (scope) => fn(only(scope));
			}
			return (scope) => fn(...args.map((arg) => arg(scope)));
		}
		case "bin": {
			const left = compile(expr.left);
			const right = compile(expr.right);
			switch (expr.op) {
				case "+":
					return (scope) => left(scope) + right(scope);
				case "-":
					return (scope) => left(scope) - right(scope);
				case "*":
					return (scope) => left(scope) * right(scope);
				case "/":
					return (scope) => left(scope) / right(scope);
				case "^":
					return (scope) => power(left(scope), right(scope));
			}
		}
		// falls through: every operator returned above
		case "binder": {
			const body = compile(expr.body);
			const name = expr.variable;
			// The bound variable lives in a scope layered over the caller's.
			const at = (scope: Scope) => {
				const local: Scope = Object.create(scope);
				return (value: number) => {
					local[name] = value;
					return body(local);
				};
			};
			if (expr.op === "deriv") return (scope) => differentiate(at(scope), scope[name] ?? NaN);
			const lower = compile(expr.lower!);
			const upper = compile(expr.upper!);
			if (expr.op === "int") return (scope) => integrate(at(scope), lower(scope), upper(scope));
			const product = expr.op === "prod";
			return (scope) => {
				const from = Math.round(lower(scope));
				const to = Math.round(upper(scope));
				if (!Number.isFinite(from) || !Number.isFinite(to) || to - from >= MAX_SUM_TERMS) return NaN;
				const term = at(scope);
				let total = product ? 1 : 0;
				for (let n = from; n <= to; n++) total = product ? total * term(n) : total + term(n);
				return total;
			};
		}
		case "apply": {
			const args = expr.args.map(compile);
			const { name, primes } = expr;
			return (scope) => {
				const fn = options.functions?.[name];
				if (!fn || fn.params.length !== args.length || (primes > 0 && fn.params.length !== 1)) return NaN;
				// One compiled body and one depth count per function, shared by every
				// call site — including the calls inside its own body. Compiled on
				// first use: a function may be defined below the line that calls it.
				const state = bodyOf(options, name, fn);
				const target = state.compiled;
				if (state.depth >= MAX_CALL_DEPTH) return NaN; // f(x) = f(x) + 1
				const local: Scope = Object.create(scope);
				const call = (...values: number[]) => {
					fn.params.forEach((param, index) => {
						local[param] = values[index]!;
					});
					return target(local);
				};
				state.depth++;
				try {
					let single = (value: number) => call(value);
					for (let i = 0; i < primes; i++) {
						const inner = single;
						single = (value: number) => differentiate(inner, value);
					}
					return primes > 0 ? single(args[0]!(scope)) : call(...args.map((arg) => arg(scope)));
				} finally {
					state.depth--;
				}
			};
		}
		case "tuple":
		case "matrix":
			throw new ExprError("A point or matrix cannot be used as a number here.");
	}
}

/** x^y with real odd roots of negatives: (-8)^(1/3) is -2, as a learner expects, not NaN. */
export function power(base: number, exponent: number): number {
	if (base >= 0 || Number.isInteger(exponent)) return Math.pow(base, exponent);
	const denominator = Math.round(1 / exponent);
	if (Math.abs(1 / denominator - exponent) < 1e-12 && Math.abs(denominator) % 2 === 1) return -Math.pow(-base, exponent);
	return NaN;
}

/** Split an expression line at its top-level "=" (outside brackets). Refuses inequalities and chains. */
export function splitEquation(tokens: Token[]): { left: Token[]; right: Token[] } | null {
	let depth = 0;
	let at = -1;
	for (const [index, token] of tokens.entries()) {
		if (token.kind !== "op") continue;
		if (token.op === "(" || token.op === "[") depth++;
		else if (token.op === ")" || token.op === "]") depth--;
		else if (token.op === "<" || token.op === ">") throw new ExprError("Inequalities are not supported yet.");
		else if (token.op === "=" && depth === 0) {
			if (at >= 0) throw new ExprError("Use one = sign.");
			at = index;
		}
	}
	return at < 0 ? null : { left: tokens.slice(0, at), right: tokens.slice(at + 1) };
}

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
 *   (1, 2), [[1,2],[3,4]] tuples and matrices (points now; vectors and
 *                         matrices in later phases)
 */

export type Expr =
	| { type: "num"; value: number }
	| { type: "var"; name: string }
	| { type: "call"; fn: string; args: Expr[] }
	| { type: "bin"; op: "+" | "-" | "*" | "/" | "^"; left: Expr; right: Expr }
	| { type: "neg"; arg: Expr }
	| { type: "tuple"; items: Expr[] }
	| { type: "matrix"; rows: Expr[][] };

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
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
/** Multi-letter names that are variables, not products of letters. */
const NAMED_VARIABLES = ["theta"];
const WORDS = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), ...NAMED_VARIABLES].sort((a, b) => b.length - a.length);

export const isFunctionName = (name: string) => Object.hasOwn(FUNCTIONS, name);
export const isConstantName = (name: string) => Object.hasOwn(CONSTANTS, name);

type Token =
	| { kind: "num"; value: number }
	| { kind: "name"; name: string }
	| { kind: "op"; op: string };

const SYMBOLS: Record<string, string> = { "×": "*", "·": "*", "⋅": "*", "÷": "/", "−": "-", "–": "-", "π": "pi", "θ": "theta", "√": "sqrt" };

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
			if (word) {
				tokens.push({ kind: "name", name: word });
				i += word.length;
			} else {
				tokens.push({ kind: "name", name: ch });
				i++;
			}
			continue;
		}
		if ("+-*/^(),|[]=<>!".includes(ch)) {
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
	constructor(private readonly tokens: Token[]) {}

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
			if (isFunctionName(token.name)) return this.call(token.name);
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
			while (this.startsFactor() && !(this.peek()?.kind === "name" && isFunctionName((this.peek() as { name: string }).name))) {
				product = { type: "bin", op: "*", left: product, right: this.power() };
			}
			args = [product];
		}
		const arity = FUNCTIONS[fn]!.arity;
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
export function parseTokens(tokens: Token[]): Expr[] {
	if (tokens.length === 0) throw new ExprError("Nothing to graph.");
	return new Parser(tokens).list();
}

export function parseExpr(source: string): Expr {
	const all = parseTokens(tokenize(source));
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

export interface CompileOptions {
	/** Trig functions take degrees and inverse trig functions return them. */
	degrees?: boolean;
}

const DEG = Math.PI / 180;

/** Compile a scalar expression to a function of its variables. Tuples and
 *  matrices are not numbers and are refused here. */
export function compile(expr: Expr, options: CompileOptions = {}): Compiled {
	return compileWith(expr, options);
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
		case "tuple":
		case "matrix":
			throw new ExprError("A point or matrix cannot be used as a number here.");
	}
}

/** x^y with real odd roots of negatives: (-8)^(1/3) is -2, as a learner expects, not NaN. */
function power(base: number, exponent: number): number {
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

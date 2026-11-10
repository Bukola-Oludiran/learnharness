/**
 * The grapher's two spellings (fork, phase 5c3 — see FORK.md). The maths
 * editor works in LaTeX; the tutor, the saved graph and the parser work in
 * the plain text of core/plot/expr.ts. This file converts both ways:
 *
 *   latexToText  what the editor holds → plain text the parser reads
 *   textToLatex  plain text (the tutor's, or a graph saved before the
 *                editor existed) → what the editor shows
 *
 * Only the LaTeX the editor produces is understood, not LaTeX at large.
 * The expression tree stays the single truth: both spellings denote it.
 * Pure; no dependency on the editor.
 */

import { ExprError, isBinderName, isConstantName, isFunctionName, parseTokens, splitEquation, tokenize, type Expr } from "./expr.ts";

// ── LaTeX → text ────────────────────────────────────────────────────────────

type Tok = { kind: "cmd"; name: string } | { kind: "char"; ch: string } | { kind: "group"; items: Tok[] };

function lex(source: string): Tok[] {
	let i = 0;
	const read = (closer: string | null): Tok[] => {
		const out: Tok[] = [];
		while (i < source.length) {
			const ch = source[i]!;
			if (ch === "}") {
				if (closer !== "}") throw new ExprError("There is an unmatched bracket.");
				i++;
				return out;
			}
			if (ch === "{") {
				i++;
				out.push({ kind: "group", items: read("}") });
				continue;
			}
			if (ch === "\\") {
				const word = /^\\([A-Za-z]+)\*?/.exec(source.slice(i));
				if (word) {
					out.push({ kind: "cmd", name: word[1]! });
					i += word[0].length;
					// A command swallows the spaces after it.
					while (source[i] === " ") i++;
				} else {
					out.push({ kind: "cmd", name: source[i + 1] ?? "" });
					i += 2;
				}
				continue;
			}
			if (!/\s/.test(ch)) out.push({ kind: "char", ch });
			i++;
		}
		if (closer !== null) throw new ExprError("There is an unmatched bracket.");
		return out;
	};
	return read(null);
}

const TRIG = ["sin", "cos", "tan", "sec", "csc", "cot"];
const HYPERBOLIC = ["sinh", "cosh", "tanh"];
/** LaTeX command → the grapher's function name. */
const COMMAND_FUNCTIONS: Record<string, string> = {
	...Object.fromEntries([...TRIG, ...HYPERBOLIC, "ln", "log", "exp", "min", "max", "gcd"].map((name) => [name, name])),
	arcsin: "asin", arccos: "acos", arctan: "atan", arcsec: "asec", arccsc: "acsc", arccot: "acot", arctg: "atan", tg: "tan", cosec: "csc", ctg: "cot",
	arsinh: "asinh", arcosh: "acosh", artanh: "atanh", lg: "log",
};
const GREEK: Record<string, string> = {
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
	xi: "ξ", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
};
const SPACING = new Set([",", ";", ":", "!", " ", "quad", "qquad", "enspace", "thinspace", "displaystyle", "textstyle", "limits", "nolimits"]);
const SYMBOL_COMMANDS: Record<string, string> = {
	// Named symbols are set off by spaces so they never run into a neighbouring letter (co·θ is not cot).
	cdot: "*", times: "*", ast: "*", div: "/", pi: " pi ", theta: " theta ", vartheta: " theta ", exponentialE: "e", lbrack: "[", rbrack: "]", lparen: "(", rparen: ")", "{": "(", "}": ")",
	lt: "<", gt: ">", le: "<", ge: ">", leq: "<", geq: ">", "%": "%",
};
const OPEN: Record<string, string> = { "(": ")", "[": "]" };

class LatexReader {
	private at = 0;
	constructor(private readonly toks: Tok[]) {}

	private peek(offset = 0): Tok | undefined {
		return this.toks[this.at + offset];
	}
	private isChar(ch: string, offset = 0): boolean {
		const tok = this.peek(offset);
		return tok?.kind === "char" && tok.ch === ch;
	}
	private isCmd(name: string, offset = 0): boolean {
		const tok = this.peek(offset);
		return tok?.kind === "cmd" && tok.name === name;
	}
	private skipSpacing(): void {
		for (;;) {
			const tok = this.peek();
			if (tok?.kind === "cmd" && SPACING.has(tok.name)) this.at++;
			else return;
		}
	}

	/** Everything, to the end. */
	all(): string {
		let out = "";
		while (this.at < this.toks.length) out += this.piece();
		return out;
	}

	/** One token's worth of text. */
	private piece(): string {
		const tok = this.toks[this.at++]!;
		if (tok.kind === "group") return sub(tok.items);
		if (tok.kind === "char") {
			if (tok.ch === "^") {
				// f^{\prime}, f^{\prime\prime}: the editor's spelling of f', f''.
				const next = this.peek();
				const marks = next?.kind === "group" ? next.items : next ? [next] : [];
				const isPrime = (mark: Tok) => (mark.kind === "cmd" && (mark.name === "prime" || mark.name === "doubleprime")) || (mark.kind === "char" && mark.ch === "'");
				if (marks.length > 0 && marks.every(isPrime)) {
					this.at++;
					return marks.map((mark) => (mark.kind === "cmd" && mark.name === "doubleprime" ? "''" : "'")).join("");
				}
				return `^(${this.script()})`;
			}
			if (tok.ch === "_") throw new ExprError("Subscripts are not supported here.");
			return tok.ch;
		}
		const name = tok.name;
		if (SPACING.has(name)) return " ";
		if (name in SYMBOL_COMMANDS) return SYMBOL_COMMANDS[name]!;
		if (name in GREEK) return GREEK[name]!;
		if (name === "left" || name === "right" || name === "mleft" || name === "mright" || name === "bigl" || name === "bigr" || name === "Bigl" || name === "Bigr") return this.delimiter(name.endsWith("left") || name.endsWith("l"));
		if (name === "lvert" || name === "lVert") return "abs(";
		if (name === "rvert" || name === "rVert") return ")";
		if (name === "lfloor") return "floor(";
		if (name === "lceil") return "ceil(";
		if (name === "rfloor" || name === "rceil") return ")";
		if (name === "frac" || name === "dfrac" || name === "tfrac") return this.fraction();
		if (name === "sqrt") return this.root();
		if (name === "int") return this.integral();
		if (name === "sum" || name === "prod") return this.series(name);
		if (name === "operatorname" || name === "mathrm" || name === "text" || name === "mathit" || name === "mathbf") {
			const word = this.wordArgument();
			if (name === "operatorname" || isFunctionName(word.toLowerCase()) || isBinderName(word.toLowerCase())) return this.functionCall(word);
			return word;
		}
		if (name in COMMAND_FUNCTIONS) return this.functionCall(COMMAND_FUNCTIONS[name]!);
		if (name === "placeholder") {
			if (this.peek()?.kind === "group") this.at++;
			throw new ExprError("Fill in the empty box.");
		}
		if (name === "infty") throw new ExprError("Infinite limits are not supported yet.");
		if (name === "differentialD") return "d";
		if (name === "imaginaryI") throw new ExprError("Complex numbers are not supported.");
		if (name === "prime") return "'";
		throw new ExprError(`\\${name} is not something the grapher understands.`);
	}

	/** \left( … \right| and friends: the delimiter that follows decides. */
	private delimiter(opening: boolean): string {
		const tok = this.toks[this.at++];
		if (!tok) throw new ExprError("There is an unmatched bracket.");
		if (tok.kind === "char") {
			if (tok.ch === "|") return opening ? "abs(" : ")";
			if (tok.ch === ".") return "";
			return tok.ch;
		}
		if (tok.kind === "cmd") {
			if (tok.name === "lvert" || tok.name === "vert" || tok.name === "rvert" || tok.name === "|") return opening ? "abs(" : ")";
			if (tok.name === "lfloor") return "floor(";
			if (tok.name === "lceil") return "ceil(";
			if (tok.name === "rfloor" || tok.name === "rceil") return ")";
			if (tok.name in SYMBOL_COMMANDS) return SYMBOL_COMMANDS[tok.name]!;
		}
		throw new ExprError("That bracket is not something the grapher understands.");
	}

	/** What follows ^ or _: a braced group, or one token. */
	private script(): string {
		const tok = this.peek();
		if (!tok) throw new ExprError("Fill in the empty box.");
		if (tok.kind === "group") {
			this.at++;
			return sub(tok.items);
		}
		return this.piece();
	}

	private groupArgument(): Tok[] {
		const tok = this.toks[this.at++];
		if (!tok) throw new ExprError("Fill in the empty box.");
		return tok.kind === "group" ? tok.items : [tok];
	}
	private wordArgument(): string {
		return this.groupArgument()
			.map((tok) => (tok.kind === "char" ? tok.ch : tok.kind === "group" ? "" : (GREEK[tok.name] ?? "")))
			.join("");
	}

	private fraction(): string {
		const top = this.groupArgument();
		const bottom = this.groupArgument();
		// d/dx: a derivative of the term that follows.
		const variable = differentialOf(bottom);
		if (variable && isLoneD(top)) {
			const body = this.term();
			if (!body.trim()) throw new ExprError("Fill in what to differentiate.");
			return ` deriv(${body}, ${variable})`;
		}
		return `((${sub(top)})/(${sub(bottom)}))`;
	}

	private root(): string {
		let index: string | null = null;
		if (this.isChar("[")) {
			this.at++;
			const inner: Tok[] = [];
			while (this.at < this.toks.length && !this.isChar("]")) inner.push(this.toks[this.at++]!);
			if (!this.isChar("]")) throw new ExprError("There is an unmatched bracket.");
			this.at++;
			index = sub(inner);
		}
		const radicand = sub(this.groupArgument());
		return index === null ? ` sqrt(${radicand})` : ` root(${radicand}, ${index})`;
	}

	/** The _{…} and ^{…} of an integral, sum or product, in either order. */
	private limits(): { lower: Tok[] | null; upper: Tok[] | null } {
		let lower: Tok[] | null = null;
		let upper: Tok[] | null = null;
		for (;;) {
			this.skipSpacing();
			if (this.isChar("_")) {
				this.at++;
				lower = this.groupArgument();
			} else if (this.isChar("^")) {
				this.at++;
				upper = this.groupArgument();
			} else return { lower, upper };
		}
	}

	private integral(): string {
		const { lower, upper } = this.limits();
		if (!lower || !upper) throw new ExprError("An integral needs a lower and an upper limit.");
		// The integrand runs to its differential: the last d‹letter› before the term list ends.
		const start = this.at;
		let depth = 0;
		let found = -1;
		let length = 1;
		let variable = "";
		let i = start;
		for (; i < this.toks.length; i++) {
			const tok = this.toks[i]!;
			if (tok.kind === "char" && (tok.ch === "(" || tok.ch === "[")) depth++;
			else if (tok.kind === "char" && (tok.ch === ")" || tok.ch === "]")) {
				if (depth === 0) break;
				depth--;
			} else if (tok.kind === "cmd" && (tok.name === "left" || tok.name === "mleft")) {
				depth++;
				i++;
			} else if (tok.kind === "cmd" && (tok.name === "right" || tok.name === "mright")) {
				if (depth === 0) break;
				depth--;
				i++;
			} else if (depth === 0 && tok.kind === "char" && (tok.ch === "=" || tok.ch === ",")) break;
			else if (depth === 0) {
				const d = differentialAt(this.toks, i);
				if (d) {
					found = i;
					length = d.length;
					variable = d.variable;
					// An explicit upright d is unambiguous; a plain "dx" may be followed by a later one.
					if (d.upright) break;
				}
			} else {
				// The editor closes a bracket typed in the integrand around everything
				// after it, the differential included: ∫ sin(x² dx). When the upright
				// d is followed only by those closing brackets, it ends the integrand
				// and the brackets close in front of it.
				const d = differentialAt(this.toks, i);
				const closers = d?.upright ? closingRun(this.toks, i + d.length, depth) : null;
				if (d && closers !== null) {
					const body = sub([...this.toks.slice(start, i), ...this.toks.slice(i + d.length, closers)]);
					if (!body.trim()) throw new ExprError("Fill in what to integrate.");
					this.at = closers;
					return ` int(${body}, ${d.variable}, ${sub(lower)}, ${sub(upper)})`;
				}
			}
		}
		if (found < 0) throw new ExprError("An integral needs its variable at the end, such as dx.");
		const body = sub(this.toks.slice(start, found));
		if (!body.trim()) throw new ExprError("Fill in what to integrate.");
		this.at = found + length;
		return ` int(${body}, ${variable}, ${sub(lower)}, ${sub(upper)})`;
	}

	private series(name: "sum" | "prod"): string {
		const { lower, upper } = this.limits();
		const equals = lower?.findIndex((tok) => tok.kind === "char" && tok.ch === "=") ?? -1;
		if (!lower || !upper || equals < 1) throw new ExprError(`A ${name === "sum" ? "sum" : "product"} needs a start such as n = 1 below it and an end above it.`);
		const variable = sub(lower.slice(0, equals)).trim();
		if (!/^[A-Za-zα-ωΑ-Ω]$/.test(variable)) throw new ExprError("The counter must be a single letter.");
		const body = this.term();
		if (!body.trim()) throw new ExprError(`Fill in what to ${name === "sum" ? "add up" : "multiply"}.`);
		return ` ${name}(${body}, ${variable}, ${sub(lower.slice(equals + 1))}, ${sub(upper)})`;
	}

	/** The product that follows: up to the next + or − (not a leading sign), =, comma or closing bracket. */
	private term(): string {
		let out = "";
		let depth = 0;
		let first = true;
		while (this.at < this.toks.length) {
			const tok = this.peek()!;
			if (tok.kind === "char") {
				if (depth === 0 && (tok.ch === "=" || tok.ch === "," || tok.ch === ")" || tok.ch === "]")) break;
				if (depth === 0 && !first && (tok.ch === "+" || tok.ch === "-")) break;
				if (tok.ch === "(" || tok.ch === "[") depth++;
				if (tok.ch === ")" || tok.ch === "]") depth--;
			} else if (tok.kind === "cmd") {
				if (tok.name === "right" || tok.name === "mright") {
					if (depth === 0) break;
					depth--;
				} else if (tok.name === "left" || tok.name === "mleft") depth++;
			}
			const piece = this.piece();
			if (piece.trim()) first = false;
			out += piece;
		}
		return out;
	}

	/** \sin, \sin^{2}, \sin^{-1}, \log_{b}: the function, then its argument. */
	private functionCall(rawName: string): string {
		let name = rawName;
		let base: string | null = null;
		let powerOf: string | null = null;
		for (;;) {
			this.skipSpacing();
			if (this.isChar("_")) {
				this.at++;
				base = sub(this.groupArgument());
			} else if (this.isChar("^")) {
				this.at++;
				const exponent = sub(this.groupArgument()).replace(/\s+/g, "");
				// sin⁻¹ is the inverse function; any other power applies to the value.
				if (exponent === "-1" && (TRIG.includes(name) || HYPERBOLIC.includes(name))) name = `a${name}`;
				else powerOf = exponent;
			} else break;
		}
		if (base !== null && name !== "log") throw new ExprError("Subscripts are not supported here.");
		const needsBrackets = base !== null || powerOf !== null;
		const opens = this.isChar("(") || ((this.isCmd("left") || this.isCmd("mleft")) && this.isChar("(", 1));
		if (!opens) {
			if (needsBrackets) throw new ExprError(`Put what ${name} applies to in brackets.`);
			// sin x, sin 2x: the plain-text parser applies the function to the product that follows.
			return ` ${name} `;
		}
		const inner = this.bracketed();
		// The leading space keeps a·sin(x) from reading as asin(x).
		const call = base !== null ? ` ${name}(${inner}, ${base})` : ` ${name}(${inner})`;
		return powerOf !== null ? `(${call})^(${powerOf})` : call;
	}

	/** A bracketed group starting here, without its brackets. */
	private bracketed(): string {
		if (this.isCmd("left") || this.isCmd("mleft")) this.at++;
		const open = this.toks[this.at++] as { ch: string };
		const close = OPEN[open.ch]!;
		let out = "";
		let depth = 0;
		while (this.at < this.toks.length) {
			if ((this.isCmd("right") || this.isCmd("mright")) && depth === 0 && this.isChar(close, 1)) {
				this.at += 2;
				return out;
			}
			if (this.isChar(close) && depth === 0) {
				this.at++;
				return out;
			}
			if (this.isChar(open.ch)) depth++;
			else if (this.isChar(close)) depth--;
			out += this.piece();
		}
		throw new ExprError("There is an unmatched bracket.");
	}
}

function sub(toks: Tok[]): string {
	if (toks.length === 0) throw new ExprError("Fill in the empty box.");
	return new LatexReader(toks).all();
}

/** Where a run of exactly `count` closing brackets starting at `from` ends, or null when anything else comes first. */
function closingRun(toks: Tok[], from: number, count: number): number | null {
	let at = from;
	for (let closed = 0; closed < count; closed++) {
		const tok = toks[at];
		if (tok?.kind === "cmd" && (tok.name === "right" || tok.name === "mright")) at += 2;
		else if (tok?.kind === "char" && (tok.ch === ")" || tok.ch === "]")) at += 1;
		else return null;
	}
	return at <= toks.length ? at : null;
}

/** `d` alone, upright or not (the top of d/dx). */
function isLoneD(toks: Tok[]): boolean {
	// \mathrm{d}
	if (toks.length === 2 && toks[0]!.kind === "cmd" && ["mathrm", "operatorname", "text"].includes((toks[0] as { name: string }).name) && toks[1]!.kind === "group") return isLoneD((toks[1] as { items: Tok[] }).items);
	if (toks.length !== 1) return false;
	const tok = toks[0]!;
	if (tok.kind === "char") return tok.ch === "d";
	if (tok.kind === "cmd") return tok.name === "differentialD";
	return isLoneD(tok.items);
}

/** The differential starting at `index`, if there is one: \mathrm{d}x, \differentialD x, or plain dx. */
function differentialAt(toks: Tok[], index: number): { variable: string; length: number; upright: boolean } | null {
	const tok = toks[index]!;
	const letterAt = (at: number) => {
		const next = toks[at];
		if (next?.kind === "char" && /[A-Za-z]/.test(next.ch)) return next.ch;
		if (next?.kind === "cmd" && next.name in GREEK) return GREEK[next.name]!;
		if (next?.kind === "cmd" && next.name === "theta") return "theta";
		return null;
	};
	if (tok.kind === "cmd" && tok.name === "differentialD") {
		const variable = letterAt(index + 1);
		return variable ? { variable, length: 2, upright: true } : null;
	}
	if (tok.kind === "cmd" && (tok.name === "mathrm" || tok.name === "operatorname" || tok.name === "text")) {
		const arg = toks[index + 1];
		if (arg?.kind !== "group") return null;
		const word = arg.items.map((item) => (item.kind === "char" ? item.ch : "?")).join("");
		if (word === "d") {
			const variable = letterAt(index + 2);
			return variable ? { variable, length: 3, upright: true } : null;
		}
		// \mathrm{dx}
		if (/^d[A-Za-z]$/.test(word)) return { variable: word[1]!, length: 2, upright: true };
		return null;
	}
	if (tok.kind === "char" && tok.ch === "d") {
		const variable = letterAt(index + 1);
		return variable ? { variable, length: 2, upright: false } : null;
	}
	return null;
}

/** The variable of a `dx` denominator (d/dx), or null. */
function differentialOf(toks: Tok[]): string | null {
	const d = toks.length > 0 ? differentialAt(toks, 0) : null;
	return d && d.length === toks.length ? d.variable : null;
}

/**
 * The editor's LaTeX as the plain text the parser reads. Throws an
 * ExprError, worded for the learner, for anything it cannot express.
 */
export function latexToText(latex: string): string {
	const text = sub(lex(latex)).replace(/\s+/g, " ").trim();
	return text;
}

/** latexToText, never throwing: the text, or the reason there is none. */
export function readLatex(latex: string): { text: string; problem?: undefined } | { text: ""; problem: string } {
	if (!latex.trim()) return { text: "" };
	try {
		return { text: latexToText(latex) };
	} catch (error) {
		return { text: "", problem: error instanceof ExprError ? error.message : "This could not be read." };
	}
}

// ── text → LaTeX ────────────────────────────────────────────────────────────

const GREEK_COMMAND = Object.fromEntries(Object.entries(GREEK).filter(([name]) => !name.startsWith("var")).map(([name, ch]) => [ch, `\\${name}`]));
/** The grapher's function name → its LaTeX command, where LaTeX has one. */
const FUNCTION_COMMAND: Record<string, string> = {
	...Object.fromEntries([...TRIG, ...HYPERBOLIC, "ln", "log", "exp", "min", "max", "gcd"].map((name) => [name, `\\${name}`])),
	asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan", arcsin: "\\arcsin", arccos: "\\arccos", arctan: "\\arctan",
};
const PRETTY_NAME: Record<string, string> = { ncr: "nCr", npr: "nPr" };

// Binding strength, loosest first.
const SUM = 1;
const PRODUCT = 2;
const UNARY = 3;
const POWER = 4;
const ATOM = 5;

const paren = (inner: string) => `\\left(${inner}\\right)`;

function strength(expr: Expr): number {
	switch (expr.type) {
		case "bin":
			return expr.op === "+" || expr.op === "-" ? SUM : expr.op === "*" ? PRODUCT : expr.op === "^" ? POWER : ATOM; // a fraction is its own box
		case "neg":
			return UNARY;
		case "binder":
			// A sum or integral swallows the product after it, so it needs brackets inside one.
			return expr.op === "deriv" ? ATOM : SUM;
		default:
			return ATOM;
	}
}

function print(expr: Expr, atLeast = SUM): string {
	const out = bare(expr);
	return strength(expr) < atLeast ? paren(out) : out;
}

function bare(expr: Expr): string {
	switch (expr.type) {
		case "num": {
			const text = String(expr.value);
			const sci = /^(-?[\d.]+)e([+-]?\d+)$/.exec(text);
			return sci ? `${sci[1]}\\cdot10^{${Number(sci[2])}}` : text;
		}
		case "var":
			return expr.name === "pi" ? "\\pi" : expr.name === "theta" ? "\\theta" : (GREEK_COMMAND[expr.name] ?? expr.name);
		case "neg":
			return `-${print(expr.arg, UNARY)}`;
		case "bin": {
			if (expr.op === "+") return `${print(expr.left, SUM)}+${print(expr.right, PRODUCT)}`;
			if (expr.op === "-") return `${print(expr.left, SUM)}-${print(expr.right, PRODUCT)}`;
			if (expr.op === "/") return `\\frac{${print(expr.left)}}{${print(expr.right)}}`;
			if (expr.op === "^") return `${print(expr.left, ATOM)}^{${print(expr.right)}}`;
			const left = print(expr.left, PRODUCT);
			const right = print(expr.right, expr.right.type === "neg" ? ATOM : PRODUCT);
			// Juxtapose where it reads unambiguously; otherwise a dot.
			const leftIsLetter = expr.left.type === "var" || expr.left.type === "apply";
			const dot = expr.right.type === "num" || (expr.right.type === "bin" && expr.right.op === "^" && expr.right.left.type === "num") || (leftIsLetter && right.startsWith("\\left("));
			return dot ? `${left}\\cdot ${right}` : `${left}${right}`;
		}
		case "call": {
			const args = expr.args.map((arg) => print(arg));
			if (expr.fn === "sqrt") return `\\sqrt{${args[0]}}`;
			if (expr.fn === "abs") return `\\left|${args[0]}\\right|`;
			if (expr.fn === "root") return `\\sqrt[${args[1]}]{${args[0]}}`;
			if (expr.fn === "factorial") return `${print(expr.args[0]!, ATOM)}!`;
			if (expr.fn === "log" && args.length === 2) return `\\log_{${args[1]}}${paren(args[0]!)}`;
			const command = FUNCTION_COMMAND[expr.fn] ?? `\\operatorname{${PRETTY_NAME[expr.fn] ?? expr.fn}}`;
			return `${command}${paren(args.join(","))}`;
		}
		case "binder": {
			const variable = bare({ type: "var", name: expr.variable });
			if (expr.op === "deriv") return `\\frac{\\mathrm{d}}{\\mathrm{d}${variable}}${paren(print(expr.body))}`;
			const lower = print(expr.lower!);
			const upper = print(expr.upper!);
			if (expr.op === "int") return `\\int_{${lower}}^{${upper}}${print(expr.body, PRODUCT)}\\,\\mathrm{d}${variable}`;
			return `\\${expr.op}_{${variable}=${lower}}^{${upper}}${print(expr.body, PRODUCT)}`;
		}
		case "apply":
			return `${bare({ type: "var", name: expr.name })}${"'".repeat(expr.primes)}${paren(expr.args.map((arg) => print(arg)).join(","))}`;
		case "tuple":
			return paren(expr.items.map((item) => print(item)).join(","));
		case "matrix":
			return `\\begin{bmatrix}${expr.rows.map((row) => row.map((cell) => print(cell)).join("&")).join("\\\\")}\\end{bmatrix}`;
	}
}

/** An expression tree as LaTeX. */
export function exprToLatex(expr: Expr): string {
	return print(expr);
}

const escapeText = (text: string) => text.replace(/[\\{}$&#^_%~]/g, (ch) => `\\${ch === "\\" ? "backslash " : ch}`);

/**
 * A plain-text line as the editor shows it. A line the parser cannot read
 * is shown as it was typed, so nothing the tutor or an older graph wrote is
 * ever lost from view.
 */
export function textToLatex(text: string, functions?: ReadonlySet<string>): string {
	if (!text.trim()) return "";
	try {
		const tokens = tokenize(text);
		const sides = splitEquation(tokens);
		const side = (list: typeof tokens) => parseTokens(list, functions).map((expr) => print(expr)).join(",");
		// A definition's left side, f(x), is a name with its parameters, not a product.
		const header = sides ? /^\s*([A-Za-zα-ωΑ-Ω])\s*\(([^()]*)\)\s*$/.exec(text.slice(0, text.indexOf("="))) : null;
		if (sides && header && functions?.has(header[1]!)) {
			const params = header[2]!.split(",").map((param) => bare({ type: "var", name: param.trim() }));
			return `${bare({ type: "var", name: header[1]! })}${paren(params.join(","))}=${side(sides.right)}`;
		}
		return sides ? `${side(sides.left)}=${side(sides.right)}` : side(tokens);
	} catch {
		return `\\text{${escapeText(text)}}`;
	}
}

// Kept visible to callers that list what the keypad may insert.
export const isKnownName = (name: string) => isFunctionName(name) || isBinderName(name) || isConstantName(name);

/**
 * Calculus, functions and the two spellings (fork, phase 5c3 — FORK.md):
 * integrals, derivatives, sums and products in the expression language;
 * function definitions in the graph model; and the converters between the
 * maths editor's LaTeX and the parser's plain text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compile, DEFAULT_VIEW, differentiate, exprToLatex, functionHeader, integrate, latexToText, parseExpr, plotOutline, readLatex, resolvePlot, textToLatex, variablesOf,
	type PlotDoc,
} from "../src/core/plot/index.ts";

const value = (source: string, scope: Record<string, number> = {}) => compile(parseExpr(source))(scope);
const close = (actual: number, expected: number, tolerance = 1e-7, message?: string) =>
	assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), message ?? `${actual} ≉ ${expected}`);
const doc = (lines: string[], extra: Partial<PlotDoc> = {}): PlotDoc => ({ type: "plot", mode: "2d", lines: lines.map((text, i) => ({ id: `l${i + 1}`, text })), view: { ...DEFAULT_VIEW }, ...extra });
const last = (lines: string[], extra: Partial<PlotDoc> = {}) => resolvePlot(doc(lines, extra)).lines.at(-1)!;
const valueOf = (lines: string[], extra: Partial<PlotDoc> = {}) => (last(lines, extra) as { value: number }).value;

describe("integrals, derivatives, sums and products", () => {
	it("integrates numerically, in either direction, with limits that may be expressions", () => {
		close(value("int(x^2, x, 0, 1)"), 1 / 3);
		close(value("int(sin(t), t, 0, pi)"), 2);
		close(value("int(x^2, x, 1, 0)"), -1 / 3);
		close(value("int(e^(-t^2), t, -3, 3)"), 1.7724146965, 1e-8);
		close(value("int(t, t, 0, x)", { x: 4 }), 8);
		close(value("int(1/t, t, 1, a^2)", { a: Math.E }), 2);
		close(value("2 int(x, x, 0, 1) + 1"), 2);
		assert.equal(value("int(x, x, 2, 2)"), 0);
		assert.ok(Number.isNaN(value("int(sqrt(x), x, -1, 1)")), "undefined where the integrand is");
		close(integrate((x) => Math.exp(-200 * (x - 0.37) ** 2), 0, 1), Math.sqrt(Math.PI / 200), 1e-6, "a narrow bump is not stepped over");
	});

	it("differentiates at the current value of the variable, and nests", () => {
		close(value("deriv(x^3, x)", { x: 2 }), 12);
		close(value("deriv(sin(x), x)", { x: 0 }), 1);
		close(value("deriv(a x^2, x)", { x: 3, a: 2 }), 12);
		close(value("deriv(deriv(x^4, x), x)", { x: 1 }), 12, 1e-4);
		close(differentiate(Math.exp, 1), Math.E);
	});

	it("adds and multiplies over whole numbers", () => {
		close(value("sum(n^2, n, 1, 10)"), 385);
		close(value("sum(1/n^2, n, 1, 100)"), 1.6349839002);
		close(value("prod(k, k, 1, 5)"), 120);
		close(value("sum(sin(n x)/n, n, 1, k)", { x: 1, k: 3 }), Math.sin(1) + Math.sin(2) / 2 + Math.sin(3) / 3);
		assert.equal(value("sum(n, n, 5, 1)"), 0, "an empty sum is 0");
		assert.equal(value("prod(n, n, 5, 1)"), 1, "an empty product is 1");
		assert.ok(Number.isNaN(value("sum(n, n, 1, 20000)")), "too many terms");
		close(value("sum(sum(i j, j, 1, 3), i, 1, 3)"), 36);
		close(value("Σ(n, n, 1, 4) + ∏(n, n, 1, 3) + ∫(x, x, 0, 2)"), 18);
	});

	it("the bound variable is local: it is not free outside, and does not disturb one of the same name", () => {
		assert.deepEqual([...variablesOf(parseExpr("int(t^2, t, 0, x)"))], ["x"]);
		assert.deepEqual([...variablesOf(parseExpr("sum(a n, n, 1, k)"))].sort(), ["a", "k"]);
		assert.deepEqual([...variablesOf(parseExpr("deriv(x^2, x)"))], ["x"], "a derivative is taken at the current x");
		close(value("n + sum(n, n, 1, 3) + n", { n: 10 }), 26);
	});

	it("says how to write them", () => {
		assert.throws(() => parseExpr("int(x^2, x)"), /Expected ","\./);
		assert.throws(() => parseExpr("sum(n, 3, 1, 5)"), /Write sum\(expression, variable, from, to\)\./);
		assert.throws(() => parseExpr("deriv(x^2, sin)"), /Write deriv\(expression, variable\)\./);
		assert.throws(() => parseExpr("deriv(x^2, x, 3)"), /Write deriv\(expression, variable\)\./);
	});
});

describe("functions the graph defines", () => {
	it("recognises a definition line and its parameters", () => {
		assert.deepEqual(functionHeader("f(x) = x^2"), { name: "f", params: ["x"] });
		assert.deepEqual(functionHeader("  g ( x , y )=x y"), { name: "g", params: ["x", "y"] });
		assert.equal(functionHeader("y(x) = 2"), null, "y is a coordinate");
		assert.equal(functionHeader("f(x, x) = 2"), null);
		assert.equal(functionHeader("f(2) = 4"), null);
		assert.equal(functionHeader("a(x + 1) = 4"), null);
	});

	it("can be called, composed, differentiated with primes, and used before its definition", () => {
		const lines = ["g(2) + f(3)", "f(x) = x^2 + 1", "g(t) = 2 f(t)", "f'(3)", "f''(3)", "f(f(1))", "int(f(x), x, 0, 3)"];
		const values = resolvePlot(doc(lines)).lines.map((line) => (line as { value?: number }).value);
		close(values[0]!, 20);
		close(values[3]!, 6);
		close(values[4]!, 2, 1e-4);
		close(values[5]!, 5);
		close(values[6]!, 12);
	});

	it("a function of one variable is drawn on a flat graph, of two on a 3D one; others are only defined", () => {
		assert.equal(last(["f(x) = x^2"]).kind, "explicit-y");
		const drawn = last(["h(t) = t^3"]) as unknown as { kind: string; fn: (s: Record<string, number>) => number };
		assert.equal(drawn.kind, "explicit-y");
		close(drawn.fn({ x: 2 }), 8, 1e-12, "drawn against x whatever its parameter is called");
		assert.deepEqual(last(["g(x, y) = x y"]), { id: "l1", kind: "function", name: "g", params: ["x", "y"] });
		assert.equal(last(["g(x, y) = x y"], { mode: "3d" }).kind, "surface");
		assert.equal(last(["f(x) = x^2"], { mode: "3d" }).kind, "function");
		assert.equal(last(["f(x) = x^2", "y = f(x - 1) + f'(x)"]).kind, "explicit-y");
	});

	it("uses sliders, and reports what is wrong", () => {
		close(valueOf(["a = 3", "f(x) = a x", "f(2)"]), 6);
		const error = (lines: string[]) => (last(lines) as { error: string }).error;
		assert.equal(error(["f(x) = k x"]), '"k" is not defined. Add a line such as k = 1.');
		assert.equal(error(["f(x) = x", "f(x) = 2x"]), '"f" is already defined above.');
		assert.equal(error(["f(x) = x", "y = f + 1"]), "f is a function: write f(…).");
		assert.ok(Number.isNaN(valueOf(["f(x) = x", "f(1, 2)"])), "the wrong number of values has no answer");
		assert.ok(Number.isNaN(valueOf(["f(x) = f(x) + 1", "f(1)"])), "a function defined by itself has no answer");
		assert.equal(resolvePlot(doc(["a(x + 1)", "a = 2"])).lines[0]!.kind, "explicit-y", "a letter that is not a function still multiplies");
	});

	it("a line with integrals is marked costly, so it is drawn with fewer samples", () => {
		const resolved = resolvePlot(doc(["y = int(sin(t^2), t, 0, x)", "y = x", "y = ∫(t, t, 0, x)"]));
		assert.deepEqual([...resolved.costly], ["l1", "l3"]);
	});
});

describe("the editor's LaTeX → plain text", () => {
	const t = (latex: string) => latexToText(latex);
	const same = (latex: string, text: string, scope: Record<string, number> = { x: 1.3, y: 0.7, a: 2, n: 3, t: 0.4 }) => {
		const got = value(t(latex), scope);
		const want = value(text, scope);
		close(got, want, 1e-9, `${latex} → ${t(latex)} gave ${got}, not ${want}`);
	};

	it("reads fractions, powers, roots, brackets and absolute values", () => {
		same("\\frac{x+1}{x-1}", "(x+1)/(x-1)");
		same("\\frac12x", "x/2");
		same("x^2+x^{y+1}", "x^2 + x^(y+1)");
		same("\\sqrt{x+1}+\\sqrt[3]{x}", "sqrt(x+1) + root(x, 3)");
		same("\\left(x+1\\right)\\left(x-1\\right)", "(x+1)(x-1)");
		same("\\left|x-2\\right|+|y|", "abs(x-2) + abs(y)");
		same("2\\cdot3\\times x\\div4", "2*3*x/4");
		same("\\lfloor x\\rfloor+\\lceil y\\rceil", "floor(x) + ceil(y)");
		same("3!", "3!");
	});

	it("reads functions, with powers, inverses and bases", () => {
		same("\\sin\\left(x\\right)+\\cos x", "sin(x) + cos(x)");
		same("\\sin^{2}\\left(x\\right)", "sin(x)^2");
		same("\\sin^{-1}\\left(y\\right)+\\arctan\\left(x\\right)", "asin(y) + atan(x)");
		same("a\\sin\\left(x\\right)", "a*sin(x)", undefined);
		assert.doesNotMatch(t("a\\sin\\left(x\\right)"), /asin/, "a times sin is not arcsin");
		same("\\ln\\left(x\\right)+\\log\\left(x\\right)+\\log_{2}\\left(x\\right)", "ln(x) + log(x) + log(x, 2)");
		same("\\operatorname{nCr}\\left(5,2\\right)+\\operatorname{mod}\\left(7,3\\right)", "nCr(5,2) + mod(7,3)");
		same("\\sin 2x", "sin(2x)");
		same("2\\pi+\\theta+\\alpha x", "2pi + theta + α x", { theta: 0.5, α: 2, x: 1.3 });
		same("\\exponentialE^{x}+\\mathrm{e}", "e^x + e");
		assert.throws(() => t("\\sin^{2}x"), /Put what sin applies to in brackets\./);
	});

	it("reads integrals, derivatives, sums and products", () => {
		assert.equal(t("\\int_{0}^{1}x^{2}\\,\\mathrm{d}x"), "int(x^(2) , x, 0, 1)");
		same("\\int_{0}^{1}x^{2}\\,\\mathrm{d}x", "int(x^2, x, 0, 1)");
		same("\\int_0^xt+1\\,dt", "int(t + 1, t, 0, x)");
		same("\\int_{0}^{x}\\sin\\left(t^2\\right)\\differentialD t", "int(sin(t^2), t, 0, x)");
		same("2\\int_{0}^{1}x\\,dx+1", "2 int(x, x, 0, 1) + 1");
		same("\\int_0^1d\\cdot x\\,dx", "int(d x, x, 0, 1)", { d: 4 });
		// The editor closes a bracket typed in the integrand around the differential too.
		same("\\int_0^{x}\\sin\\left(x^2\\,\\mathrm{d}x\\right)", "int(sin(t^2), t, 0, x)");
		same("\\int_0^1\\left(x+\\left(2x\\,\\mathrm{d}x\\right)\\right)+1", "int(x + 2x, x, 0, 1) + 1");
		same("\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left(x^3-2x\\right)", "deriv(x^3 - 2x, x)");
		same("\\frac{d}{dx}x^3+1", "deriv(x^3, x) + 1");
		same("\\sum_{n=1}^{10}n^2", "sum(n^2, n, 1, 10)", { x: 1 });
		same("\\sum_{n=1}^{5}\\frac{\\sin\\left(nx\\right)}{n}+1", "sum(sin(n x)/n, n, 1, 5) + 1", { x: 1.3 });
		same("\\prod_{k=1}^{5}k", "prod(k, k, 1, 5)", {});
		same("\\sum^{3}_{i=1}\\left(i+1\\right)", "sum(i + 1, i, 1, 3)", {});
	});

	it("reads whole lines: equations, points and definitions", () => {
		assert.equal(t("y=\\frac{1}{x}"), "y=((1)/(x))");
		assert.equal(t("\\left(1,2\\right),\\left(3,4\\right)"), "(1,2),(3,4)");
		assert.equal(t("f\\left(x\\right)=x^{2}"), "f(x)=x^(2)");
		assert.equal(t("f'\\left(x\\right)+f^{\\prime}\\left(2\\right)+f^{\\prime\\prime}\\left(x\\right)").replace(/\s/g, ""), "f'(x)+f'(2)+f''(x)");
		assert.equal(t("a=2"), "a=2");
		assert.equal(t("r=1+\\cos\\left(\\theta\\right)").replace(/\s+/g, " "), "r=1+ cos( theta )");
	});

	it("explains what it cannot read", () => {
		const problem = (latex: string) => (readLatex(latex) as { problem: string }).problem;
		assert.equal(problem("\\frac{1}{\\placeholder{}}"), "Fill in the empty box.");
		assert.equal(problem("x^{}"), "Fill in the empty box.");
		assert.equal(problem("x_{1}"), "Subscripts are not supported here.");
		assert.equal(problem("\\int_{0}^{\\infty}x\\,dx"), "Infinite limits are not supported yet.");
		assert.equal(problem("\\int_{0}^{1}x"), "An integral needs its variable at the end, such as dx.");
		assert.equal(problem("\\int x\\,dx"), "An integral needs a lower and an upper limit.");
		assert.equal(problem("\\sum_{n}^{5}n"), "A sum needs a start such as n = 1 below it and an end above it.");
		assert.equal(problem("\\sum_{n=1}^{5}"), "Fill in what to add up.");
		assert.equal(problem("\\frac{d}{dx}"), "Fill in what to differentiate.");
		assert.equal(problem("\\mathbb{R}"), "\\mathbb is not something the grapher understands.");
		assert.equal(problem("\\frac{1}{x"), "There is an unmatched bracket.");
		// An unclosed round bracket is plain text's to report.
		assert.deepEqual(readLatex("\\left(x"), { text: "(x" });
		assert.deepEqual(readLatex("  "), { text: "" });
		assert.deepEqual(readLatex("x+1"), { text: "x+1" });
	});
});

describe("plain text → the editor's LaTeX", () => {
	it("typesets the usual forms", () => {
		assert.equal(textToLatex("y = x^2 + 1"), "y=x^{2}+1");
		assert.equal(textToLatex("(x+1)/(x-1)"), "\\frac{x+1}{x-1}");
		assert.equal(textToLatex("2x sin(x)"), "2x\\sin\\left(x\\right)");
		assert.equal(textToLatex("a*sin(x)"), "a\\sin\\left(x\\right)");
		assert.equal(textToLatex("x*2 + 2*3"), "x\\cdot 2+2\\cdot 3");
		assert.equal(textToLatex("sqrt(x) + root(x, 3) + |x|"), "\\sqrt{x}+\\sqrt[3]{x}+\\left|x\\right|");
		assert.equal(textToLatex("-(x+1)^2"), "-\\left(x+1\\right)^{2}");
		assert.equal(textToLatex("(x+1)(x-1)"), "\\left(x+1\\right)\\left(x-1\\right)");
		assert.equal(textToLatex("log(x, 2) + nCr(5, 2) + n!"), "\\log_{2}\\left(x\\right)+\\operatorname{nCr}\\left(5,2\\right)+n!");
		assert.equal(textToLatex("r = 1 + cos(theta)"), "r=1+\\cos\\left(\\theta\\right)");
		assert.equal(textToLatex("(1, 2), (3, 4)"), "\\left(1,2\\right),\\left(3,4\\right)");
		assert.equal(textToLatex("λ = 2pi"), "\\lambda=2\\pi");
	});

	it("typesets calculus and functions", () => {
		assert.equal(textToLatex("int(x^2, x, 0, 1)"), "\\int_{0}^{1}x^{2}\\,\\mathrm{d}x");
		assert.equal(textToLatex("int(t + 1, t, 0, x)"), "\\int_{0}^{x}\\left(t+1\\right)\\,\\mathrm{d}t");
		assert.equal(textToLatex("deriv(x^3, x)"), "\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left(x^{3}\\right)");
		assert.equal(textToLatex("sum(n^2, n, 1, 10)"), "\\sum_{n=1}^{10}n^{2}");
		assert.equal(textToLatex("2 sum(n, n, 1, 3)"), "2\\left(\\sum_{n=1}^{3}n\\right)");
		assert.equal(textToLatex("f(x) = x^2", new Set(["f"])), "f\\left(x\\right)=x^{2}");
		assert.equal(textToLatex("y = f'(x) + f(2x)", new Set(["f"])), "y=f'\\left(x\\right)+f\\left(2x\\right)");
		assert.equal(exprToLatex(parseExpr("prod(k, k, 1, 5)")), "\\prod_{k=1}^{5}k");
	});

	it("shows a line it cannot parse as it was written", () => {
		assert.equal(textToLatex("y = (x +"), "\\text{y = (x +}");
		assert.equal(textToLatex("50% of_x"), "\\text{50\\% of\\_x}");
		assert.equal(textToLatex("   "), "");
	});

	it("round-trips: what is typeset reads back as the same mathematics", () => {
		const scope = { x: 1.3, y: 0.7, a: 2, b: 3, k: 4, theta: 0.5, λ: 1.5 };
		const lines = [
			"x^2 + 2x + 1", "(x+1)/(x-1)", "-x^2", "(-x)^2", "2^x^2", "a sin(b x) + cos(x)^2", "sqrt(x^2 + y^2)", "root(x, 3) - |x - 2|", "x/y/2", "1/(2x)", "x^(1/3)", "(a+b)(a-b)",
			"ln(x) + log(x) + log(x, 2)", "asin(y) + acot(x) + sinh(x) atanh(y)", "5! + x!", "nCr(5, 2) + mod(7, 3) + gcd(12, 18)", "min(x, y) max(a, b)", "e^(-x^2) + 2pi theta + λ",
			"int(t^2, t, 0, x)", "int(sin(t) + 1, t, a, b)", "2 int(x, x, 0, 1) + 1", "deriv(x^3 - 2x, x)", "sum(n^2, n, 1, k)", "sum(sin(n x)/n, n, 1, 5) + 1", "prod(1 + x/n, n, 1, 4)",
			"x - (y - 1)", "x - -y", "a/(b/2)", "floor(x) + ceil(y) + round(a x) + sign(-x)", "(x+1)^(y-1)",
		];
		for (const line of lines) {
			const back = latexToText(textToLatex(line));
			close(value(back, scope), value(line, scope), 1e-9, `${line} → ${textToLatex(line)} → ${back}`);
		}
	});

	it("the tutor still reads plain text: an outline is the text, not LaTeX", () => {
		const d = doc(["y = int(sin(t^2), t, 0, x)", "f(x) = x^2", "f'(2)"]);
		d.lines[0]!.latex = "y=\\int_{0}^{x}\\sin\\left(t^{2}\\right)\\,\\mathrm{d}t";
		assert.equal(plotOutline(d).split("\n").slice(0, 3).join("\n"), "1. y = int(sin(t^2), t, 0, x)\n2. f(x) = x^2\n3. f'(2) (= 4)");
	});
});

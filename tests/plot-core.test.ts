/**
 * The grapher's core (fork, phase 5b — FORK.md): the expression language,
 * how a line is understood, sampling, and the outline the tutor reads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	cleanPlotDoc, compile, DEFAULT_VIEW, emptyPlotDoc, ExprError, MAX_PLOT_LINES, nextLineId, niceStep, parseExpr, PLOT_RULE, plotOutline, plotOutlineBlock, resolvePlot,
	sampleFunction, sampleImplicit, sampleParametric, samplePolar, squareView, tickLabel, ticks, tokenize, variablesOf, withSliderValue, zoomView,
	type PlotDoc, type ResolvedLine,
} from "../src/core/plot/index.ts";

const value = (source: string, scope: Record<string, number> = {}) => compile(parseExpr(source))(scope);
const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≉ ${expected}`);
const doc = (lines: string[], extra: Partial<PlotDoc> = {}): PlotDoc => ({ type: "plot", mode: "2d", lines: lines.map((text, i) => ({ id: `l${i + 1}`, text })), view: { ...DEFAULT_VIEW }, ...extra });
const kinds = (lines: string[]) => resolvePlot(doc(lines)).lines.map((line) => line.kind);
const errorOf = (line: string, before: string[] = []) => {
	const resolved = resolvePlot(doc([...before, line])).lines.at(-1)!;
	return resolved.kind === "error" ? resolved.error : `(no error: ${resolved.kind})`;
};

describe("the expression language", () => {
	it("follows the usual order of operations", () => {
		near(value("1 + 2 * 3"), 7);
		near(value("(1 + 2) * 3"), 9);
		near(value("2^3^2"), 512);
		near(value("-2^2"), -4);
		near(value("(-2)^2"), 4);
		near(value("2^-1"), 0.5);
		near(value("6 / 2 / 3"), 1);
		near(value("1 - 2 - 3"), -4);
		near(value("- -3"), 3);
		near(value(".5 + 1.5e2"), 150.5);
	});

	it("multiplies what is written side by side", () => {
		near(value("2x", { x: 3 }), 6);
		near(value("ax^2", { a: 2, x: 3 }), 18);
		near(value("x(x+1)", { x: 3 }), 12);
		near(value("(x+1)(x-1)", { x: 3 }), 8);
		near(value("2(3)"), 6);
		near(value("xy", { x: 2, y: 5 }), 10);
		near(value("2pi"), 2 * Math.PI);
		near(value("2e"), 2 * Math.E);
		near(value("xe^x", { x: 1 }), Math.E);
		near(value("1/2x", { x: 4 }), 2, "1/2x reads left to right, as on a calculator");
	});

	it("knows functions, with or without parentheses", () => {
		near(value("sin(pi/2)"), 1);
		near(value("sin x", { x: Math.PI / 2 }), 1);
		near(value("sin 2x", { x: Math.PI / 4 }), 1);
		near(value("sin x + 1", { x: 0 }), 1);
		near(value("2sin(x)cos(x)", { x: 1 }), Math.sin(2));
		near(value("sqrt(16) + abs(-3) + |x - 5|", { x: 2 }), 10);
		near(value("|x| + |y|", { x: -1, y: -2 }), 3);
		near(value("ln(e) + log(100) + exp(0)"), 4);
		near(value("max(1, 5, 3) - min(4, 2)"), 3);
		near(value("arctan(1) + atan(1)"), Math.PI / 2);
		near(value("floor(2.7) + ceil(2.1) + round(2.5) + sign(-4)"), 7);
	});

	it("reads typed symbols and takes real odd roots of negatives", () => {
		near(value("2π"), 2 * Math.PI);
		near(value("3 × 4 ÷ 2 − 1"), 5);
		near(value("√(9)"), 3);
		near(value("cos θ", { theta: 0 }), 1);
		near(value("(-8)^(1/3)"), -2);
		assert.ok(Number.isNaN(value("(-8)^(1/2)")));
		assert.ok(Number.isNaN(value("q")), "an unknown variable has no value");
	});

	it("lists the variables an expression uses, without constants", () => {
		assert.deepEqual([...variablesOf(parseExpr("a sin(bx) + pi + e + theta"))].sort(), ["a", "b", "theta", "x"]);
		assert.deepEqual(tokenize("asin(x)").map((t) => ("name" in t ? t.name : "op" in t ? t.op : t.value)), ["asin", "(", "x", ")"]);
	});

	it("says what is wrong in plain words", () => {
		const message = (source: string) => {
			try {
				parseExpr(source);
				return "(parsed)";
			} catch (error) {
				assert.ok(error instanceof ExprError);
				return error.message;
			}
		};
		assert.equal(message("2 +"), "The expression ends too soon.");
		assert.equal(message("(1 + 2"), 'Expected ")".');
		assert.equal(message("2 $ 3"), '"$" is not something the grapher understands.');
		assert.equal(message("sin"), "sin needs something to apply to.");
		assert.equal(message("sqrt(1, 2)"), "sqrt takes 1 value.");
		assert.equal(message("1 2 )"), "That expression has something extra at the end.");
		assert.equal(message(""), "Nothing to graph.");
		assert.equal(message("[[1, 2], [3]]"), "Every row of a matrix needs the same number of entries.");
		assert.equal(message("1, 2"), "Expected one expression, not a list.");
		assert.deepEqual(parseExpr("[[1, 2], [3, 4]]").type, "matrix");
	});
});

describe("how a line is understood", () => {
	it("tells the kinds of curve apart", () => {
		assert.deepEqual(kinds(["y = sin(x)", "x^2 - 1", "x = y^2", "x^2 + y^2 = 9", "(cos(t), sin(2t))", "r = 1 + cos(theta)", "(1, 2), (3, 4)", "a = 2", "", "y = ax"]), [
			"explicit-y", "explicit-y", "explicit-x", "implicit", "parametric", "polar", "points", "definition", "empty", "explicit-y",
		]);
		assert.deepEqual(kinds(["y = x + y", "x = x^2 + y", "5", "y^2 = x"]), ["implicit", "implicit", "explicit-y", "implicit"]);
	});

	it("lets curves use definitions, whichever line they are on", () => {
		const resolved = resolvePlot(doc(["y = a x^2 + b", "a = 2", "b = a + 1", "c = -4", "(a, b)"]));
		assert.deepEqual(resolved.scope, { a: 2, b: 3, c: -4 });
		const defs = resolved.lines.filter((line): line is Extract<ResolvedLine, { kind: "definition" }> => line.kind === "definition");
		assert.deepEqual(defs.map((d) => [d.name, d.value, d.slider]), [["a", 2, true], ["b", 3, false], ["c", -4, true]]);
		const curve = resolved.lines[0] as unknown as { fn: (scope: Record<string, number>) => number };
		near(curve.fn({ ...resolved.scope, x: 2 }), 11);
		assert.deepEqual((resolved.lines[4] as Extract<ResolvedLine, { kind: "points" }>).points, [[2, 3]]);
	});

	it("explains what it cannot graph", () => {
		assert.equal(errorOf("y = k x"), '"k" is not defined. Add a line such as k = 1.');
		assert.equal(errorOf("y < 2x"), "Inequalities are not supported yet.");
		assert.equal(errorOf("y = x = 2"), "Use one = sign.");
		assert.equal(errorOf("f(x) = x^2"), "Write this as y = … (function definitions like f(x) = … are not supported yet).");
		assert.match(errorOf("sin(x) = "), /missing on one side/);
		assert.equal(errorOf("(1, 2, 3)"), "A point needs two coordinates here; 3D arrives in a later version.");
		assert.equal(errorOf("[[1, 0], [0, 1]]"), "Matrices arrive in a later version of the grapher.");
		assert.equal(errorOf("y^2"), "Write this as an equation, such as x = … or y = ….");
		assert.equal(errorOf("a = 3", ["a = 2"]), '"a" is already defined above.');
		assert.equal(errorOf("r = x + 1"), '"r" cannot be used in this kind of expression.');
		assert.equal(errorOf("(cos(t), y)"), '"y" cannot be used in this kind of expression.');
		assert.equal(errorOf("b = 2a"), '"a" is not defined. Add a line such as a = 1.');
	});

	it("a dragged slider rewrites its line's number", () => {
		const d = doc(["y = a x", "a = 2"]);
		assert.equal(withSliderValue(d, "l2", -3.14159265).lines[1]!.text, "a = -3.1416");
		assert.equal(withSliderValue(d, "l2", 5).lines[0]!.text, "y = a x");
	});
});

describe("sampling curves", () => {
	const fn = (source: string) => compile(parseExpr(source));

	it("breaks a function at undefined values and at asymptotes", () => {
		const line = sampleFunction(fn("2x + 1"), {}, "x", -1, 1, 4, 20);
		assert.deepEqual(line, [[[-1, -1], [-0.5, 0], [0, 1], [0.5, 2], [1, 3]]]);
		const root = sampleFunction(fn("sqrt(x)"), {}, "x", -2, 2, 8, 20);
		assert.equal(root.length, 1);
		assert.equal(root[0]![0]![0], 0);
		assert.ok(sampleFunction(fn("tan(x)"), {}, "x", -4, 4, 400, 20).length >= 3, "tan x is not joined across its asymptotes");
		assert.ok(sampleFunction(fn("1/x"), {}, "x", -3, 3, 300, 20).length >= 2);
		assert.equal(sampleFunction(fn("a x"), { a: 3 }, "x", 0, 1, 1, 20)[0]![1]![1], 3);
	});

	it("traces parametric and polar curves", () => {
		const circle = sampleParametric(fn("cos(t)"), fn("sin(t)"), {}, 0, 2 * Math.PI, 64)[0]!;
		assert.equal(circle.length, 65);
		for (const [x, y] of circle) near(Math.hypot(x, y), 1);
		const cardioid = samplePolar(fn("1 + cos(theta)"), {}, 0, 2 * Math.PI, 8)[0]!;
		near(cardioid[0]![0], 2);
		near(cardioid[4]![0], 0);
		assert.equal(sampleParametric(fn("1/t"), fn("t"), {}, -1, 1, 2).length, 0, "a curve cut into single points draws nothing");
	});

	it("finds an implicit curve where the two sides cross", () => {
		const view = { xMin: -4, xMax: 4, yMin: -4, yMax: 4 };
		const circle = sampleImplicit(fn("x^2 + y^2 - 9"), {}, view, 80, 80);
		assert.ok(circle.length > 100);
		for (const [a, b] of circle) for (const [x, y] of [a, b]) assert.ok(Math.abs(Math.hypot(x, y) - 3) < 0.02, `(${x}, ${y}) is not on the circle`);
		assert.equal(sampleImplicit(fn("x^2 + y^2 + 1"), {}, view, 40, 40).length, 0, "no real points, no curve");
		assert.equal(sampleImplicit(fn("1/x"), {}, view, 41, 41).length, 0, "a pole is not a root");
	});

	it("picks round grid lines and tidy labels", () => {
		assert.deepEqual([niceStep(20, 10), niceStep(7, 10), niceStep(0.3, 10), niceStep(1300, 10)], [2, 0.5, 0.02, 100]);
		assert.deepEqual(ticks(-1, 1, 4), [-1, -0.5, 0, 0.5, 1]);
		assert.deepEqual(ticks(-0.3, 0.3, 6).map((t) => tickLabel(t, 0.1)), ["-0.3", "-0.2", "-0.1", "0", "0.1", "0.2", "0.3"]);
		assert.equal(tickLabel(2500000, 500000), "2.5e+6");
		assert.equal(tickLabel(1500, 500), "1500");
	});

	it("zooms about a point and squares a view to its canvas", () => {
		assert.deepEqual(zoomView({ xMin: -10, xMax: 10, yMin: -10, yMax: 10 }, 5, 0, 0.5), { xMin: -2.5, xMax: 7.5, yMin: -5, yMax: 5 });
		assert.deepEqual(squareView({ xMin: -10, xMax: 10, yMin: -10, yMax: 10 }, 800, 400), { xMin: -10, xMax: 10, yMin: -5, yMax: 5 });
	});
});

describe("a graph document", () => {
	it("is cleaned and bounded when it comes from outside", () => {
		assert.equal(cleanPlotDoc(null), null);
		assert.equal(cleanPlotDoc({ lines: "no" }), null);
		const cleaned = cleanPlotDoc({
			title: "  Parabolas  ", tMin: 0, tMax: 6,
			lines: [{ id: "bad id!", text: "y = x^2", color: 11, hidden: true }, { text: "a = 1", min: -2, max: 2 }, { text: "b = 1", min: 5, max: 1 }, { nope: 1 }, "junk"],
			view: { xMin: -2, xMax: 2, yMin: 5, yMax: 5 },
		})!;
		assert.deepEqual(cleaned, {
			type: "plot", mode: "2d", title: "Parabolas",
			lines: [{ id: "l1", text: "y = x^2", color: 3, hidden: true }, { id: "l2", text: "a = 1", color: 1, min: -2, max: 2 }, { id: "l3", text: "b = 1", color: 2 }],
			view: { xMin: -2, xMax: 2, yMin: -10, yMax: 10 },
			tMin: 0, tMax: 6,
		});
		assert.equal(cleanPlotDoc({ lines: Array.from({ length: 80 }, () => ({ text: "x" })) })!.lines.length, MAX_PLOT_LINES);
		assert.equal(cleanPlotDoc({ lines: [{ text: "x".repeat(900) }] })!.lines[0]!.text.length, 300);
		assert.deepEqual(emptyPlotDoc().lines, [{ id: "l1", text: "", color: 0 }]);
		assert.equal(nextLineId(doc(["a", "b"])), "l3");
	});

	it("reads to the tutor as its expressions, slider ranges and view", () => {
		const d = doc(["y = a*x^2", "a = 2", "", "(1, 2)", "y = k"], { view: { xMin: -10, xMax: 10, yMin: -6.5, yMax: 6.5 } });
		d.lines[3]!.hidden = true;
		assert.equal(plotOutline(d), [
			"1. y = a*x^2",
			"2. a = 2 (slider, from -10 to 10)",
			"3. (1, 2) (hidden)",
			'4. y = k (could not be read: "k" is not defined. Add a line such as k = 1.)',
			"View: x from -10 to 10, y from -6.5 to 6.5",
		].join("\n"));
		assert.equal(plotOutline(doc(["", "  "])), "");
		assert.equal(plotOutlineBlock("1. y = x"), "The learner's graph, as they entered it. The picture shows the view they had when they sent it.\n\n1. y = x");
		assert.match(PLOT_RULE, /Judge those expressions and slider values; use the picture only to see the view they chose\.$/);
	});
});

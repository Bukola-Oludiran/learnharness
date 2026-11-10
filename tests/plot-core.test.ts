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
		assert.equal(errorOf("(1, 2, 3)"), "A point with three coordinates needs a 3D graph.");
		assert.equal(errorOf("(1, 2, 3, 4)"), "A point needs two coordinates.");
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

// ── Phase 5c: 3D ────────────────────────────────────────────────────────────
const { cleanBox, curve3, DEFAULT_BOX, implicitMesh, paramSurfaceMesh, surfaceMesh, withMode } = await import("../src/core/plot/index.ts");
const { graphDocOf, graphResultText } = await import("../src/agent/tools/plot.ts");

const doc3 = (lines: string[], extra: Partial<PlotDoc> = {}): PlotDoc => ({ ...doc(lines), mode: "3d", box: { ...DEFAULT_BOX }, ...extra });
const kinds3 = (lines: string[]) => resolvePlot(doc3(lines)).lines.map((line) => line.kind);
const resolved3 = (line: string, before: string[] = []) => resolvePlot(doc3([...before, line])).lines.at(-1)!;

describe("lines on a 3D graph", () => {
	it("tells surfaces, implicit surfaces, curves and points apart", () => {
		assert.deepEqual(kinds3(["z = x^2 + y^2", "sin(x) cos(y)", "x = y^2 - z^2", "y = x + z", "x^2 + y^2 + z^2 = 9", "2x + y - z = 4", "x^2 + y^2 = 4", "(cos(t), sin(t), t)", "(u cos(v), u sin(v), v)", "(1, 2, 3), (0, 0, 0)", "a = 2", "z = a x"]), [
			"surface", "surface", "surface", "surface", "implicit3", "implicit3", "implicit3", "curve3", "param-surface", "points3", "definition", "surface",
		]);
		const axes = ["z = x y", "x = y z", "y = x z"].map((line) => (resolved3(line) as { axis: string }).axis);
		assert.deepEqual(axes, ["z", "x", "y"]);
		assert.deepEqual((resolved3("(a, 2a, 3)", ["a = 2"]) as { points: number[][] }).points, [[2, 4, 3]]);
	});

	it("the same line means different things in the two modes", () => {
		assert.equal(kinds(["x^2 + y^2 = 4"])[0], "implicit");
		assert.equal(kinds3(["x^2 + y^2 = 4"])[0], "implicit3");
		assert.equal(kinds(["y = x^2"])[0], "explicit-y");
		assert.equal(kinds3(["y = x^2"])[0], "surface");
		assert.equal(kinds(["u = 2"])[0], "definition", "u is an ordinary letter on a flat graph");
	});

	it("a line for the other mode says so and names the fix", () => {
		const in2d = (line: string) => resolvePlot(doc([line])).lines[0]!;
		assert.deepEqual(in2d("z = x^2 + y^2"), { id: "l1", kind: "error", error: "This uses z, so it needs a 3D graph.", fix: "3d" });
		assert.deepEqual(in2d("x^2 + y^2 + z^2 = 9"), { id: "l1", kind: "error", error: "This uses z, so it needs a 3D graph.", fix: "3d" });
		assert.deepEqual(in2d("x + z"), { id: "l1", kind: "error", error: "This uses z, so it needs a 3D graph.", fix: "3d" });
		assert.deepEqual(in2d("(1, 2, 3)"), { id: "l1", kind: "error", error: "A point with three coordinates needs a 3D graph.", fix: "3d" });
		assert.deepEqual(resolved3("r = 1 + cos(theta)"), { id: "l1", kind: "error", error: "Polar curves only work on a 2D graph.", fix: "2d" });
		assert.deepEqual(resolved3("(1, 2)"), { id: "l1", kind: "error", error: "A point with two coordinates belongs on a 2D graph; here a point needs three.", fix: "2d" });
		const plain = resolved3("z = k x") as { error: string; fix?: string };
		assert.equal(plain.error, '"k" is not defined. Add a line such as k = 1.');
		assert.equal(plain.fix, undefined);
		assert.equal((resolved3("x + z") as { error: string }).error, "Write this as an equation, such as z = … or … = 0.");
		assert.equal((resolved3("(t, u, 1)") as { kind: string }).kind, "error", "a tuple cannot mix a curve's t with a surface's u");
		assert.equal((resolved3("u = 2") as { error: string }).error, '"u" cannot be used in this kind of expression.');
	});

	it("switching mode keeps the lines and gives a 3D graph its box", () => {
		const flat = doc(["y = x^2"]);
		const lifted = withMode(flat, "3d");
		assert.deepEqual([lifted.mode, lifted.box, lifted.lines, lifted.view], ["3d", DEFAULT_BOX, flat.lines, flat.view]);
		assert.equal(withMode(lifted, "3d"), lifted);
		const back = withMode({ ...lifted, box: { ...DEFAULT_BOX, zMax: 9 } }, "2d");
		assert.deepEqual([back.mode, back.box!.zMax], ["2d", 9], "the box is kept for the way back");
	});
});

describe("sampling 3D graphs", () => {
	const fn = (source: string) => compile(parseExpr(source));
	const box = { ...DEFAULT_BOX };
	const vertices = (positions: number[]) => Array.from({ length: positions.length / 3 }, (_, i) => positions.slice(i * 3, i * 3 + 3) as [number, number, number]);

	it("a surface is a grid of triangles on the function, whichever coordinate it gives", () => {
		const paraboloid = surfaceMesh(fn("x^2 + y^2"), "z", {}, { ...box, zMax: 60 }, 8);
		assert.equal(paraboloid.positions.length, 81 * 3);
		assert.equal(paraboloid.indices.length, 64 * 6);
		for (const [x, y, z] of vertices(paraboloid.positions)) near(z, x * x + y * y);
		for (const [x, y, z] of vertices(surfaceMesh(fn("y + z"), "x", {}, box, 4).positions)) near(x, y + z);
		for (const [x, y, z] of vertices(surfaceMesh(fn("a x - z"), "y", { a: 2 }, box, 4).positions)) near(y, 2 * x - z);
	});

	it("leaves holes where a surface is undefined or runs off to infinity", () => {
		const root = surfaceMesh(fn("sqrt(x)"), "z", {}, box, 8);
		assert.ok(root.indices.length > 0 && root.indices.length < 64 * 6, "only the half with x ≥ 0 is drawn");
		const pole = surfaceMesh(fn("1/(x^2 + y^2)"), "z", {}, box, 8);
		assert.ok(pole.indices.length < 64 * 6, "the spike at the origin is cut out");
	});

	it("traces parametric surfaces and space curves", () => {
		const sphere = paramSurfaceMesh(fn("2sin(u)cos(v)"), fn("2sin(u)sin(v)"), fn("2cos(u)"), {}, [0, Math.PI], [0, 2 * Math.PI], 12);
		for (const [x, y, z] of vertices(sphere.positions)) near(Math.hypot(x, y, z), 2);
		const helix = curve3(fn("cos(t)"), fn("sin(t)"), fn("t"), {}, 0, 4, 40);
		assert.equal(helix.length, 1);
		assert.equal(helix[0]!.length, 41);
		assert.deepEqual(helix[0]!.at(-1)!.map((v) => Math.round(v * 1e6) / 1e6), [Math.round(Math.cos(4) * 1e6) / 1e6, Math.round(Math.sin(4) * 1e6) / 1e6, 4]);
		assert.equal(curve3(fn("1/t"), fn("t"), fn("t"), {}, -1, 1, 2).length, 0);
	});

	it("finds an implicit surface, wound and shaded along the gradient", () => {
		const sphere = implicitMesh(fn("x^2 + y^2 + z^2 - 9"), {}, box, 20);
		assert.ok(sphere.indices.length > 600);
		for (const [x, y, z] of vertices(sphere.positions)) assert.ok(Math.abs(Math.hypot(x, y, z) - 3) < 0.06, `(${x}, ${y}, ${z}) is not on the sphere`);
		const normals = vertices(sphere.normals!);
		for (const [i, [x, y, z]] of vertices(sphere.positions).entries()) {
			const [nx, ny, nz] = normals[i]!;
			assert.ok((nx * x + ny * y + nz * z) / 3 > 0.98, "the normal points outward, along the gradient");
		}
		// Every triangle faces outward too.
		const p = vertices(sphere.positions);
		for (let t = 0; t < sphere.indices.length; t += 3) {
			const [a, b, c] = [p[sphere.indices[t]!]!, p[sphere.indices[t + 1]!]!, p[sphere.indices[t + 2]!]!];
			const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
			assert.ok(n[0]! * a[0] + n[1]! * a[1] + n[2]! * a[2] >= -1e-9);
		}
		const plane = implicitMesh(fn("x + y + z - 2"), {}, box, 10);
		for (const [x, y, z] of vertices(plane.positions)) near(x + y + z, 2);
		assert.equal(implicitMesh(fn("x^2 + y^2 + z^2 + 1"), {}, box, 10).indices.length, 0, "no real points, no surface");
		assert.equal(implicitMesh(fn("1/x"), {}, box, 11).indices.length, 0, "a pole is not a root");
	});
});

describe("a 3D graph document", () => {
	it("is cleaned with its box and parameter ranges", () => {
		const cleaned = cleanPlotDoc({ mode: "3d", lines: [{ text: "z = x y" }], box: { xMin: -2, xMax: 2, yMin: 3, yMax: 3, zMin: 0, zMax: 8 }, uMin: 0, uMax: 1, vMin: 5, vMax: 1 })!;
		assert.deepEqual([cleaned.mode, cleaned.box, cleaned.uMin, cleaned.uMax, cleaned.vMin], ["3d", { xMin: -2, xMax: 2, yMin: -5, yMax: 5, zMin: 0, zMax: 8 }, 0, 1, undefined]);
		assert.deepEqual(cleanPlotDoc({ mode: "3d", lines: [] })!.box, DEFAULT_BOX);
		assert.equal(cleanPlotDoc({ mode: "4d", lines: [] })!.mode, "2d");
		assert.equal("box" in cleanPlotDoc({ lines: [] })!, false);
		assert.deepEqual(cleanBox(null), DEFAULT_BOX);
	});

	it("reads to the tutor as a 3D graph with its box", () => {
		assert.equal(plotOutline(doc3(["z = a(x^2 + y^2)", "a = 0.5", "x + y + z = 3"])), [
			"3D graph.", "1. z = a(x^2 + y^2)", "2. a = 0.5 (slider, from -10 to 10)", "3. x + y + z = 3", "Box: x from -5 to 5, y from -5 to 5, z from -5 to 5",
		].join("\n"));
	});

	it("the tutor's tool builds 3D graphs when dimension is 3", () => {
		const built = graphDocOf({ expressions: ["z = x^2 + y^2", "(u cos(v), u sin(v), v)"], dimension: 3, xMin: -2, xMax: 2, zMin: 0, zMax: 8, uMin: 0, uMax: 3 });
		assert.deepEqual([built.mode, built.box, built.uMin, built.uMax, built.view], ["3d", { xMin: -2, xMax: 2, yMin: -5, yMax: 5, zMin: 0, zMax: 8 }, 0, 3, { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }]);
		assert.equal(graphResultText(built), "Graph shown to the learner: 2 expressions.");
		assert.equal(graphDocOf({ expressions: ["y = x"], xMin: -2, xMax: 2 }).mode, "2d");
		// A 3D line on a flat graph comes back to the tutor as unreadable, with the reason.
		assert.throws(() => graphResultText(graphDocOf({ expressions: ["z = x^2 + y^2"] })), /This uses z, so it needs a 3D graph\./);
	});
});

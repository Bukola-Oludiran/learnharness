/**
 * Vectors and matrices in the grapher (fork, phase 5d-1 — FORK.md): the
 * evaluator's rules, how lines of them are understood and read back to the
 * tutor, the two spellings, dragging, the keypad tab and the tool wording.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	DEFAULT_VIEW, det, formatResult, inverse, latexToText, parseExpr, plotOutline, resolvePlot, spanBasis, textToLatex, tokenize, withVectorValue,
	type PlotDoc, type ResolvedLine,
} from "../src/core/plot/index.ts";
import { createGraphTool, graphDocOf, graphResultText } from "../src/agent/tools/plot.ts";

const doc = (lines: string[], extra: Partial<PlotDoc> = {}): PlotDoc => ({ type: "plot", mode: "2d", lines: lines.map((text, i) => ({ id: `l${i + 1}`, text })), view: { ...DEFAULT_VIEW }, ...extra });
const last = (lines: string[], extra: Partial<PlotDoc> = {}) => resolvePlot(doc(lines, extra)).lines.at(-1)!;
const result = (lines: string[], extra: Partial<PlotDoc> = {}) => {
	const line = last(lines, extra) as ResolvedLine & { value?: number | number[] | number[][]; error?: string };
	if (line.kind === "error") return `error: ${line.error}`;
	return formatResult(line.value!);
};
const UV = ["u = (2, 1)", "v = (1, 3)"];
const A = "A = [[1, 2], [3, 4]]";
const noop = () => {};

describe("vector and matrix arithmetic", () => {
	it("adds, scales and multiplies with the usual rules", () => {
		assert.equal(result([...UV, "u + v"]), "(3, 4)");
		assert.equal(result([...UV, "2u - v"]), "(3, -1)");
		assert.equal(result([...UV, "-u / 2"]), "(-1, -0.5)");
		assert.equal(result([...UV, "dot(u, v)"]), "5");
		assert.equal(result([...UV, "u · v"]), "5");
		assert.equal(result([...UV, "u * v"]), "5");
		assert.equal(result([...UV, "|u|^2"]), "5");
		assert.equal(result(["norm((3, 4))"]), "5");
		assert.equal(result([...UV, A, "A v"]), "(7, 15)");
		assert.equal(result([A, "A A"]), "[[7, 10], [15, 22]]");
		assert.equal(result([A, "A^2"]), "[[7, 10], [15, 22]]");
		assert.equal(result([A, "A^-1"]), "[[-2, 1], [1.5, -0.5]]");
		assert.equal(result([A, "inv(A) A"]), "[[1, 0], [0, 1]]");
		assert.equal(result([A, "A^0"]), "[[1, 0], [0, 1]]");
		assert.equal(result([A, "A^T"]), "[[1, 3], [2, 4]]");
		assert.equal(result([A, "transpose(A)"]), "[[1, 3], [2, 4]]");
		assert.equal(result([A, "det(A)"]), "-2");
		assert.equal(result([A, "trace(A)"]), "5");
		assert.equal(result([A, "2A - A"]), "[[1, 2], [3, 4]]");
		assert.equal(result([A, "B = [[0, 1], [1, 0]]", "A B"]), "[[2, 1], [4, 3]]");
		assert.equal(result([A, "[[1, 0, 2], [0, 1, 0]] (1, 2, 3)"], { mode: "2d" }), "(7, 2)", "a 2 × 3 matrix takes three entries to two");
	});

	it("takes the cross product with ×, and plain multiplication between numbers", () => {
		const three = { mode: "3d" as const };
		assert.equal(result(["u = (1, 0, 0)", "v = (0, 1, 0)", "u × v"], three), "(0, 0, 1)");
		assert.equal(result(["u = (1, 2, 3)", "v = (4, 5, 6)", "cross(u, v)"], three), "(-3, 6, -3)");
		assert.equal(result(["2 × 3"]), "6");
		assert.equal(result([...UV, "u × v"]), "error: The cross product needs two vectors with three entries each.");
	});

	it("reads [1, 2] and a single column as vectors, and A^T only where T is not a slider", () => {
		assert.equal(result([A, "A [1, 1]"]), "(3, 7)");
		assert.equal(result([A, "A [[1], [1]]"]), "(3, 7)");
		assert.equal(result(["T = 2", "3^T"]), "9");
		assert.equal(result(["E = [[2, 0], [0, 2]]", "det(E)"]), "4", "a capital E is a name, not the constant e");
		assert.ok(Math.abs((last(["e^1"]) as { value: number }).value - Math.E) < 1e-12);
	});

	it("says what does not fit, in the learner's words", () => {
		assert.equal(result([...UV, A, "u + A"]), "error: A vector with 2 entries and a 2 × 2 matrix cannot be added.");
		assert.equal(result([A, "A (1, 2, 3)"]), "error: A 2 × 2 matrix needs a vector with 2 entries; this one has 3.");
		assert.equal(result([...UV, A, "u A"]), "error: Write the matrix first and the vector after it, as in A v.");
		assert.equal(result(["B = [[1, 2], [2, 4]]", "B^-1"]), "error: This matrix has no inverse: its determinant is 0.");
		assert.equal(result(["det([[1, 2, 3], [4, 5, 6]])"]), "error: det needs a square matrix; this one is 2 × 3.");
		assert.equal(result([...UV, "u^2"]), "error: A vector cannot be raised to a power; use dot(v, v) for its length squared.");
		assert.equal(result([A, "|A|"]), "error: For a matrix, write det(A) for its determinant.");
		assert.equal(result([...UV, "u + w"]), 'error: "w" is not defined. Add a line such as w = 1.');
		assert.equal(result([...UV, "u = (0, 0)"]), 'error: "u" is already defined above.');
		assert.equal(result([...UV, "s = span(u)"]), "error: span(…) goes on a line of its own.");
	});

	it("finds determinants, inverses and spans numerically", () => {
		assert.ok(Math.abs(det([[2, 0, 0], [0, 3, 0], [0, 0, 4]]) - 24) < 1e-12);
		assert.ok(Math.abs(det([[0, 1], [1, 0]]) + 1) < 1e-12, "a row swap flips the sign");
		assert.equal(det([[1, 2], [2, 4]]), 0);
		assert.deepEqual(inverse([[0, 1], [1, 0]]), [[0, 1], [1, 0]]);
		assert.equal(spanBasis([[1, 2], [2, 4]]).length, 1);
		assert.equal(spanBasis([[1, 0, 0], [0, 1, 0], [1, 1, 0]]).length, 2);
		assert.equal(spanBasis([[0, 0]]).length, 0);
	});
});

describe("lines of vectors and matrices", () => {
	it("a named vector is an arrow, an unnamed tuple stays a point", () => {
		const resolved = resolvePlot(doc(["v = (2, 1)", "(2, 1)", "w = (a, 1)", "a = 2"]));
		assert.deepEqual(resolved.lines[0], { id: "l1", kind: "vector", name: "v", value: [2, 1], literal: true, draggable: true });
		assert.equal(resolved.lines[1]!.kind, "points");
		// A slider inside a vector, written below it: followed, and not draggable.
		assert.deepEqual(resolved.lines[2], { id: "l3", kind: "vector", name: "w", value: [2, 1], literal: false, draggable: false });
	});

	it("a sum carries its first vector, so the second can be drawn from its tip", () => {
		assert.deepEqual(last([...UV, "u + v"]), { id: "l3", kind: "vector", value: [3, 4], literal: false, draggable: false, guide: { from: [2, 1] } });
		assert.deepEqual((last([...UV, "w = u + v"]) as { guide?: unknown; name?: string }).guide, { from: [2, 1] });
		assert.equal((last([...UV, "u - v"]) as { guide?: unknown }).guide, undefined);
	});

	it("a number worked out from vectors is a value, or a definition others can use", () => {
		assert.deepEqual(last([A, "det(A)"]), { id: "l2", kind: "value", value: -2 });
		assert.deepEqual(last([A, "d = det(A)"]), { id: "l2", kind: "definition", name: "d", value: -2, slider: false });
		const curve = last([...UV, "y = norm(u) x"]) as { kind: string; fn: (scope: Record<string, number>) => number };
		assert.equal(curve.kind, "explicit-y");
		assert.ok(Math.abs(curve.fn({ x: 2 }) - 2 * Math.sqrt(5)) < 1e-12);
	});

	it("spans are a line, a plane, or everything", () => {
		assert.equal((last([...UV, "span(u)"]) as { note: string }).note, "a line through the origin");
		assert.equal((last([...UV, "span(u, v)"]) as { note: string }).note, "the whole plane");
		assert.equal((last([...UV, "span(u, 2u)"]) as { note: string }).note, "a line through the origin");
		assert.equal((last(["span((0, 0))"]) as { note: string }).note, "only the origin");
		const three = { mode: "3d" as const };
		const plane = last(["u = (1, 0, 0)", "v = (0, 1, 0)", "span(u, v)"], three) as { note: string; basis: number[][] };
		assert.equal(plane.note, "a plane through the origin");
		assert.deepEqual(plane.basis, [[1, 0, 0], [0, 1, 0]]);
		assert.equal((last(["span((1, 0, 0), (0, 1, 0), (0, 0, 2))"], three) as { note: string }).note, "all of 3D space");
	});

	it("a vector made for the other mode says so; in 3D u and v can be names and still be a surface's parameters", () => {
		assert.deepEqual(last(["q = (1, 2, 3)"]), { id: "l1", kind: "error", error: "A vector with three entries needs a 3D graph.", fix: "3d" });
		assert.equal(result(["q = (1, 2, 3)", "dot(q, q)"]), "14", "still usable in a calculation");
		const three = { mode: "3d" as const };
		assert.deepEqual(last(["w = (1, 2)"], three), { id: "l1", kind: "error", error: "A vector with two entries belongs on a 2D graph.", fix: "2d" });
		const resolved = resolvePlot(doc(["u = (1, 0, 0)", "v = (0, 1, 0)", "(u cos(v), u sin(v), v)"], three));
		assert.equal(resolved.lines[0]!.kind, "vector");
		const surface = resolved.lines[2] as { kind: string; x: (scope: Record<string, number>) => number };
		assert.equal(surface.kind, "param-surface");
		assert.ok(Math.abs(surface.x({ u: 2, v: 0 }) - 2) < 1e-12);
	});

	it("reads back to the tutor with each result, as approved", () => {
		assert.equal(
			plotOutline(doc([...UV, "u + v", A, "det(A)", "A v", "A^2", "span(u, v)", "u + A"])),
			[
				"1. u = (2, 1)",
				"2. v = (1, 3)",
				"3. u + v (= (3, 4))",
				"4. A = [[1, 2], [3, 4]]",
				"5. det(A) (= -2)",
				"6. A v (= (7, 15))",
				"7. A^2 (= [[7, 10], [15, 22]])",
				"8. span(u, v) (= the whole plane)",
				"9. u + A (could not be read: A vector with 2 entries and a 2 × 2 matrix cannot be added.)",
				"View: x from -10 to 10, y from -10 to 10",
			].join("\n"),
		);
	});

	it("a dragged tip rewrites the vector's numbers and nothing else", () => {
		const before = { ...doc(["v = (2, 1)", "2v"]), lines: [{ id: "l1", text: "v = (2, 1)", latex: "v=\\left(2,1\\right)", color: 3 }, { id: "l2", text: "2v" }] };
		const after = withVectorValue(before, "l1", [-1.5, 4]);
		assert.deepEqual(after.lines, [{ id: "l1", text: "v = (-1.5, 4)", color: 3 }, { id: "l2", text: "2v" }]);
		assert.deepEqual((resolvePlot(after).lines[1] as { value: number[] }).value, [-3, 8]);
	});
});

describe("the two spellings of vectors and matrices", () => {
	it("reads the editor's grids, products and decorations", () => {
		assert.equal(latexToText("A=\\begin{bmatrix}1 & 2\\\\ 3 & 4\\end{bmatrix}"), "A=[[1, 2], [3, 4]]");
		assert.equal(latexToText("\\begin{pmatrix}1\\\\2\\end{pmatrix}"), "[[1], [2]]");
		assert.equal(latexToText("\\begin{vmatrix}1&2\\\\3&4\\end{vmatrix}"), "det([[1, 2], [3, 4]])");
		assert.equal(latexToText("u\\times v"), "u × v");
		assert.equal(latexToText("A^{T}v"), "A^(T)v");
		assert.equal(latexToText("\\det\\left(A\\right)"), "det(A)");
		assert.equal(latexToText("\\vec{u}+\\mathbf{v}"), "u+v");
		assert.equal(latexToText("\\left\\Vert v\\right\\Vert"), "abs(v)");
		assert.throws(() => latexToText("\\begin{bmatrix}1 & \\placeholder{}\\\\ 3 & 4\\end{bmatrix}"), /Fill in the empty box/);
		assert.throws(() => latexToText("\\begin{cases}1\\end{cases}"), /not something the grapher understands/);
	});

	it("typesets the tutor's plain text, and the round trip means the same", () => {
		assert.equal(textToLatex("A = [[1, 2], [3, 4]]"), "A=\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}");
		assert.equal(textToLatex("u × v"), "u\\times v");
		assert.equal(textToLatex("det(A)"), "\\det\\left(A\\right)");
		for (const text of ["A^T v", "A^-1 v", "2u - v", "span(u, v)", "dot(u, v)", "A B", "norm(v)"]) {
			const back = latexToText(textToLatex(text));
			assert.deepEqual(parseExpr(back), parseExpr(text), `${text} → ${textToLatex(text)} → ${back}`);
		}
	});

	it("× is its own token, so text with it still reads", () => {
		assert.doesNotThrow(() => tokenize("u × v"));
		assert.deepEqual(parseExpr("2 × x"), { type: "bin", op: "*", left: { type: "num", value: 2 }, right: { type: "var", name: "x" }, cross: true });
	});
});

describe("the grapher's rows, keys and tool for linear algebra", () => {
	it("shows a vector's value, a matrix as a grid, and a span in words", async () => {
		const { ExpressionRow, hasDrawableLines } = await import("../components/plot/grapher.tsx");
		const row = (lines: string[]) => {
			const d = doc(lines);
			const index = d.lines.length - 1;
			return renderToStaticMarkup(
				<ExpressionRow line={d.lines[index]!} meaning={resolvePlot(d).lines[index]!} index={index} onText={noop} onToggle={noop} onRemove={noop} onEnter={noop} onSlider={noop} onRange={noop} onAddSlider={noop} />,
			);
		};
		assert.match(row([...UV, "u + v"]), /data-kind="vector"[\s\S]*data-testid="plot-line-value"[^>]*>= (<!-- -->)?\(3, 4\)</);
		assert.doesNotMatch(row(["v = (2, 1)"]), /plot-line-value/, "plain numbers speak for themselves");
		const product = row([A, "A^2"]);
		assert.match(product, /data-kind="matrix"[\s\S]*data-testid="plot-line-matrix"[^>]*aria-label="\[\[7, 10\], \[15, 22\]\]"/);
		assert.match(product, /grid-template-columns:repeat\(2, auto\)[^>]*><span>7<\/span><span>10<\/span><span>15<\/span><span>22<\/span>/);
		assert.doesNotMatch(row([A]), /plot-line-matrix/);
		assert.match(row([...UV, "span(u, v)"]), /data-kind="span"[\s\S]*= (<!-- -->)?the whole plane</);
		assert.match(row([A, "A (1, 2, 3)"]), /data-testid="plot-line-error"[^>]*>A 2 × 2 matrix needs a vector with 2 entries/);
		assert.match(row(["q = (1, 2, 3)"]), /needs a 3D graph\./);
		assert.equal(hasDrawableLines(doc([A, "det(A)"])), false);
		assert.equal(hasDrawableLines(doc(["v = (2, 1)"])), true);
	});

	it("has a vectors-and-matrices tab whose keys type both spellings", async () => {
		const { applyKey, Keypad, KEYPAD } = await import("../components/plot/keypad.tsx");
		const html = renderToStaticMarkup(<Keypad onKey={noop} initialTab="vectors" />);
		assert.match(html, /data-testid="keypad-tab-vectors"[^>]*aria-selected="true"/);
		assert.equal(html.match(/data-testid="keypad-key"/g)!.length, 20 + 4);
		assert.match(html, /aria-label="vector with two entries"[\s\S]*aria-label="2 by 2 matrix"[\s\S]*aria-label="dot product"[\s\S]*aria-label="cross product"[\s\S]*aria-label="transpose"[\s\S]*aria-label="inverse"/);
		const key = (label: string) => KEYPAD.vectors.keys.find((k) => k.label === label)!;
		assert.deepEqual(applyKey("A = ", 4, 4, key("2×2")), { text: "A = [[, ], [, ]]", caret: 6 });
		assert.equal(key("3×3").latex, "\\begin{bmatrix}#?&#?&#?\\\\#?&#?&#?\\\\#?&#?&#?\\end{bmatrix}");
		assert.equal(latexToText(key("4×4").latex!.replace(/#\?/g, "1")).match(/1/g)!.length, 16);
		assert.deepEqual(applyKey("v = ", 4, 4, key("(a, b)")), { text: "v = (, )", caret: 5 });
		assert.equal(latexToText(`A${key("Aᵀ").latex}`), "A^(T)");
		assert.equal(latexToText(`A${key("A⁻¹").latex}`), "A^(-1)");
	});

	it("the tool carries the approved paragraph and reads linear algebra like the learner's grapher", () => {
		assert.match(
			createGraphTool().description,
			/For linear algebra, name a vector with v = \(2, 1\) \(three numbers on a 3D graph\) and a matrix with A = \[\[1, 2\], \[3, 4\]\], one inner list per row\. A named vector is drawn as an arrow from the origin\. Then write expressions with them on their own lines: u \+ v, 2u - v, A v, A B, A\^2, A\^-1, A\^T, dot\(u, v\), cross\(u, v\), norm\(v\), det\(A\), trace\(A\), and span\(u\) or span\(u, v\)\. A line that gives a vector is drawn; a line that gives a number or a matrix shows its value\./,
		);
		const shown = graphDocOf({ expressions: ["u = (2, 1)", "v = (1, 3)", "u + v", "A = [[1, 2], [3, 4]]", "A v", "det(A)"] });
		assert.equal(graphResultText(shown), "Graph shown to the learner: 6 expressions.");
		const broken = graphDocOf({ expressions: ["u = (2, 1)", "A = [[1, 2], [3, 4]]", "u + A"] });
		assert.match(graphResultText(broken), /Could not be read \(fix and call again\):\n- "u \+ A": A vector with 2 entries and a 2 × 2 matrix cannot be added\./);
	});
});

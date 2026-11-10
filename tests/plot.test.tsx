/**
 * The grapher beyond its core (fork, phase 5b — FORK.md): the tutor's
 * `graph` tool, graphs saved beside answers and offered to start from, the
 * block the tutor reads, and the grapher's views. Drawing itself needs a
 * browser canvas and is smoke-tested there. Runs under an isolated
 * LH_DATA_DIR, set before the first config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plot-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { createGraphTool, graphDocOf, graphResultText } = await import("../src/agent/tools/plot.ts");
const { answerImagePool, listCanvases, listSessionPlots, saveCanvas } = await import("../src/server/canvases.ts");
const { materialToolsFor } = await import("../src/server/material-tools.ts");
const { attachmentBlocks } = await import("../src/core/attachments.ts");
const { DEFAULT_VIEW, emptyPlotDoc, resolvePlot } = await import("../src/core/plot/index.ts");
const { stores } = await import("../src/server/stores.ts");
const { PATHS } = await import("../config.ts");
const plotsRoute = await import("../app/api/chats/[id]/plots/route.ts");
const { ExpressionRow, hasDrawableLines, missingName, withSlider } = await import("../components/plot/grapher.tsx");
const { sessionPlotLabel } = await import("../components/plot/grapher-overlay.tsx");
const { GraphCard, GraphCardBody } = await import("../components/artifacts/graph-card.tsx");
import type { PlotDoc } from "../src/core/plot/index.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const doc = (lines: string[], extra: Partial<PlotDoc> = {}): PlotDoc => ({ type: "plot", mode: "2d", lines: lines.map((text, i) => ({ id: `l${i + 1}`, text, color: i })), view: { ...DEFAULT_VIEW }, ...extra });

describe("the tutor's graph tool", () => {
	const tool = createGraphTool();
	const run = async (input: unknown) => {
		const result = await tool.execute("call", input as never, undefined as never);
		return { text: (result.content as { text: string }[])[0]!.text, details: result.details as PlotDoc };
	};

	it("builds the graph document from plain-text expressions, the view and slider ranges", () => {
		assert.deepEqual(graphDocOf({ expressions: ["y = a sin(x)", "a = 2", "(cos(t), sin(t))"], title: " Waves ", xMin: -5, xMax: 5, tMin: 0, tMax: 3, sliders: [{ name: "a", min: 0, max: 4 }, { name: "z", min: 0, max: 1 }] }), {
			type: "plot", mode: "2d", title: "Waves",
			lines: [{ id: "l1", text: "y = a sin(x)", color: 0 }, { id: "l2", text: "a = 2", color: 1, min: 0, max: 4 }, { id: "l3", text: "(cos(t), sin(t))", color: 2 }],
			view: { xMin: -5, xMax: 5, yMin: -10, yMax: 10 },
			tMin: 0, tMax: 3,
		});
	});

	it("tells the tutor what was shown and which expressions could not be read", async () => {
		const good = await run({ expressions: ["y = x^2", "x^2 + y^2 = 9"] });
		assert.equal(good.text, "Graph shown to the learner: 2 expressions.");
		assert.deepEqual(good.details.lines.map((line) => line.text), ["y = x^2", "x^2 + y^2 = 9"]);
		const mixed = await run({ expressions: ["y = k x", "y = x"] });
		assert.equal(mixed.text, 'Graph shown to the learner: 1 expression.\n\nCould not be read (fix and call again):\n- "y = k x": "k" is not defined. Add a line such as k = 1.');
		assert.equal(mixed.details.lines.length, 2, "the unreadable line is kept so the learner sees what was meant");
		await assert.rejects(run({ expressions: ["y <"] }), /No expression could be read, so nothing was shown:\n- "y <": Inequalities are not supported yet\./);
		assert.equal(graphResultText(doc(["a = 1"])), "Graph shown to the learner: 1 expression.");
	});

	it("is described as approved and reaches the teacher through the extra tools", () => {
		assert.match(tool.description, /^Put an interactive graph into the lesson\. The learner can pan, zoom, drag its sliders and open it in their own grapher\. Instant\./);
		assert.match(tool.description, /or a slider \(a = 2\), which sets a letter the other expressions can use and the learner can drag\./);
		assert.match(tool.description, /The result names any expression that could not be read; fix it and call again\.$/);
		assert.ok(materialToolsFor("chat_any").some((t) => t.name === "graph"));
	});
});

describe("a graph sent as an answer", () => {
	const chat = stores.chatStore.createChat("Parabolas");
	const png = Buffer.from("graph png");
	const snapshotId = createHash("sha256").update(png).digest("hex");
	stores.chatStore.saveImageSnapshot(chat.id, snapshotId, { mimeType: "image/png", data: png.toString("base64"), width: 10, height: 10 });
	const sent = doc(["y = a*x^2", "a = 2"], { view: { xMin: -10, xMax: 10, yMin: -6.5, yMax: 6.5 } });

	it("is saved as a graph beside its picture, with the outline the tutor reads", () => {
		const outcome = saveCanvas(chat.id, snapshotId, JSON.stringify({ ...sent, junk: true }));
		assert.deepEqual(outcome, { ok: true, outline: "1. y = a*x^2\n2. a = 2 (slider, from -10 to 10)\nView: x from -10 to 10, y from -6.5 to 6.5" });
		assert.ok(fs.existsSync(path.join(PATHS.canvases, chat.id, `${snapshotId}.plot.json`)));
		assert.equal("junk" in JSON.parse(fs.readFileSync(path.join(PATHS.canvases, chat.id, `${snapshotId}.plot.json`), "utf-8")), false, "the document is stored cleaned");
		assert.deepEqual(listCanvases(chat.id).map((c) => [c.snapshotId, c.kind]), [[snapshotId, "plot"]]);
		assert.deepEqual(saveCanvas(chat.id, snapshotId, JSON.stringify({ type: "plot", lines: 3 })), { ok: false, status: 400, error: "The graph could not be read" });
	});

	it("reaches the tutor as its expressions, then its picture", () => {
		const pool = answerImagePool(chat.id, stores.chatStore.getChat(chat.id)!.imageSnapshots)!;
		assert.deepEqual(attachmentBlocks({ details: { attachments: [snapshotId] } }, pool), [
			{
				type: "text",
				text: "The learner's graph, as they entered it. The picture shows the view they had when they sent it.\n\n1. y = a*x^2\n2. a = 2 (slider, from -10 to 10)\nView: x from -10 to 10, y from -6.5 to 6.5",
			},
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		]);
	});

	it("is offered to start from, after the tutor's graphs in the transcript", async () => {
		const tutorDoc = graphDocOf({ expressions: ["y = sin(x)"], title: "Sine" });
		stores.chatStore.saveMessages(chat.id, [
			{ id: "a1", role: "assistant", stopReason: "toolUse", timestamp: 1, content: [{ type: "toolCall", id: "g1", name: "graph", arguments: {} }] },
			{ id: "r1", role: "toolResult", toolCallId: "g1", toolName: "graph", content: [{ type: "text", text: "shown" }], isError: false, timestamp: 2, details: tutorDoc },
			{ id: "r2", role: "toolResult", toolCallId: "g2", toolName: "graph", content: [{ type: "text", text: "failed" }], isError: true, timestamp: 3, details: null },
			{ id: "r3", role: "toolResult", toolCallId: "x1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 4, details: tutorDoc },
		] as unknown as LhMessage[]);
		const res = await plotsRoute.GET(new Request("http://test/api"), { params: Promise.resolve({ id: chat.id }) });
		const { plots } = (await res.json()) as { plots: { id: string; from: string; doc: PlotDoc }[] };
		assert.deepEqual(plots.map((p) => [p.id, p.from, p.doc.lines[0]!.text]), [["g1", "tutor", "y = sin(x)"], [snapshotId, "you", "y = a*x^2"]]);
		assert.deepEqual(listSessionPlots("chat_nope"), []);
		assert.equal(sessionPlotLabel(plots[0]! as never, 1), "Tutor's graph 1 · Sine");
		assert.equal(sessionPlotLabel(plots[1]! as never, 3), "Your graph 3 · y = a*x^2");
		assert.equal(sessionPlotLabel({ from: "you", doc: emptyPlotDoc() }, 1), "Your graph 1");
	});
});

describe("the grapher's views", () => {
	const noop = () => {};
	const row = (text: string, others: string[] = [], line: object = {}) => {
		const d = doc([text, ...others]);
		Object.assign(d.lines[0]!, line);
		return renderToStaticMarkup(
			<ExpressionRow line={d.lines[0]!} meaning={resolvePlot(d).lines[0]!} index={0} onText={noop} onToggle={noop} onRemove={noop} onEnter={noop} onSlider={noop} onRange={noop} onAddSlider={noop} />,
		);
	};

	it("an expression row shows its text, an error with a one-click fix, or a slider", () => {
		assert.match(row("y = x^2"), /data-kind="explicit-y"[\s\S]*data-testid="plot-line-input"[^>]*value="y = x\^2"/);
		assert.doesNotMatch(row("y = x^2"), /plot-line-error|plot-slider/);
		const broken = row("y = k x");
		assert.match(broken, /data-kind="error"[\s\S]*&quot;k&quot; is not defined\.[\s\S]*data-testid="plot-add-slider"[^>]*>Add slider (<!-- -->)?k</);
		assert.doesNotMatch(row("y <"), /plot-add-slider/);
		const slider = row("a = 2", [], { min: 0, max: 4 });
		assert.match(slider, /data-testid="plot-slider"[\s\S]*type="number"[^>]*value="0"[\s\S]*type="range"[^>]*min="0" max="4"[^>]*value="2"[\s\S]*type="number"[^>]*value="4"/);
		assert.doesNotMatch(row("b = a + 1", ["a = 2"]), /plot-slider/, "a derived value has no slider");
		assert.match(row("y = x", [], { hidden: true }), /aria-label="Show this expression" aria-pressed="false"/);
	});

	it("knows when there is something to draw, and how to add a missing slider", () => {
		assert.equal(hasDrawableLines(doc(["", "a = 1", "y = k"])), false);
		assert.equal(hasDrawableLines(doc(["y = x"])), true);
		const hidden = doc(["y = x"]);
		hidden.lines[0]!.hidden = true;
		assert.equal(hasDrawableLines(hidden), false);
		assert.equal(missingName('"k" is not defined. Add a line such as k = 1.'), "k");
		assert.equal(missingName("Inequalities are not supported yet."), null);
		assert.deepEqual(withSlider(doc(["y = k x"]), "k").lines.at(-1), { id: "l2", text: "k = 1", color: 1 });
	});

	it("a tutor graph is a live card with its sliders; a failed call keeps the quiet card", () => {
		const card = renderToStaticMarkup(<GraphCardBody initial={graphDocOf({ expressions: ["y = a x^2", "a = 2", "y = q"], title: "Parabolas" })} />);
		assert.match(card, /data-testid="graph-card"[\s\S]*data-testid="plot-canvas"[\s\S]*data-testid="graph-card-slider"[\s\S]*a = (<!-- -->)?2/);
		assert.match(card, /Parabolas[\s\S]*y = a x\^2[\s\S]*data-testid="graph-card-open"/);
		assert.doesNotMatch(card, /y = q/, "an unreadable line is not listed under the graph");
		assert.doesNotMatch(card, /grapher-overlay/);
		const part = (overrides: object) => ({ part: { type: "tool-graph", toolCallId: "g", state: "output-available", input: {}, ...overrides } }) as unknown as React.ComponentProps<typeof GraphCard>;
		assert.match(renderToStaticMarkup(<GraphCard {...part({ output: graphDocOf({ expressions: ["y = x"] }) })} />), /data-testid="graph-card"/);
		assert.match(renderToStaticMarkup(<GraphCard {...part({ state: "output-error", errorText: "No expression could be read", output: null })} />), /data-testid="tool-call-card"/);
		assert.match(renderToStaticMarkup(<GraphCard {...part({ state: "input-available", output: undefined })} />), /data-testid="tool-call-card"/);
	});
});

// ── Phase 5c: 3D ────────────────────────────────────────────────────────────
describe("the grapher in 3D", () => {
	const noop = () => {};

	it("has a 2D / 3D switch showing the current mode", async () => {
		const { ModeSwitch } = await import("../components/plot/grapher.tsx");
		const html = renderToStaticMarkup(<ModeSwitch mode="3d" onMode={noop} />);
		assert.match(html, /data-testid="plot-mode-2d" aria-pressed="false"[\s\S]*data-testid="plot-mode-3d" aria-pressed="true"/);
	});

	it("a line for the other mode offers to switch", () => {
		const d = doc(["z = x^2 + y^2"]);
		const html = renderToStaticMarkup(
			<ExpressionRow line={d.lines[0]!} meaning={resolvePlot(d).lines[0]!} index={0} onText={noop} onToggle={noop} onRemove={noop} onEnter={noop} onSlider={noop} onRange={noop} onAddSlider={noop} onSwitchMode={noop} />,
		);
		assert.match(html, /This uses z, so it needs a 3D graph\.[\s\S]*data-testid="plot-switch-mode"[^>]*>Switch to (<!-- -->)?3D</);
		const polar: PlotDoc = { ...doc(["r = 1 + cos(theta)"]), mode: "3d" };
		const back = renderToStaticMarkup(
			<ExpressionRow line={polar.lines[0]!} meaning={resolvePlot(polar).lines[0]!} index={0} onText={noop} onToggle={noop} onRemove={noop} onEnter={noop} onSlider={noop} onRange={noop} onAddSlider={noop} onSwitchMode={noop} />,
		);
		assert.match(back, /Polar curves only work on a 2D graph\.[\s\S]*>Switch to (<!-- -->)?2D</);
	});

	it("a 3D tutor graph is labelled as one, and a 3D graph sent as an answer reads as one", () => {
		const built = graphDocOf({ expressions: ["z = a x y", "a = 1"], dimension: 3, title: "Saddle" });
		const card = renderToStaticMarkup(<GraphCardBody initial={built} />);
		assert.match(card, /data-testid="graph-card"[\s\S]*3D graph[\s\S]*Saddle[\s\S]*z = a x y/);
		assert.match(card, /data-testid="graph-card-slider"/);
		assert.equal(hasDrawableLines(built), true);
		const chat = stores.chatStore.createChat("Surfaces");
		const png = Buffer.from("3d png");
		const id = createHash("sha256").update(png).digest("hex");
		stores.chatStore.saveImageSnapshot(chat.id, id, { mimeType: "image/png", data: png.toString("base64"), width: 1, height: 1 });
		assert.deepEqual(saveCanvas(chat.id, id, JSON.stringify(built)), { ok: true, outline: "3D graph.\n1. z = a x y\n2. a = 1 (slider, from -10 to 10)\nBox: x from -5 to 5, y from -5 to 5, z from -5 to 5" });
		assert.equal(listSessionPlots(chat.id)[0]!.doc.mode, "3d");
	});

	it("the tool's description covers 3D as approved", () => {
		const description = createGraphTool().description;
		assert.match(description, /Set dimension to 3 for a 3D graph the learner can rotate\. There, give a surface as z = x\^2 \+ y\^2 \(or just an expression in x and y\);/);
		assert.match(description, /The box runs from -5 to 5 on each axis unless you set it\./);
	});
});

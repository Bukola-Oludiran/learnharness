import {
	PLOT_COLORS, resolvePlot, sampleFunction, sampleImplicit, sampleParametric, samplePolar, tickLabel, ticks, niceStep, type PlotDoc, type PlotView, type Polyline,
} from "@/src/core";

/**
 * Painting a graph onto a 2D canvas (fork, phase 5b — see FORK.md). The
 * mathematics lives in core/plot; this only maps graph coordinates to
 * pixels. Used by the live canvas and, with the light theme, to export the
 * picture the tutor sees.
 */

export interface PlotTheme {
	background: string;
	grid: string;
	axis: string;
	label: string;
}
export const DARK_THEME: PlotTheme = { background: "#121212", grid: "rgba(255,255,255,0.09)", axis: "rgba(255,255,255,0.55)", label: "rgba(255,255,255,0.6)" };
export const LIGHT_THEME: PlotTheme = { background: "#ffffff", grid: "rgba(0,0,0,0.1)", axis: "rgba(0,0,0,0.7)", label: "rgba(0,0,0,0.65)" };

export function drawPlot(ctx: CanvasRenderingContext2D, width: number, height: number, doc: PlotDoc, view: PlotView, theme: PlotTheme): void {
	const sx = width / (view.xMax - view.xMin);
	const sy = height / (view.yMax - view.yMin);
	const px = (x: number) => (x - view.xMin) * sx;
	const py = (y: number) => height - (y - view.yMin) * sy;

	ctx.fillStyle = theme.background;
	ctx.fillRect(0, 0, width, height);

	// Grid and axis labels.
	const xTicks = ticks(view.xMin, view.xMax, width / 90);
	const yTicks = ticks(view.yMin, view.yMax, height / 70);
	const xStep = niceStep(view.xMax - view.xMin, width / 90);
	const yStep = niceStep(view.yMax - view.yMin, height / 70);
	ctx.lineWidth = 1;
	ctx.strokeStyle = theme.grid;
	ctx.beginPath();
	for (const x of xTicks) {
		ctx.moveTo(Math.round(px(x)) + 0.5, 0);
		ctx.lineTo(Math.round(px(x)) + 0.5, height);
	}
	for (const y of yTicks) {
		ctx.moveTo(0, Math.round(py(y)) + 0.5);
		ctx.lineTo(width, Math.round(py(y)) + 0.5);
	}
	ctx.stroke();
	ctx.strokeStyle = theme.axis;
	ctx.beginPath();
	if (view.xMin <= 0 && view.xMax >= 0) {
		ctx.moveTo(Math.round(px(0)) + 0.5, 0);
		ctx.lineTo(Math.round(px(0)) + 0.5, height);
	}
	if (view.yMin <= 0 && view.yMax >= 0) {
		ctx.moveTo(0, Math.round(py(0)) + 0.5);
		ctx.lineTo(width, Math.round(py(0)) + 0.5);
	}
	ctx.stroke();
	ctx.fillStyle = theme.label;
	ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
	// Labels sit by the axes, or at the edge when an axis is out of view.
	const labelY = Math.min(height - 4, Math.max(12, py(0) + 13));
	const labelX = Math.min(width - 4, Math.max(4, px(0) + 4));
	ctx.textAlign = "center";
	for (const x of xTicks) if (x !== 0) ctx.fillText(tickLabel(x, xStep), px(x), labelY);
	ctx.textAlign = labelX > width - 40 ? "right" : "left";
	for (const y of yTicks) if (y !== 0) ctx.fillText(tickLabel(y, yStep), labelX, py(y) + 4);

	// Curves.
	const resolved = resolvePlot(doc);
	const tMin = doc.tMin ?? 0;
	const tMax = doc.tMax ?? 2 * Math.PI;
	const samples = Math.max(200, Math.min(2000, Math.round(width)));
	const stroke = (lines: Polyline[], flip = false) => {
		ctx.beginPath();
		for (const line of lines) {
			line.forEach(([a, b], index) => {
				const x = px(flip ? b : a);
				// Far-off values are clamped: a canvas misdraws coordinates in the millions.
				const y = Math.max(-1e5, Math.min(1e5, py(flip ? a : b)));
				if (index === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			});
		}
		ctx.stroke();
	};
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.lineWidth = 2.25;
	for (const [index, line] of resolved.lines.entries()) {
		const source = doc.lines[index]!;
		if (source.hidden) continue;
		const color = PLOT_COLORS[(source.color ?? index) % PLOT_COLORS.length]!;
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		switch (line.kind) {
			case "explicit-y":
				stroke(sampleFunction(line.fn, resolved.scope, "x", view.xMin, view.xMax, samples, view.yMax - view.yMin));
				break;
			case "explicit-x":
				stroke(sampleFunction(line.fn, resolved.scope, "y", view.yMin, view.yMax, samples, view.xMax - view.xMin), true);
				break;
			case "parametric":
				stroke(sampleParametric(line.x, line.y, resolved.scope, tMin, tMax, 1200));
				break;
			case "polar":
				stroke(samplePolar(line.fn, resolved.scope, tMin, tMax, 1200));
				break;
			case "implicit": {
				const segments = sampleImplicit(line.fn, resolved.scope, view, Math.min(220, Math.round(width / 4)), Math.min(220, Math.round(height / 4)));
				ctx.beginPath();
				for (const [a, b] of segments) {
					ctx.moveTo(px(a[0]), py(a[1]));
					ctx.lineTo(px(b[0]), py(b[1]));
				}
				ctx.stroke();
				break;
			}
			case "points":
				for (const [x, y] of line.points) {
					if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
					ctx.beginPath();
					ctx.arc(px(x), py(y), 4.5, 0, 2 * Math.PI);
					ctx.fill();
				}
				break;
			default:
				break;
		}
	}
}

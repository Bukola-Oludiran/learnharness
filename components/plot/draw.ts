import {
	blendMatrix, formatEntry, parameterRanges, PLOT_COLORS, resolvePlot, sampleFunction, sampleImplicit, sampleParametric, samplePolar, tickLabel, ticks, niceStep, type PlotDoc, type PlotView, type Polyline,
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

/** How close to a vector's tip, in pixels, a press must be to take hold of it. */
export const TIP_REACH = 12;
const HEAD = 11;

/** The label a vector carries at its tip: its name, or a short expression as written. */
export function vectorLabel(name: string | undefined, text: string): string {
	const written = text.trim();
	return name ?? (written.length <= 14 ? written : "");
}

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
	const [tMin, tMax] = parameterRanges(doc).t;
	const fullSamples = Math.max(200, Math.min(2000, Math.round(width)));
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
	/** An arrow between two pixel positions, in the current colour. */
	const arrow = (fromX: number, fromY: number, toX: number, toY: number, head: number) => {
		const length = Math.hypot(toX - fromX, toY - fromY);
		if (length < 1) {
			ctx.beginPath();
			ctx.arc(toX, toY, 3, 0, 2 * Math.PI);
			ctx.fill();
			return;
		}
		const [ux, uy] = [(toX - fromX) / length, (toY - fromY) / length];
		const size = Math.min(head, length);
		// The shaft stops inside the head, so the tip stays sharp.
		ctx.beginPath();
		ctx.moveTo(fromX, fromY);
		ctx.lineTo(toX - ux * size * 0.8, toY - uy * size * 0.8);
		ctx.stroke();
		ctx.save();
		ctx.setLineDash([]);
		ctx.beginPath();
		ctx.moveTo(toX, toY);
		ctx.lineTo(toX - ux * size - uy * size * 0.42, toY - uy * size + ux * size * 0.42);
		ctx.lineTo(toX - ux * size + uy * size * 0.42, toY - uy * size - ux * size * 0.42);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	};
	/** The whole line through the origin along a direction. */
	const through = (dx: number, dy: number) => {
		const length = Math.hypot(dx, dy);
		if (!(length > 0)) return;
		const reach = (Math.hypot(view.xMax - view.xMin, view.yMax - view.yMin) + Math.hypot(view.xMin + view.xMax, view.yMin + view.yMax)) / length;
		ctx.beginPath();
		ctx.moveTo(px(-dx * reach), py(-dy * reach));
		ctx.lineTo(px(dx * reach), py(dy * reach));
		ctx.stroke();
	};
	// A transformation moves the learner's named vectors and points; the first one showing is the one they follow.
	const leading = resolved.lines.find((line, index) => line.kind === "transform" && !doc.lines[index]!.hidden);
	const lead = leading?.kind === "transform" && leading.at > 0 ? blendMatrix(leading.matrix, leading.at) : null;
	const apply = (m: readonly (readonly number[])[], x: number, y: number): [number, number] => [m[0]![0]! * x + m[0]![1]! * y, m[1]![0]! * x + m[1]![1]! * y];
	const moved = (x: number, y: number): [number, number] => (lead ? apply(lead, x, y) : [x, y]);
	const GHOST = 0.28;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.lineWidth = 2.25;
	for (const [index, line] of resolved.lines.entries()) {
		const source = doc.lines[index]!;
		if (source.hidden) continue;
		const color = PLOT_COLORS[(source.color ?? index) % PLOT_COLORS.length]!;
		// A curve whose every point is an integral is sampled more coarsely, so panning stays smooth.
		const samples = resolved.costly.has(line.id) ? Math.min(160, fullSamples) : fullSamples;
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
				stroke(samplePolar(line.fn, resolved.scope, tMin, tMax, 1200, doc.angles === "degrees"));
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
					const [mx, my] = moved(x, y);
					if (lead) {
						// Where it started, faintly.
						ctx.save();
						ctx.globalAlpha = GHOST;
						ctx.beginPath();
						ctx.arc(px(x), py(y), 4.5, 0, 2 * Math.PI);
						ctx.fill();
						ctx.restore();
					}
					ctx.beginPath();
					ctx.arc(px(mx), py(my), 4.5, 0, 2 * Math.PI);
					ctx.fill();
				}
				break;
			case "vector": {
				const [x, y] = line.value;
				if (line.value.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) break;
				// Only a named vector is carried by a transformation: a result such as A u already says where it lands.
				const carried = lead !== null && line.name !== undefined;
				const [tx, ty] = carried ? moved(x!, y!) : [x!, y!];
				if (carried) {
					ctx.save();
					ctx.globalAlpha = GHOST;
					arrow(px(0), py(0), px(x!), py(y!), HEAD);
					ctx.restore();
				}
				// A sum: the second vector again, dashed, from the first one's tip.
				if (line.guide && line.guide.from.every(Number.isFinite)) {
					const [fx, fy] = carried ? moved(line.guide.from[0]!, line.guide.from[1]!) : line.guide.from;
					ctx.save();
					ctx.globalAlpha = 0.7;
					ctx.lineWidth = 1.5;
					ctx.setLineDash([6, 5]);
					arrow(px(fx!), py(fy!), px(tx), py(ty), 8);
					ctx.restore();
				}
				arrow(px(0), py(0), px(tx), py(ty), HEAD);
				if (line.draggable) {
					// A ring at the tip as written: this one can be dragged.
					ctx.save();
					ctx.lineWidth = 1.5;
					ctx.globalAlpha = 0.55;
					ctx.beginPath();
					ctx.arc(px(x!), py(y!), 7.5, 0, 2 * Math.PI);
					ctx.stroke();
					ctx.restore();
				}
				const label = vectorLabel(line.name, source.text);
				if (label) {
					ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
					ctx.textAlign = tx < 0 ? "right" : "left";
					ctx.fillText(label, px(tx) + (tx < 0 ? -11 : 11), py(ty) + (ty < 0 ? 16 : -9));
				}
				break;
			}
			case "span": {
				// One direction: the whole line through the origin. Two fill the plane, which needs no drawing.
				const [dx, dy] = line.basis[0] ?? [];
				if (line.basis.length !== 1 || dx === undefined || dy === undefined) break;
				ctx.save();
				ctx.globalAlpha = 0.6;
				ctx.lineWidth = 1.75;
				through(dx, dy);
				ctx.restore();
				break;
			}
			case "transform": {
				if (line.matrix.length !== 2) break;
				const m = blendMatrix(line.matrix, line.at);
				// The grid, carried along: straight lines stay straight, so two ends each are enough.
				const count = Math.min(60, Math.ceil(Math.max(Math.abs(view.xMin), Math.abs(view.xMax), Math.abs(view.yMin), Math.abs(view.yMax)) / xStep) + 1);
				const far = count * xStep;
				ctx.save();
				ctx.lineWidth = 1;
				ctx.globalAlpha = 0.34;
				ctx.beginPath();
				for (let k = -count; k <= count; k++) {
					for (const [from, to] of [[apply(m, k * xStep, -far), apply(m, k * xStep, far)], [apply(m, -far, k * xStep), apply(m, far, k * xStep)]] as const) {
						ctx.moveTo(px(from[0]), py(from[1]));
						ctx.lineTo(px(to[0]), py(to[1]));
					}
				}
				ctx.stroke();
				// The unit square: its area becomes |det|.
				const corners = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)];
				ctx.beginPath();
				corners.forEach(([x, y], corner) => (corner === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
				ctx.closePath();
				ctx.globalAlpha = 0.2;
				ctx.fill();
				ctx.globalAlpha = 0.85;
				ctx.lineWidth = 1.5;
				ctx.stroke();
				ctx.restore();
				ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
				for (const [name, [x, y]] of [["î", apply(m, 1, 0)], ["ĵ", apply(m, 0, 1)]] as const) {
					arrow(px(0), py(0), px(x), py(y), HEAD);
					ctx.textAlign = x < 0 ? "right" : "left";
					ctx.fillText(name, px(x) + (x < 0 ? -9 : 9), py(y) + (y < 0 ? 16 : -8));
				}
				break;
			}
			case "eigen": {
				if (line.size !== 2) break;
				ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
				for (const pair of line.pairs) {
					// A single direction is a line that the matrix keeps on itself; a whole plane of them needs no drawing.
					const [dx, dy] = pair.vectors[0] ?? [];
					if (pair.vectors.length !== 1 || dx === undefined || dy === undefined) continue;
					ctx.save();
					ctx.globalAlpha = 0.8;
					ctx.lineWidth = 1.75;
					ctx.setLineDash([9, 5]);
					through(dx, dy);
					ctx.restore();
					const along = (0.36 * (view.xMax - view.xMin)) / Math.hypot(dx, dy);
					ctx.textAlign = "left";
					ctx.fillText(`λ = ${formatEntry(pair.value)}`, px(dx * along) + 8, py(dy * along) - 8);
				}
				break;
			}
			default:
				break;
		}
	}

	// Where the straight lines meet: a marked, labelled point.
	const meet = resolved.meet?.result;
	if (meet?.kind === "point" && meet.at.length === 2) {
		const [x, y] = meet.at as [number, number];
		ctx.fillStyle = theme.background;
		ctx.strokeStyle = theme.axis;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(px(x), py(y), 5, 0, 2 * Math.PI);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = theme.axis;
		ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
		ctx.textAlign = "left";
		ctx.fillText(`(${formatEntry(x)}, ${formatEntry(y)})`, px(x) + 10, py(y) - 9);
	}
}

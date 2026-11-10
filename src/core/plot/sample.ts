/**
 * Sampling curves for the grapher (fork, phase 5b): expressions in, polylines
 * out, in graph coordinates. Pure and renderer-agnostic — the canvas only
 * maps these to pixels.
 */

import type { Compiled, Scope } from "./expr.ts";
import type { PlotView } from "./model.ts";

export type Point = [number, number];
export type Polyline = Point[];

/**
 * A function of one variable over [from, to], as polylines broken wherever
 * the value is undefined or jumps across most of the visible range between
 * neighbouring samples (an asymptote, as in tan x).
 */
export function sampleFunction(fn: Compiled, scope: Scope, variable: string, from: number, to: number, samples: number, visibleSpan: number): Polyline[] {
	const out: Polyline[] = [];
	let current: Polyline = [];
	const local: Scope = { ...scope };
	const step = (to - from) / samples;
	let previous = NaN;
	for (let i = 0; i <= samples; i++) {
		const input = from + i * step;
		local[variable] = input;
		const value = fn(local);
		const jump = Number.isFinite(previous) && Math.abs(value - previous) > visibleSpan * 2 && Math.sign(value) !== Math.sign(previous);
		if (!Number.isFinite(value) || jump) {
			if (current.length > 1) out.push(current);
			current = [];
			if (!Number.isFinite(value)) {
				previous = NaN;
				continue;
			}
		}
		current.push([input, value]);
		previous = value;
	}
	if (current.length > 1) out.push(current);
	return out;
}

/** A parametric curve (x(t), y(t)) for t in [tMin, tMax]. */
export function sampleParametric(x: Compiled, y: Compiled, scope: Scope, tMin: number, tMax: number, samples: number): Polyline[] {
	const out: Polyline[] = [];
	let current: Polyline = [];
	const local: Scope = { ...scope };
	for (let i = 0; i <= samples; i++) {
		local.t = tMin + ((tMax - tMin) * i) / samples;
		const px = x(local);
		const py = y(local);
		if (!Number.isFinite(px) || !Number.isFinite(py)) {
			if (current.length > 1) out.push(current);
			current = [];
			continue;
		}
		current.push([px, py]);
	}
	if (current.length > 1) out.push(current);
	return out;
}

/** A polar curve r(theta) for theta in [tMin, tMax]. */
export function samplePolar(r: Compiled, scope: Scope, tMin: number, tMax: number, samples: number): Polyline[] {
	const out: Polyline[] = [];
	let current: Polyline = [];
	const local: Scope = { ...scope };
	for (let i = 0; i <= samples; i++) {
		const theta = tMin + ((tMax - tMin) * i) / samples;
		local.theta = theta;
		const radius = r(local);
		if (!Number.isFinite(radius)) {
			if (current.length > 1) out.push(current);
			current = [];
			continue;
		}
		current.push([radius * Math.cos(theta), radius * Math.sin(theta)]);
	}
	if (current.length > 1) out.push(current);
	return out;
}

/**
 * The zero set of f(x, y) over the view, by marching squares: the grid's
 * cells where f changes sign each contribute one or two short segments,
 * their ends placed by linear interpolation along the cell's edges.
 */
export function sampleImplicit(fn: Compiled, scope: Scope, view: PlotView, columns: number, rows: number): [Point, Point][] {
	const local: Scope = { ...scope };
	const dx = (view.xMax - view.xMin) / columns;
	const dy = (view.yMax - view.yMin) / rows;
	const values: Float64Array[] = [];
	for (let j = 0; j <= rows; j++) {
		const row = new Float64Array(columns + 1);
		local.y = view.yMin + j * dy;
		for (let i = 0; i <= columns; i++) {
			local.x = view.xMin + i * dx;
			row[i] = fn(local);
		}
		values.push(row);
	}
	const segments: [Point, Point][] = [];
	// Where the sign changes along an edge. At a root the value there is
	// small; at a pole (1/x) it is larger than at either end — not a crossing.
	const cross = (ax: number, ay: number, av: number, bx: number, by: number, bv: number): Point | null => {
		const k = av / (av - bv);
		const point: Point = [ax + (bx - ax) * k, ay + (by - ay) * k];
		local.x = point[0];
		local.y = point[1];
		const at = Math.abs(fn(local));
		return at <= Math.max(Math.abs(av), Math.abs(bv)) ? point : null;
	};
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < columns; i++) {
			const x0 = view.xMin + i * dx;
			const y0 = view.yMin + j * dy;
			const x1 = x0 + dx;
			const y1 = y0 + dy;
			const v00 = values[j]![i]!;
			const v10 = values[j]![i + 1]!;
			const v01 = values[j + 1]![i]!;
			const v11 = values[j + 1]![i + 1]!;
			if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) continue;
			const hits: Point[] = [];
			const add = (point: Point | null) => {
				if (point) hits.push(point);
			};
			if (v00 > 0 !== v10 > 0) add(cross(x0, y0, v00, x1, y0, v10));
			if (v10 > 0 !== v11 > 0) add(cross(x1, y0, v10, x1, y1, v11));
			if (v01 > 0 !== v11 > 0) add(cross(x0, y1, v01, x1, y1, v11));
			if (v00 > 0 !== v01 > 0) add(cross(x0, y0, v00, x0, y1, v01));
			if (hits.length === 2) segments.push([hits[0]!, hits[1]!]);
			else if (hits.length === 4) segments.push([hits[0]!, hits[1]!], [hits[2]!, hits[3]!]);
		}
	}
	return segments;
}

/** Round grid spacing for an axis: 1, 2 or 5 times a power of ten, giving about `target` lines. */
export function niceStep(span: number, target: number): number {
	const rough = span / Math.max(1, target);
	const power = Math.pow(10, Math.floor(Math.log10(rough)));
	const scaled = rough / power;
	return (scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10) * power;
}

/** The grid lines of an axis within [min, max]. */
export function ticks(min: number, max: number, target: number): number[] {
	const step = niceStep(max - min, target);
	const out: number[] = [];
	for (let value = Math.ceil(min / step - 1e-9) * step; value <= max + step * 1e-9; value += step) out.push(Math.abs(value) < step * 1e-9 ? 0 : value);
	return out;
}

/** A tick's label: no floating-point dust, scientific notation only when needed. */
export function tickLabel(value: number, step: number): string {
	if (value === 0) return "0";
	if (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4) return value.toExponential(Math.max(0, Math.min(3, -Math.floor(Math.log10(step / Math.abs(value))))));
	return String(Number(value.toFixed(Math.max(0, -Math.floor(Math.log10(step)) + 1))));
}

/** Zoom a view about a point by a factor (> 1 zooms out). */
export function zoomView(view: PlotView, x: number, y: number, factor: number): PlotView {
	return { xMin: x - (x - view.xMin) * factor, xMax: x + (view.xMax - x) * factor, yMin: y - (y - view.yMin) * factor, yMax: y + (view.yMax - y) * factor };
}

/** Fit a view's y range to a canvas's shape so circles look round, keeping its centre and x range. */
export function squareView(view: PlotView, width: number, height: number): PlotView {
	if (width <= 0 || height <= 0) return view;
	const half = ((view.xMax - view.xMin) * height) / width / 2;
	const mid = (view.yMin + view.yMax) / 2;
	return { ...view, yMin: mid - half, yMax: mid + half };
}

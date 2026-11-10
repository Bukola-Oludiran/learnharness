/**
 * Sampling 3D graphs (fork, phase 5c — see FORK.md): expressions in,
 * triangle meshes and polylines out, in graph coordinates. Pure and
 * renderer-agnostic — three.js only turns these arrays into pictures.
 */

import type { Compiled, Scope } from "./expr.ts";
import type { PlotBox } from "./model.ts";

/** Triangles as flat arrays: `positions` is x,y,z per vertex; `indices`
 *  three per triangle. `normals`, when present, is one per vertex. */
export interface Mesh {
	positions: number[];
	indices: number[];
	normals?: number[];
}

export type Point3 = [number, number, number];

const AXES = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] } as const;

/** A grid of vertices joined into triangles, leaving out any cell with an undefined corner. */
function gridMesh(columns: number, rows: number, vertex: (i: number, j: number) => Point3): Mesh {
	const positions: number[] = [];
	const ok: boolean[] = [];
	for (let j = 0; j <= rows; j++) {
		for (let i = 0; i <= columns; i++) {
			const [x, y, z] = vertex(i, j);
			const finite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
			ok.push(finite);
			positions.push(finite ? x : 0, finite ? y : 0, finite ? z : 0);
		}
	}
	const indices: number[] = [];
	const at = (i: number, j: number) => j * (columns + 1) + i;
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < columns; i++) {
			const a = at(i, j);
			const b = at(i + 1, j);
			const c = at(i + 1, j + 1);
			const d = at(i, j + 1);
			if (ok[a] && ok[b] && ok[c] && ok[d]) indices.push(a, b, c, a, c, d);
		}
	}
	return { positions, indices };
}

/**
 * A surface that gives one coordinate from the other two — z = f(x, y), or
 * x = f(y, z), or y = f(x, z) — over the box. A value far outside the box
 * (a pole) is treated as undefined, so 1/(x^2 + y^2) does not draw a spike
 * to infinity.
 */
export function surfaceMesh(fn: Compiled, axis: "x" | "y" | "z", scope: Scope, box: PlotBox, samples: number): Mesh {
	const [a, b] = AXES[axis];
	const range = (name: "x" | "y" | "z") => [box[`${name}Min`], box[`${name}Max`]] as const;
	const [aMin, aMax] = range(a);
	const [bMin, bMax] = range(b);
	const [vMin, vMax] = range(axis);
	const span = vMax - vMin;
	const local: Scope = { ...scope };
	return gridMesh(samples, samples, (i, j) => {
		const av = aMin + ((aMax - aMin) * i) / samples;
		const bv = bMin + ((bMax - bMin) * j) / samples;
		local[a] = av;
		local[b] = bv;
		let value = fn(local);
		if (value > vMax + span * 4 || value < vMin - span * 4) value = NaN;
		const point = { [a]: av, [b]: bv, [axis]: value } as Record<"x" | "y" | "z", number>;
		return [point.x, point.y, point.z];
	});
}

/** A parametric surface (x(u, v), y(u, v), z(u, v)). */
export function paramSurfaceMesh(x: Compiled, y: Compiled, z: Compiled, scope: Scope, u: readonly [number, number], v: readonly [number, number], samples: number): Mesh {
	const local: Scope = { ...scope };
	return gridMesh(samples, samples, (i, j) => {
		local.u = u[0] + ((u[1] - u[0]) * i) / samples;
		local.v = v[0] + ((v[1] - v[0]) * j) / samples;
		return [x(local), y(local), z(local)];
	});
}

/** A space curve (x(t), y(t), z(t)), broken where it is undefined. */
export function curve3(x: Compiled, y: Compiled, z: Compiled, scope: Scope, tMin: number, tMax: number, samples: number): Point3[][] {
	const out: Point3[][] = [];
	let current: Point3[] = [];
	const local: Scope = { ...scope };
	for (let i = 0; i <= samples; i++) {
		local.t = tMin + ((tMax - tMin) * i) / samples;
		const point: Point3 = [x(local), y(local), z(local)];
		if (!point.every(Number.isFinite)) {
			if (current.length > 1) out.push(current);
			current = [];
			continue;
		}
		current.push(point);
	}
	if (current.length > 1) out.push(current);
	return out;
}

// A cube's corners, and its six tetrahedra around the 0–6 diagonal.
const CORNERS: Point3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const TETRAHEDRA = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]] as const;

/**
 * The zero set of f(x, y, z) in the box, by marching tetrahedra: each grid
 * cube is cut into six tetrahedra, and each tetrahedron whose corners
 * disagree in sign contributes one or two triangles, their corners placed
 * by linear interpolation along its edges. Every triangle is wound to face
 * the way f increases, and each vertex carries f's gradient as its normal,
 * so the surface shades smoothly. A sign change across a pole is not a
 * root and is left out.
 */
export function implicitMesh(fn: Compiled, scope: Scope, box: PlotBox, cells: number): Mesh {
	const local: Scope = { ...scope };
	const f = (x: number, y: number, z: number) => {
		local.x = x;
		local.y = y;
		local.z = z;
		return fn(local);
	};
	const n = cells + 1;
	const dx = (box.xMax - box.xMin) / cells;
	const dy = (box.yMax - box.yMin) / cells;
	const dz = (box.zMax - box.zMin) / cells;
	const values = new Float64Array(n * n * n);
	for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) values[(k * n + j) * n + i] = f(box.xMin + i * dx, box.yMin + j * dy, box.zMin + k * dz);

	const positions: number[] = [];
	const normals: number[] = [];
	const indices: number[] = [];
	const h = Math.min(dx, dy, dz) * 1e-3;
	const gradient = (p: Point3): Point3 => {
		const g: Point3 = [f(p[0] + h, p[1], p[2]) - f(p[0] - h, p[1], p[2]), f(p[0], p[1] + h, p[2]) - f(p[0], p[1] - h, p[2]), f(p[0], p[1], p[2] + h) - f(p[0], p[1], p[2] - h)];
		const length = Math.hypot(g[0], g[1], g[2]);
		return length > 0 && Number.isFinite(length) ? [g[0] / length, g[1] / length, g[2] / length] : [0, 0, 1];
	};
	const corner: Point3[] = CORNERS.map(() => [0, 0, 0]);
	const value = new Float64Array(8);
	const emit = (a: Point3, b: Point3, c: Point3) => {
		const na = gradient(a);
		// Wind the triangle to face along the gradient, so "front" is consistent across the surface.
		const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
		const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
		const facing = (uy * vz - uz * vy) * na[0] + (uz * vx - ux * vz) * na[1] + (ux * vy - uy * vx) * na[2];
		const ordered = facing >= 0 ? [a, b, c] : [a, c, b];
		const base = positions.length / 3;
		for (const p of ordered) {
			positions.push(p[0], p[1], p[2]);
			const g = p === a ? na : gradient(p);
			normals.push(g[0], g[1], g[2]);
		}
		indices.push(base, base + 1, base + 2);
	};
	for (let k = 0; k < cells; k++) {
		for (let j = 0; j < cells; j++) {
			for (let i = 0; i < cells; i++) {
				let anyBelow = false;
				let anyAbove = false;
				let finite = true;
				for (let c = 0; c < 8; c++) {
					const [ox, oy, oz] = CORNERS[c]!;
					const v = values[((k + oz) * n + (j + oy)) * n + (i + ox)]!;
					value[c] = v;
					if (!Number.isFinite(v)) finite = false;
					else if (v < 0) anyBelow = true;
					else anyAbove = true;
					corner[c] = [box.xMin + (i + ox) * dx, box.yMin + (j + oy) * dy, box.zMin + (k + oz) * dz];
				}
				if (!finite || !anyBelow || !anyAbove) continue;
				for (const tet of TETRAHEDRA) {
					const below = tet.filter((c) => value[c]! < 0);
					const above = tet.filter((c) => value[c]! >= 0);
					if (below.length === 0 || above.length === 0) continue;
					const cut = (p: number, q: number): Point3 | null => {
						const vp = value[p]!;
						const vq = value[q]!;
						const s = vp / (vp - vq);
						const a = corner[p]!;
						const b = corner[q]!;
						const point: Point3 = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
						// At a root the value here is small; at a pole it is larger than at either end.
						return Math.abs(f(point[0], point[1], point[2])) <= Math.max(Math.abs(vp), Math.abs(vq)) ? point : null;
					};
					const points: (Point3 | null)[] = [];
					if (below.length === 1 || above.length === 1) {
						const [apex, others] = below.length === 1 ? [below[0]!, above] : [above[0]!, below];
						for (const other of others) points.push(cut(apex, other));
						if (points.every((p): p is Point3 => p !== null)) emit(points[0]!, points[1]!, points[2]!);
					} else {
						// Two against two: the four cuts form a quad, as two triangles.
						points.push(cut(below[0]!, above[0]!), cut(below[0]!, above[1]!), cut(below[1]!, above[1]!), cut(below[1]!, above[0]!));
						if (points.every((p): p is Point3 => p !== null)) {
							emit(points[0]!, points[1]!, points[2]!);
							emit(points[0]!, points[2]!, points[3]!);
						}
					}
				}
			}
		}
	}
	return { positions, indices, normals };
}

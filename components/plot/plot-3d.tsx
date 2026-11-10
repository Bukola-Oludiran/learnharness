"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { cn } from "@/lib/utils";
import {
	curve3, DEFAULT_BOX, implicitMesh, niceStep, paramSurfaceMesh, PLOT_COLORS, resolvePlot, surfaceMesh, tickLabel, ticks, type Mesh, type PlotBox, type PlotDoc, type Point3,
} from "@/src/core";
import type { PlotCanvasHandle } from "./plot-canvas";

/**
 * The 3D plot (fork, phase 5c — see FORK.md): three.js draws what
 * core/plot samples. Loaded lazily — three.js is fetched the first time a
 * 3D graph appears. The box is mapped onto a cube of side 2 around the
 * origin, so every graph fills the view whatever its ranges; z is up.
 * Drag to rotate; the wheel zooms where the host allows it. Axis labels
 * are drawn on a 2D canvas above the WebGL one, so they are sharp and can
 * be composited into the exported picture.
 */

const SURFACE_SAMPLES = 64;
const IMPLICIT_CELLS = 36;
const CURVE_SAMPLES = 800;
const EXPORT_WIDTH = 1200;

interface Theme {
	background: number;
	frame: number;
	label: string;
}
const DARK: Theme = { background: 0x121212, frame: 0x6b6b6b, label: "rgba(255,255,255,0.7)" };
const LIGHT: Theme = { background: 0xffffff, frame: 0x8a8a8a, label: "rgba(0,0,0,0.75)" };

interface Label {
	at: THREE.Vector3;
	text: string;
	bold?: boolean;
}

interface Stage {
	renderer: THREE.WebGLRenderer;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	controls: OrbitControls;
	content: THREE.Group;
	frame: THREE.LineSegments;
	labels: Label[];
	lineMaterials: LineMaterial[];
	theme: Theme;
	render: () => void;
}

const CLIP = [
	new THREE.Plane(new THREE.Vector3(1, 0, 0), 1.001), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1.001),
	new THREE.Plane(new THREE.Vector3(0, 1, 0), 1.001), new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.001),
	new THREE.Plane(new THREE.Vector3(0, 0, 1), 1.001), new THREE.Plane(new THREE.Vector3(0, 0, -1), 1.001),
];

function disposeGroup(group: THREE.Group): void {
	for (const child of [...group.children]) {
		group.remove(child);
		const mesh = child as THREE.Mesh;
		mesh.geometry?.dispose();
		const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
		for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
	}
}

/** Rebuild everything the document draws, in box-normalised coordinates. */
function build(stage: Stage, doc: PlotDoc, width: number, height: number): void {
	disposeGroup(stage.content);
	stage.lineMaterials = [];
	const box: PlotBox = doc.box ?? DEFAULT_BOX;
	const centre = [(box.xMin + box.xMax) / 2, (box.yMin + box.yMax) / 2, (box.zMin + box.zMax) / 2];
	const half = [(box.xMax - box.xMin) / 2, (box.yMax - box.yMin) / 2, (box.zMax - box.zMin) / 2];
	const norm = (p: readonly number[], offset = 0): Point3 => [(p[offset]! - centre[0]!) / half[0]!, (p[offset + 1]! - centre[1]!) / half[1]!, (p[offset + 2]! - centre[2]!) / half[2]!];

	const addMesh = (mesh: Mesh, color: string) => {
		if (mesh.indices.length === 0) return;
		const positions = new Float32Array(mesh.positions.length);
		for (let i = 0; i < mesh.positions.length; i += 3) positions.set(norm(mesh.positions, i), i);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geometry.setIndex(mesh.indices);
		if (mesh.normals) {
			// A normal transforms by the inverse of the scaling the positions took.
			const normals = new Float32Array(mesh.normals.length);
			for (let i = 0; i < mesh.normals.length; i += 3) {
				const n = new THREE.Vector3(mesh.normals[i]! * half[0]!, mesh.normals[i + 1]! * half[1]!, mesh.normals[i + 2]! * half[2]!).normalize();
				normals.set([n.x, n.y, n.z], i);
			}
			geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
		} else geometry.computeVertexNormals();
		stage.content.add(
			new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({ color, side: THREE.DoubleSide, shininess: 28, transparent: true, opacity: 0.88, clippingPlanes: CLIP })),
		);
	};
	const addCurve = (points: Point3[], color: string) => {
		const geometry = new LineGeometry();
		geometry.setPositions(points.flatMap((p) => norm(p)));
		const material = new LineMaterial({ color, linewidth: 3, clippingPlanes: CLIP });
		material.resolution.set(width, height);
		stage.lineMaterials.push(material);
		stage.content.add(new Line2(geometry, material));
	};

	const resolved = resolvePlot(doc);
	const twoPi = 2 * Math.PI;
	for (const [index, line] of resolved.lines.entries()) {
		const source = doc.lines[index]!;
		if (source.hidden) continue;
		const color = PLOT_COLORS[(source.color ?? index) % PLOT_COLORS.length]!;
		switch (line.kind) {
			case "surface":
				addMesh(surfaceMesh(line.fn, line.axis, resolved.scope, box, SURFACE_SAMPLES), color);
				break;
			case "param-surface":
				addMesh(paramSurfaceMesh(line.x, line.y, line.z, resolved.scope, [doc.uMin ?? 0, doc.uMax ?? twoPi], [doc.vMin ?? 0, doc.vMax ?? twoPi], SURFACE_SAMPLES), color);
				break;
			case "implicit3":
				addMesh(implicitMesh(line.fn, resolved.scope, box, IMPLICIT_CELLS), color);
				break;
			case "curve3":
				for (const part of curve3(line.x, line.y, line.z, resolved.scope, doc.tMin ?? 0, doc.tMax ?? twoPi, CURVE_SAMPLES)) addCurve(part, color);
				break;
			case "points3":
				for (const point of line.points) {
					if (!point.every(Number.isFinite)) continue;
					const [x, y, z] = norm(point);
					if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1.001) continue;
					const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshPhongMaterial({ color }));
					dot.position.set(x, y, z);
					stage.content.add(dot);
				}
				break;
			default:
				break;
		}
	}

	// Tick labels along three edges of the box, and the axis names beyond them.
	const labels: Label[] = [];
	const axisTicks = (min: number, max: number) => {
		const step = niceStep(max - min, 5);
		return ticks(min, max, 5).map((value) => ({ value, text: tickLabel(value, step) }));
	};
	for (const t of axisTicks(box.xMin, box.xMax)) labels.push({ at: new THREE.Vector3((t.value - centre[0]!) / half[0]!, -1.12, -1), text: t.text });
	for (const t of axisTicks(box.yMin, box.yMax)) labels.push({ at: new THREE.Vector3(-1.12, (t.value - centre[1]!) / half[1]!, -1), text: t.text });
	for (const t of axisTicks(box.zMin, box.zMax)) labels.push({ at: new THREE.Vector3(-1.1, 1.1, (t.value - centre[2]!) / half[2]!), text: t.text });
	labels.push({ at: new THREE.Vector3(0, -1.32, -1), text: "x", bold: true }, { at: new THREE.Vector3(-1.32, 0, -1), text: "y", bold: true }, { at: new THREE.Vector3(-1.1, 1.1, 1.2), text: "z", bold: true });
	stage.labels = labels;
}

const Plot3D = forwardRef<PlotCanvasHandle, { doc: PlotDoc; wheelZoom?: boolean; className?: string }>(function Plot3D({ doc, wheelZoom = true, className }, ref) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const glRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLCanvasElement>(null);
	const stageRef = useRef<Stage | null>(null);
	const docRef = useRef(doc);
	docRef.current = doc;

	useEffect(() => {
		const wrap = wrapRef.current;
		const canvas = glRef.current;
		const overlay = overlayRef.current;
		if (!wrap || !canvas || !overlay) return;
		const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
		renderer.localClippingEnabled = true;
		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
		camera.up.set(0, 0, 1);
		camera.position.set(3.8, -5.4, 3.2);
		const controls = new OrbitControls(camera, canvas);
		controls.enablePan = false;
		controls.minDistance = 2.5;
		controls.maxDistance = 16;
		scene.add(new THREE.AmbientLight(0xffffff, 1.1));
		// A light that travels with the camera keeps every side readable.
		const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
		camera.add(headlight);
		headlight.position.set(-1, 2, 3);
		scene.add(camera);
		const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: DARK.frame }));
		scene.add(frame);
		const content = new THREE.Group();
		scene.add(content);

		const drawLabels = (ctx: CanvasRenderingContext2D, width: number, height: number, theme: Theme) => {
			ctx.fillStyle = theme.label;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			const projected = new THREE.Vector3();
			for (const label of stage.labels) {
				projected.copy(label.at).project(camera);
				if (projected.z > 1) continue;
				ctx.font = `${label.bold ? "600 13px" : "11px"} ui-monospace, SFMono-Regular, Menlo, monospace`;
				ctx.fillText(label.text, ((projected.x + 1) / 2) * width, ((1 - projected.y) / 2) * height);
			}
		};
		const stage: Stage = {
			renderer, scene, camera, controls, content, frame, labels: [], lineMaterials: [], theme: DARK,
			render: () => {
				scene.background = new THREE.Color(stage.theme.background);
				(frame.material as THREE.LineBasicMaterial).color.set(stage.theme.frame);
				renderer.render(scene, camera);
				const ctx = overlay.getContext("2d");
				if (!ctx) return;
				const ratio = window.devicePixelRatio || 1;
				ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
				ctx.clearRect(0, 0, overlay.width, overlay.height);
				drawLabels(ctx, overlay.width / ratio, overlay.height / ratio, stage.theme);
			},
		};
		stageRef.current = stage;
		(stage as Stage & { drawLabels: typeof drawLabels }).drawLabels = drawLabels;

		const resize = () => {
			const width = wrap.clientWidth;
			const height = wrap.clientHeight;
			if (width === 0 || height === 0) return;
			const ratio = window.devicePixelRatio || 1;
			renderer.setPixelRatio(ratio);
			renderer.setSize(width, height, false);
			overlay.width = Math.round(width * ratio);
			overlay.height = Math.round(height * ratio);
			camera.aspect = width / height;
			camera.updateProjectionMatrix();
			for (const material of stage.lineMaterials) material.resolution.set(width, height);
			stage.render();
		};
		build(stage, docRef.current, wrap.clientWidth || 1, wrap.clientHeight || 1);
		resize();
		const observer = new ResizeObserver(resize);
		observer.observe(wrap);
		controls.addEventListener("change", stage.render);
		return () => {
			observer.disconnect();
			controls.removeEventListener("change", stage.render);
			controls.dispose();
			disposeGroup(content);
			frame.geometry.dispose();
			(frame.material as THREE.Material).dispose();
			renderer.dispose();
			stageRef.current = null;
		};
	}, []);

	useEffect(() => {
		const stage = stageRef.current;
		if (stage) stage.controls.enableZoom = wheelZoom;
	}, [wheelZoom]);

	// The document changed: resample and redraw, keeping the camera where it is.
	useEffect(() => {
		const stage = stageRef.current;
		const wrap = wrapRef.current;
		if (!stage || !wrap) return;
		build(stage, doc, wrap.clientWidth || 1, wrap.clientHeight || 1);
		stage.render();
	}, [doc]);

	useImperativeHandle(
		ref,
		() => ({
			shownView: () => docRef.current.view,
			toPng: () =>
				new Promise((resolve) => {
					const stage = stageRef.current as (Stage & { drawLabels?: (ctx: CanvasRenderingContext2D, w: number, h: number, theme: Theme) => void }) | null;
					const gl = glRef.current;
					if (!stage || !gl || gl.width === 0) return resolve(null);
					// Light, like the 2D export: the tutor reads it, whatever the app's theme.
					stage.theme = LIGHT;
					stage.render();
					const width = EXPORT_WIDTH;
					const height = Math.round((EXPORT_WIDTH * gl.height) / gl.width);
					const out = document.createElement("canvas");
					out.width = width;
					out.height = height;
					const ctx = out.getContext("2d");
					if (ctx) {
						ctx.drawImage(gl, 0, 0, width, height);
						const scale = width / (gl.width / (window.devicePixelRatio || 1));
						ctx.scale(scale, scale);
						stage.drawLabels?.(ctx, width / scale, height / scale, LIGHT);
					}
					stage.theme = DARK;
					stage.render();
					if (!ctx) return resolve(null);
					out.toBlob((blob) => resolve(blob), "image/png");
				}),
		}),
		[],
	);

	return (
		<div ref={wrapRef} data-testid="plot-3d" className={cn("relative overflow-hidden", className)}>
			<canvas ref={glRef} className="block size-full cursor-grab touch-none active:cursor-grabbing" />
			<canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full" />
		</div>
	);
});

export default Plot3D;

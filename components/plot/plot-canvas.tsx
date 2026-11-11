"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { resolvePlot, squareView, withVectorValue, zoomView, type PlotDoc, type PlotView } from "@/src/core";
import { useColorMode } from "@/components/color-mode";
import { DARK_THEME, drawPlot, LIGHT_THEME, TIP_REACH } from "./draw";

/**
 * The live plot (fork, phase 5b — see FORK.md): a canvas that draws a graph
 * document and lets the learner pan (drag) and zoom (wheel, buttons). Units
 * are kept square: the document's x range is the truth and the y range is
 * fitted to the canvas around the view's centre, so circles look round.
 * A named vector written as plain numbers can be dragged by its tip
 * (phase 5d): the drag rewrites the numbers in its line.
 */

export interface PlotCanvasHandle {
	/** The view as drawn (y fitted to the canvas). */
	shownView: () => PlotView;
	/** A light-background PNG of the graph as shown — what the tutor sees. */
	toPng: () => Promise<Blob | null>;
}

const EXPORT_WIDTH = 1200;

export const PlotCanvas = forwardRef<
	PlotCanvasHandle,
	{
		doc: PlotDoc;
		onView?: (view: PlotView) => void;
		/** An edit made on the plot itself (a dragged vector). */
		onDoc?: (doc: PlotDoc) => void;
		/** "wheel": the scroll wheel zooms (the full-window grapher). "pinch":
		 *  only a pinch does, so a graph inside the lesson never traps scrolling. */
		zoomWith?: "wheel" | "pinch";
		className?: string;
	}
>(function PlotCanvas({ doc, onView, onDoc, zoomWith = "wheel", className }, ref) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const mode = useColorMode();
	const drag = useRef<{ x: number; y: number; view: PlotView } | { vector: string } | null>(null);
	const [overTip, setOverTip] = useState(false);
	const tips = useMemo(
		() => (onDoc ? resolvePlot(doc).lines.flatMap((line, index) => (line.kind === "vector" && line.draggable && !doc.lines[index]!.hidden ? [{ id: line.id, x: line.value[0]!, y: line.value[1]! }] : [])) : []),
		[doc, onDoc],
	);

	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		const measure = () => setSize({ width: wrap.clientWidth, height: wrap.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(wrap);
		return () => observer.disconnect();
	}, []);

	const shown = useCallback(() => squareView(doc.view, size.width, size.height), [doc.view, size.width, size.height]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || size.width === 0 || size.height === 0) return;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.round(size.width * ratio);
		canvas.height = Math.round(size.height * ratio);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		drawPlot(ctx, size.width, size.height, doc, shown(), mode === "light" ? LIGHT_THEME : DARK_THEME);
	}, [doc, size, shown, mode]);

	useImperativeHandle(
		ref,
		() => ({
			shownView: shown,
			toPng: () =>
				new Promise((resolve) => {
					if (size.width === 0 || size.height === 0) return resolve(null);
					const width = EXPORT_WIDTH;
					const height = Math.round((EXPORT_WIDTH * size.height) / size.width);
					const canvas = document.createElement("canvas");
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext("2d");
					if (!ctx) return resolve(null);
					drawPlot(ctx, width, height, doc, shown(), LIGHT_THEME);
					canvas.toBlob((blob) => resolve(blob), "image/png");
				}),
		}),
		[doc, shown, size],
	);

	const graphPoint = (clientX: number, clientY: number) => {
		const rect = canvasRef.current!.getBoundingClientRect();
		const view = shown();
		return {
			x: view.xMin + ((clientX - rect.left) / rect.width) * (view.xMax - view.xMin),
			y: view.yMax - ((clientY - rect.top) / rect.height) * (view.yMax - view.yMin),
		};
	};
	/** The draggable vector whose tip is under the pointer; the last drawn wins. */
	const tipAt = (clientX: number, clientY: number): string | null => {
		const canvas = canvasRef.current;
		if (!canvas || tips.length === 0) return null;
		const rect = canvas.getBoundingClientRect();
		const view = shown();
		for (const tip of [...tips].reverse()) {
			const tipX = rect.left + ((tip.x - view.xMin) / (view.xMax - view.xMin)) * rect.width;
			const tipY = rect.top + ((view.yMax - tip.y) / (view.yMax - view.yMin)) * rect.height;
			if (Math.hypot(clientX - tipX, clientY - tipY) <= TIP_REACH) return tip.id;
		}
		return null;
	};
	const zoomBy = (factor: number, at?: { x: number; y: number }) => {
		if (!onView) return;
		const view = shown();
		const centre = at ?? { x: (view.xMin + view.xMax) / 2, y: (view.yMin + view.yMax) / 2 };
		const next = zoomView(view, centre.x, centre.y, factor);
		// Stay within what floating point can draw.
		if (next.xMax - next.xMin > 1e-7 && next.xMax - next.xMin < 1e9) onView(next);
	};

	// A non-passive wheel listener: zooming must not also scroll the page behind.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !onView) return;
		const onWheel = (event: WheelEvent) => {
			// A trackpad pinch arrives as a wheel event with ctrlKey set.
			if (zoomWith === "pinch" && !event.ctrlKey) return;
			event.preventDefault();
			zoomBy(Math.exp(event.deltaY * 0.0015), graphPoint(event.clientX, event.clientY));
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });
		return () => canvas.removeEventListener("wheel", onWheel);
	});

	const zoomButton = "flex size-7 items-center justify-center rounded-sm border border-border bg-card/90 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
	return (
		<div ref={wrapRef} data-testid="plot-canvas" className={cn("relative overflow-hidden", className)}>
			<canvas
				ref={canvasRef}
				className={cn("block size-full touch-none", overTip ? "cursor-move" : onView && "cursor-grab active:cursor-grabbing")}
				onPointerDown={(event) => {
					const vector = tipAt(event.clientX, event.clientY);
					if (!vector && !onView) return;
					event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = vector ? { vector } : { x: event.clientX, y: event.clientY, view: shown() };
				}}
				onPointerMove={(event) => {
					const start = drag.current;
					if (!start) {
						const over = tipAt(event.clientX, event.clientY) !== null;
						if (over !== overTip) setOverTip(over);
						return;
					}
					if ("vector" in start) {
						// Rounded to about four pixels' worth, so a drag lands on tidy numbers.
						const rect = event.currentTarget.getBoundingClientRect();
						const view = shown();
						const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10((view.xMax - view.xMin) / rect.width)) - 1));
						const point = graphPoint(event.clientX, event.clientY);
						onDoc?.(withVectorValue(doc, start.vector, [Number(point.x.toFixed(digits)), Number(point.y.toFixed(digits))]));
						return;
					}
					if (!onView) return;
					const rect = event.currentTarget.getBoundingClientRect();
					const dx = ((event.clientX - start.x) / rect.width) * (start.view.xMax - start.view.xMin);
					const dy = ((event.clientY - start.y) / rect.height) * (start.view.yMax - start.view.yMin);
					onView({ xMin: start.view.xMin - dx, xMax: start.view.xMax - dx, yMin: start.view.yMin + dy, yMax: start.view.yMax + dy });
				}}
				onPointerUp={() => {
					drag.current = null;
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
			/>
			{onView && (
				<div className="absolute bottom-2 right-2 flex flex-col gap-1">
					<button type="button" data-testid="plot-zoom-in" aria-label="Zoom in" onClick={() => zoomBy(0.7)} className={zoomButton}>
						+
					</button>
					<button type="button" data-testid="plot-zoom-out" aria-label="Zoom out" onClick={() => zoomBy(1 / 0.7)} className={zoomButton}>
						−
					</button>
					<button type="button" data-testid="plot-home" aria-label="Reset the view" title="Reset the view" onClick={() => onView({ xMin: -10, xMax: 10, yMin: -10, yMax: 10 })} className={zoomButton}>
						⌂
					</button>
				</div>
			)}
		</div>
	);
});

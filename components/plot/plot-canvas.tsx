"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { squareView, zoomView, type PlotDoc, type PlotView } from "@/src/core";
import { DARK_THEME, drawPlot, LIGHT_THEME } from "./draw";

/**
 * The live plot (fork, phase 5b — see FORK.md): a canvas that draws a graph
 * document and lets the learner pan (drag) and zoom (wheel, buttons). Units
 * are kept square: the document's x range is the truth and the y range is
 * fitted to the canvas around the view's centre, so circles look round.
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
		/** "wheel": the scroll wheel zooms (the full-window grapher). "pinch":
		 *  only a pinch does, so a graph inside the lesson never traps scrolling. */
		zoomWith?: "wheel" | "pinch";
		className?: string;
	}
>(function PlotCanvas({ doc, onView, zoomWith = "wheel", className }, ref) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const drag = useRef<{ x: number; y: number; view: PlotView } | null>(null);

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
		drawPlot(ctx, size.width, size.height, doc, shown(), DARK_THEME);
	}, [doc, size, shown]);

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
				className={cn("block size-full touch-none", onView && "cursor-grab active:cursor-grabbing")}
				onPointerDown={(event) => {
					if (!onView) return;
					event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = { x: event.clientX, y: event.clientY, view: shown() };
				}}
				onPointerMove={(event) => {
					const start = drag.current;
					if (!start || !onView) return;
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

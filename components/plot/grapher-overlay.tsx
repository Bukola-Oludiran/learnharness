"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { emptyPlotDoc, type PlotDoc } from "@/src/core";
import { Grapher, hasDrawableLines } from "./grapher";
import type { PlotCanvasHandle } from "./plot-canvas";

/**
 * The grapher, full-window (fork, phase 5b — see FORK.md). Opened from the
 * answer dock's Graph button ("Use graph" hands back a picture and the
 * document) or from a tutor graph's "Open in grapher" (a copy to explore;
 * nothing is sent).
 */

const QUIET = "rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";

interface SessionPlot {
	id: string;
	from: "tutor" | "you";
	doc: PlotDoc;
}

/** "Tutor's graph 2 · Parabolas" — the start-from list's label. Pure. */
export function sessionPlotLabel(plot: Pick<SessionPlot, "from" | "doc">, numberOfKind: number): string {
	const base = plot.from === "tutor" ? `Tutor's graph ${numberOfKind}` : `Your graph ${numberOfKind}`;
	const hint = plot.doc.title ?? plot.doc.lines.find((line) => line.text.trim())?.text.trim();
	return hint ? `${base} · ${hint.slice(0, 40)}` : base;
}

export function GrapherOverlay({
	chatId,
	initial,
	onUse,
	onClose,
}: {
	/** The session whose graphs can be started from. */
	chatId?: string;
	initial?: PlotDoc;
	/** Present when the graph can be attached to an answer. */
	onUse?: (image: File, doc: PlotDoc) => void;
	onClose: () => void;
}) {
	const [doc, setDoc] = useState<PlotDoc>(() => initial ?? emptyPlotDoc());
	const [plots, setPlots] = useState<SessionPlot[]>([]);
	const [startFrom, setStartFrom] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canvasRef = useRef<PlotCanvasHandle>(null);

	useEffect(() => {
		if (!chatId) return;
		const controller = new AbortController();
		void fetch(`/api/chats/${encodeURIComponent(chatId)}/plots`, { cache: "no-store", signal: controller.signal })
			.then(async (res) => (res.ok ? setPlots(((await res.json()) as { plots: SessionPlot[] }).plots) : undefined))
			.catch(() => undefined);
		return () => controller.abort();
	}, [chatId]);

	// While the grapher is open every key belongs to it (typing an
	// expression must not trigger app shortcuts); Esc closes it.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			event.stopPropagation();
			if (event.key === "Escape" && !busy) {
				event.preventDefault();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, onClose]);

	const use = async () => {
		const canvas = canvasRef.current;
		if (!canvas || !onUse || busy) return;
		setBusy(true);
		setError(null);
		const image = await canvas.toPng();
		if (!image) {
			setError("Could not export the graph. Try again.");
			setBusy(false);
			return;
		}
		// The tutor is told the view as it was drawn.
		onUse(new File([image], "graph.png", { type: "image/png" }), { ...doc, view: canvas.shownView() });
	};

	let tutorCount = 0;
	let ownCount = 0;
	return createPortal(
		<div role="dialog" aria-modal="true" aria-label="Grapher" data-testid="grapher-overlay" className="lh-no-drag fixed inset-0 z-50 flex flex-col bg-background">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">{onUse ? "Graph your answer" : "Grapher"}</span>
				{plots.length > 0 && (
					<select
						data-testid="grapher-start-from"
						aria-label="Start from"
						value={startFrom}
						disabled={busy}
						onChange={(event) => {
							setStartFrom(event.target.value);
							const picked = plots.find((plot) => plot.id === event.target.value);
							setDoc(picked ? picked.doc : emptyPlotDoc());
						}}
						className="ml-2 max-w-72 rounded-sm border border-input bg-background px-1.5 py-1 text-xs"
					>
						<option value="">Blank graph</option>
						{plots.map((plot) => (
							<option key={plot.id} value={plot.id}>
								Start from {sessionPlotLabel(plot, plot.from === "tutor" ? ++tutorCount : ++ownCount)}
							</option>
						))}
					</select>
				)}
				{error && (
					<span role="alert" className="ml-2 text-xs text-destructive">
						{error}
					</span>
				)}
				<span className="flex-1" />
				<button type="button" data-testid="grapher-close" onClick={onClose} disabled={busy} className={QUIET}>
					{onUse ? "Cancel" : "Close"}
				</button>
				{onUse && (
					<button type="button" data-testid="grapher-use" onClick={() => void use()} disabled={busy || !hasDrawableLines(doc)} className={ACTION}>
						{busy ? "Attaching…" : "Use graph"}
					</button>
				)}
			</div>
			<Grapher doc={doc} onChange={setDoc} canvasRef={canvasRef} className="flex-1" />
		</div>,
		document.body,
	);
}

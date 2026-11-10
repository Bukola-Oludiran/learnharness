"use client";

import { useState } from "react";
import { MaximizeIcon } from "lucide-react";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { GrapherOverlay } from "@/components/plot/grapher-overlay";
import { PlotSurface, TransformSlider } from "@/components/plot/grapher";
import { cleanPlotDoc, DEFAULT_SLIDER, PLOT_COLORS, resolvePlot, withSliderValue, withTransformAt, type ArtifactPartProps, type PlotDoc } from "@/src/core";

/**
 * The graph card (fork, phase 5b — see FORK.md): a graph the tutor placed
 * with the `graph` tool, live in the transcript — pan, zoom, drag its
 * sliders — with "Open in grapher" for a copy to edit. The card's changes
 * are the learner's exploration and are not saved back to the record. A
 * failed or still-running call keeps the quiet tool-call card.
 */

/** The card's body for a graph document — exported for render tests. */
export function GraphCardBody({ initial }: { initial: PlotDoc }) {
	const [doc, setDoc] = useState(initial);
	const [open, setOpen] = useState(false);
	const resolved = resolvePlot(doc);
	const sliders = resolved.lines.flatMap((line, index) => (line.kind === "definition" && line.slider ? [{ line, source: doc.lines[index]!, index }] : []));
	const transforms = resolved.lines.flatMap((line, index) => (line.kind === "transform" && !doc.lines[index]!.hidden ? [{ line, source: doc.lines[index]!, index }] : []));
	const shown = doc.lines.filter((line, index) => line.text.trim() && resolved.lines[index]!.kind !== "definition" && resolved.lines[index]!.kind !== "error");
	return (
		<figure data-testid="graph-card" className="my-3 w-full max-w-2xl overflow-hidden rounded-lg border border-border">
			{/* Inside the lesson the wheel scrolls the lesson; a pinch or the buttons zoom the graph. */}
			<PlotSurface doc={doc} onChange={setDoc} zoomWith="pinch" className={doc.mode === "3d" ? "h-96 w-full" : "h-80 w-full"} />
			{sliders.length > 0 && (
				<div className="border-t border-border px-3 py-2">
					{sliders.map(({ line, source, index }) => {
						const min = source.min ?? DEFAULT_SLIDER.min;
						const max = source.max ?? DEFAULT_SLIDER.max;
						return (
							<label key={source.id} data-testid="graph-card-slider" className="flex items-center gap-2 py-0.5 font-mono text-xs">
								<span className="w-20 shrink-0 truncate">
									{line.name} = {Number.isFinite(line.value) ? Math.round(line.value * 100) / 100 : "?"}
								</span>
								<input
									type="range"
									aria-label={`${line.name} slider`}
									min={min}
									max={max}
									step={(max - min) / 200}
									value={Number.isFinite(line.value) ? Math.min(max, Math.max(min, line.value)) : min}
									onChange={(event) => setDoc(withSliderValue(doc, source.id, Number(event.target.value)))}
									className="min-w-0 flex-1"
									style={{ accentColor: PLOT_COLORS[(source.color ?? index) % PLOT_COLORS.length] }}
								/>
							</label>
						);
					})}
				</div>
			)}
			{transforms.length > 0 && (
				<div className="border-t border-border px-3 py-2">
					{transforms.map(({ line, source, index }) => (
						<div key={source.id} className="py-0.5">
							<TransformSlider at={line.at} color={PLOT_COLORS[(source.color ?? index) % PLOT_COLORS.length]!} onAt={(at) => setDoc(withTransformAt(doc, source.id, at))} />
						</div>
					))}
				</div>
			)}
			<figcaption className="flex items-start gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
				<span className="min-w-0 flex-1">
					<span className="mr-2 uppercase tracking-wider text-muted-foreground/70">{doc.mode === "3d" ? "3D graph" : "Graph"}</span>
					{doc.title && <span className="mr-2 text-foreground">{doc.title}</span>}
					<span className="font-mono">
						{shown.map((line, index) => (
							<span key={line.id} className="mr-3 whitespace-nowrap" style={{ color: PLOT_COLORS[(line.color ?? index) % PLOT_COLORS.length] }}>
								{line.text.trim()}
							</span>
						))}
					</span>
				</span>
				<button type="button" data-testid="graph-card-open" onClick={() => setOpen(true)} className="flex shrink-0 items-center gap-1 transition-colors hover:text-foreground">
					<MaximizeIcon className="size-3" />
					Open in grapher
				</button>
			</figcaption>
			{open && <GrapherOverlay initial={doc} onClose={() => setOpen(false)} />}
		</figure>
	);
}

export function GraphCard(props: ArtifactPartProps) {
	const part = props.part as { state?: string; output?: unknown; errorText?: string };
	const doc = part.state === "output-available" || part.output != null ? cleanPlotDoc(part.output) : null;
	if (!doc || doc.lines.length === 0 || typeof part.errorText === "string") return <ToolCallCard {...props} />;
	return <GraphCardBody initial={doc} />;
}

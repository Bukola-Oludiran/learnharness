"use client";

import { useMemo, useRef } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_SLIDER, MAX_LINE_CHARS, MAX_PLOT_LINES, nextLineId, PLOT_COLORS, resolvePlot, withSliderValue, type PlotDoc, type PlotLine, type ResolvedLine } from "@/src/core";
import { PlotCanvas, type PlotCanvasHandle } from "./plot-canvas";

/**
 * The grapher (fork, phase 5b — see FORK.md): an expression list beside the
 * plot. The document is the single state; every edit returns a new one.
 */

/** The letter an "is not defined" error asks for, if that is what the error is. */
export function missingName(error: string): string | null {
	return /^"([A-Za-z])" is not defined\./.exec(error)?.[1] ?? null;
}

/** The document with a slider line for `name` added at the end. Pure. */
export function withSlider(doc: PlotDoc, name: string): PlotDoc {
	return { ...doc, lines: [...doc.lines, { id: nextLineId(doc), text: `${name} = 1`, color: doc.lines.length % PLOT_COLORS.length }] };
}

/** Whether the document has anything to draw. Pure. */
export function hasDrawableLines(doc: PlotDoc): boolean {
	return resolvePlot(doc).lines.some((line, index) => !doc.lines[index]!.hidden && !["empty", "error", "definition"].includes(line.kind));
}

const NUMBER_FIELD = "w-14 rounded-sm border border-input bg-background px-1 py-0.5 text-right font-mono text-xs";

/** One expression row. Pure — exported for render tests. */
export function ExpressionRow({
	line,
	meaning,
	index,
	onText,
	onToggle,
	onRemove,
	onEnter,
	onSlider,
	onRange,
	onAddSlider,
	inputRef,
}: {
	line: PlotLine;
	meaning: ResolvedLine;
	index: number;
	onText: (text: string) => void;
	onToggle: () => void;
	onRemove: () => void;
	onEnter: () => void;
	onSlider: (value: number) => void;
	onRange: (min: number, max: number) => void;
	onAddSlider: (name: string) => void;
	inputRef?: (element: HTMLInputElement | null) => void;
}) {
	const color = PLOT_COLORS[(line.color ?? index) % PLOT_COLORS.length]!;
	const min = line.min ?? DEFAULT_SLIDER.min;
	const max = line.max ?? DEFAULT_SLIDER.max;
	const missing = meaning.kind === "error" ? missingName(meaning.error) : null;
	return (
		<div data-testid="plot-line" data-kind={meaning.kind} className="border-b border-border/50 px-2 py-2">
			<div className="flex items-center gap-2">
				<button
					type="button"
					data-testid="plot-line-toggle"
					aria-label={line.hidden ? "Show this expression" : "Hide this expression"}
					aria-pressed={!line.hidden}
					onClick={onToggle}
					className="size-4 shrink-0 rounded-full border-2"
					style={{ borderColor: color, backgroundColor: line.hidden || meaning.kind === "definition" ? "transparent" : color }}
				/>
				<input
					ref={inputRef}
					data-testid="plot-line-input"
					aria-label={`Expression ${index + 1}`}
					value={line.text}
					maxLength={MAX_LINE_CHARS}
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					placeholder={index === 0 ? "y = x^2" : ""}
					onChange={(event) => onText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							onEnter();
						}
					}}
					className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/40"
				/>
				<button type="button" data-testid="plot-line-remove" aria-label="Remove this expression" onClick={onRemove} className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground">
					<XIcon className="size-3.5" />
				</button>
			</div>
			{meaning.kind === "error" && (
				<p data-testid="plot-line-error" className="mt-1 pl-6 text-xs text-destructive">
					{meaning.error}{" "}
					{missing && (
						<button type="button" data-testid="plot-add-slider" onClick={() => onAddSlider(missing)} className="underline decoration-dotted underline-offset-2 hover:text-foreground">
							Add slider {missing}
						</button>
					)}
				</p>
			)}
			{meaning.kind === "definition" && meaning.slider && (
				<div className="mt-1.5 flex items-center gap-1.5 pl-6" data-testid="plot-slider">
					<input
						type="number"
						aria-label={`${meaning.name} minimum`}
						value={min}
						onChange={(event) => onRange(Number(event.target.value), max)}
						className={NUMBER_FIELD}
					/>
					<input
						type="range"
						aria-label={`${meaning.name} slider`}
						min={min}
						max={max}
						step={(max - min) / 200}
						value={Number.isFinite(meaning.value) ? Math.min(max, Math.max(min, meaning.value)) : min}
						onChange={(event) => onSlider(Number(event.target.value))}
						className="min-w-0 flex-1"
						style={{ accentColor: color }}
					/>
					<input
						type="number"
						aria-label={`${meaning.name} maximum`}
						value={max}
						onChange={(event) => onRange(min, Number(event.target.value))}
						className={NUMBER_FIELD}
					/>
				</div>
			)}
		</div>
	);
}

export function Grapher({ doc, onChange, canvasRef, className }: { doc: PlotDoc; onChange: (doc: PlotDoc) => void; canvasRef?: React.Ref<PlotCanvasHandle>; className?: string }) {
	const resolved = useMemo(() => resolvePlot(doc), [doc]);
	const inputs = useRef(new Map<string, HTMLInputElement>());
	const focusSoon = (id: string) => requestAnimationFrame(() => inputs.current.get(id)?.focus());
	const patch = (id: string, change: Partial<PlotLine>) => onChange({ ...doc, lines: doc.lines.map((line) => (line.id === id ? { ...line, ...change } : line)) });
	const addAfter = (index: number) => {
		if (doc.lines.length >= MAX_PLOT_LINES) return;
		const id = nextLineId(doc);
		const used = new Set(doc.lines.map((line) => line.color));
		const color = PLOT_COLORS.findIndex((_, i) => !used.has(i));
		const lines = [...doc.lines];
		lines.splice(index + 1, 0, { id, text: "", color: color >= 0 ? color : doc.lines.length % PLOT_COLORS.length });
		onChange({ ...doc, lines });
		focusSoon(id);
	};
	return (
		<div data-testid="grapher" className={cn("flex min-h-0", className)}>
			<div className="flex w-80 shrink-0 flex-col border-r border-border">
				<div className="min-h-0 flex-1 overflow-y-auto">
					{doc.lines.map((line, index) => (
						<ExpressionRow
							key={line.id}
							line={line}
							meaning={resolved.lines[index]!}
							index={index}
							inputRef={(element) => {
								if (element) inputs.current.set(line.id, element);
								else inputs.current.delete(line.id);
							}}
							onText={(text) => patch(line.id, { text })}
							onToggle={() => patch(line.id, { hidden: !line.hidden })}
							onRemove={() => onChange({ ...doc, lines: doc.lines.length > 1 ? doc.lines.filter((l) => l.id !== line.id) : [{ ...line, text: "" }] })}
							onEnter={() => addAfter(index)}
							onSlider={(value) => onChange(withSliderValue(doc, line.id, value))}
							onRange={(min, max) => {
								if (Number.isFinite(min) && Number.isFinite(max) && min < max) patch(line.id, { min, max });
							}}
							onAddSlider={(name) => onChange(withSlider(doc, name))}
						/>
					))}
				</div>
				<button
					type="button"
					data-testid="plot-add-line"
					onClick={() => addAfter(doc.lines.length - 1)}
					disabled={doc.lines.length >= MAX_PLOT_LINES}
					className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
				>
					<PlusIcon className="size-3" />
					Add expression
				</button>
			</div>
			<PlotCanvas ref={canvasRef} doc={doc} onView={(view) => onChange({ ...doc, view })} className="min-w-0 flex-1" />
		</div>
	);
}

"use client";

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardIcon, PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Keypad, type Key } from "./keypad";
import { MATH_LINE_CSS, MathLine, type LineHandle } from "./math-line";
import { formatEntry, formatResult, formatValue, functionHeader, withoutTypeset, DEFAULT_SLIDER, MAX_LINE_CHARS, MAX_PLOT_LINES, nextLineId, PLOT_COLORS, resolvePlot, withMode, withSliderValue, type PlotDoc, type PlotLine, type PlotMode, type ResolvedLine } from "@/src/core";
import { PlotCanvas, type PlotCanvasHandle } from "./plot-canvas";

/**
 * The grapher (fork, phase 5b — see FORK.md): an expression list beside the
 * plot. The document is the single state; every edit returns a new one.
 */

// three.js is fetched the first time a 3D graph is shown.
const Plot3D = lazy(() => import("./plot-3d"));

/** The plot for a document, in its mode. `zoomWith` as on PlotCanvas. */
export function PlotSurface({
	doc,
	onChange,
	canvasRef,
	zoomWith = "wheel",
	className,
}: {
	doc: PlotDoc;
	onChange: (doc: PlotDoc) => void;
	canvasRef?: React.Ref<PlotCanvasHandle>;
	zoomWith?: "wheel" | "pinch";
	className?: string;
}) {
	if (doc.mode === "3d") {
		return (
			<Suspense fallback={<div data-testid="plot-3d-loading" className={className} />}>
				<Plot3D ref={canvasRef} doc={doc} wheelZoom={zoomWith === "wheel"} className={className} />
			</Suspense>
		);
	}
	return <PlotCanvas ref={canvasRef} doc={doc} onView={(view) => onChange({ ...doc, view })} onDoc={onChange} zoomWith={zoomWith} className={className} />;
}

/** The radians / degrees switch (phase 5c2). Pure — exported for render tests. */
export function AngleSwitch({ degrees, onDegrees }: { degrees: boolean; onDegrees: (degrees: boolean) => void }) {
	return (
		<div role="group" aria-label="Angle unit" data-testid="plot-angles" className="flex border-b border-l border-border text-xs uppercase tracking-wider">
			{([false, true] as const).map((option) => (
				<button
					key={String(option)}
					type="button"
					data-testid={option ? "plot-angles-deg" : "plot-angles-rad"}
					aria-pressed={degrees === option}
					onClick={() => onDegrees(option)}
					className={cn("px-3 py-1.5 transition-colors", degrees === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
				>
					{option ? "deg" : "rad"}
				</button>
			))}
		</div>
	);
}

/** Where the keypad's shown/hidden choice is remembered. */
export const KEYPAD_KEY = "lh.grapher.keypad";

/** The 2D / 3D switch. Pure — exported for render tests. */
export function ModeSwitch({ mode, onMode }: { mode: PlotMode; onMode: (mode: PlotMode) => void }) {
	return (
		<div role="group" aria-label="Graph dimensions" data-testid="plot-mode" className="flex flex-1 border-b border-border text-xs uppercase tracking-wider">
			{(["2d", "3d"] as const).map((option) => (
				<button
					key={option}
					type="button"
					data-testid={`plot-mode-${option}`}
					aria-pressed={mode === option}
					onClick={() => onMode(option)}
					className={cn("flex-1 px-3 py-1.5 transition-colors", mode === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
				>
					{option}
				</button>
			))}
		</div>
	);
}

/** The letter an "is not defined" error asks for, if that is what the error is. */
export function missingName(error: string): string | null {
	return /^"([A-Za-zα-ωΑ-Ω])" is not defined\./.exec(error)?.[1] ?? null;
}

/** The document with a slider line for `name` added at the end. Pure. */
export function withSlider(doc: PlotDoc, name: string): PlotDoc {
	return { ...doc, lines: [...doc.lines, { id: nextLineId(doc), text: `${name} = 1`, color: doc.lines.length % PLOT_COLORS.length }] };
}

/** Whether the document has anything to draw. Pure. */
export function hasDrawableLines(doc: PlotDoc): boolean {
	return resolvePlot(doc).lines.some((line, index) => !doc.lines[index]!.hidden && !["empty", "error", "definition", "value", "matrix", "function"].includes(line.kind));
}

/** A matrix result, set out as a grid between brackets. Pure — exported for render tests. */
export function MatrixValue({ rows }: { rows: readonly (readonly number[])[] }) {
	return (
		<span data-testid="plot-line-matrix" role="img" aria-label={formatResult(rows as number[][])} className="inline-flex items-center gap-1.5 align-middle">
			<span>=</span>
			{/* Square brackets: a side rule with a short foot at top and bottom. */}
			<span className="inline-flex items-stretch">
				<span aria-hidden className="w-1 rounded-l-[2px] border-y border-l border-muted-foreground/70" />
				<span className="inline-grid gap-x-3 gap-y-0.5 px-1 py-0.5 text-right" style={{ gridTemplateColumns: `repeat(${rows[0]?.length ?? 1}, auto)` }}>
					{rows.flatMap((row, i) => row.map((entry, j) => <span key={`${i}-${j}`}>{formatEntry(entry)}</span>))}
				</span>
				<span aria-hidden className="w-1 rounded-r-[2px] border-y border-r border-muted-foreground/70" />
			</span>
		</span>
	);
}

const NUMBER_FIELD = "w-14 rounded-sm border border-input bg-background px-1 py-0.5 text-right font-mono text-xs";

/** One expression row. Pure — exported for render tests. */
export function ExpressionRow({
	line,
	meaning,
	index,
	onText,
	functions,
	onToggle,
	onRemove,
	onEnter,
	onSlider,
	onRange,
	onAddSlider,
	onSwitchMode,
	onFocus,
	inputRef,
	placeholder,
}: {
	/** The line took the cursor: the keypad types here. */
	onFocus?: () => void;
	/** Switch the graph to the mode this line needs. */
	onSwitchMode?: (mode: PlotMode) => void;
	line: PlotLine;
	meaning: ResolvedLine;
	index: number;
	/** An edit to the line: its text, and (from the maths editor) how it was typeset. */
	onText: (text: string, typeset?: { latex?: string; problem?: string }) => void;
	/** The graph's function names, so f(x) typesets as a call. */
	functions?: ReadonlySet<string>;
	onToggle: () => void;
	onRemove: () => void;
	onEnter: () => void;
	onSlider: (value: number) => void;
	onRange: (min: number, max: number) => void;
	onAddSlider: (name: string) => void;
	inputRef?: (handle: LineHandle | null) => void;
	placeholder?: string;
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
					style={{ borderColor: color, backgroundColor: line.hidden || meaning.kind === "definition" || meaning.kind === "matrix" ? "transparent" : color }}
				/>
				<MathLine
					text={line.text}
					latex={line.latex}
					functions={functions}
					index={index}
					placeholder={placeholder}
					onEdit={(edit) => onText(edit.text, { latex: edit.latex, problem: edit.problem })}
					onFocus={onFocus}
					onEnter={onEnter}
					handleRef={inputRef}
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
					{meaning.fix && onSwitchMode && (
						<button
							type="button"
							data-testid="plot-switch-mode"
							onClick={() => onSwitchMode(meaning.fix!)}
							className="underline decoration-dotted underline-offset-2 hover:text-foreground"
						>
							Switch to {meaning.fix.toUpperCase()}
						</button>
					)}
				</p>
			)}
			{(meaning.kind === "value" || (meaning.kind === "definition" && !meaning.slider)) && (
				<p data-testid="plot-line-value" className="mt-1 pl-6 font-mono text-xs text-muted-foreground">
					= {formatValue(meaning.value)}
				</p>
			)}
			{meaning.kind === "vector" && !meaning.literal && (
				<p data-testid="plot-line-value" className="mt-1 pl-6 font-mono text-xs text-muted-foreground">
					= {formatResult(meaning.value)}
				</p>
			)}
			{meaning.kind === "matrix" && !meaning.literal && (
				<p className="mt-1 pl-6 font-mono text-xs text-muted-foreground">
					<MatrixValue rows={meaning.value} />
				</p>
			)}
			{meaning.kind === "span" && (
				<p data-testid="plot-line-value" className="mt-1 pl-6 text-xs text-muted-foreground">
					= {meaning.note}
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
	const inputs = useRef(new Map<string, LineHandle>());
	const functions = useMemo(() => new Set(doc.lines.flatMap((line) => functionHeader(line.text)?.name ?? [])), [doc.lines]);
	const focused = useRef<string | null>(null);
	const [keypad, setKeypad] = useState(false);
	// Read after mount: local storage does not exist during server render.
	useEffect(() => {
		try {
			setKeypad(window.localStorage.getItem(KEYPAD_KEY) === "1");
		} catch {
			// no storage: the keypad simply starts hidden
		}
	}, []);
	const toggleKeypad = () => {
		const next = !keypad;
		setKeypad(next);
		try {
			window.localStorage.setItem(KEYPAD_KEY, next ? "1" : "0");
		} catch {
			// not remembered this time
		}
	};
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
	/** A keypad key edits the line that last had the cursor (the last line, if none has yet). */
	const pressKey = (key: Key) => {
		const id = focused.current && doc.lines.some((line) => line.id === focused.current) ? focused.current : doc.lines.at(-1)?.id;
		const index = doc.lines.findIndex((line) => line.id === id);
		const handle = id ? inputs.current.get(id) : undefined;
		if (!id || index < 0 || !handle) return;
		if (handle.press(key)) addAfter(index);
	};

	return (
		<div data-testid="grapher" className={cn("flex min-h-0", className)}>
			<style>{MATH_LINE_CSS}</style>
			<div className="flex w-80 shrink-0 flex-col border-r border-border">
				<div className="flex">
					<ModeSwitch mode={doc.mode} onMode={(mode) => onChange(withMode(doc, mode))} />
					<AngleSwitch
						degrees={doc.angles === "degrees"}
						onDegrees={(degrees) => {
							const { angles: _angles, ...rest } = doc;
							onChange(degrees ? { ...rest, angles: "degrees" } : rest);
						}}
					/>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{doc.lines.map((line, index) => (
						<ExpressionRow
							key={line.id}
							line={line}
							meaning={resolved.lines[index]!}
							index={index}
							inputRef={(handle) => {
								if (handle) inputs.current.set(line.id, handle);
								else inputs.current.delete(line.id);
							}}
							functions={functions}
							onText={(text, typeset) =>
								onChange({
									...doc,
									lines: doc.lines.map((l) =>
										l.id === line.id ? { ...withoutTypeset(l), text, ...(typeset?.latex !== undefined ? { latex: typeset.latex } : {}), ...(typeset?.problem ? { problem: typeset.problem } : {}) } : l,
									),
								})
							}
							onToggle={() => patch(line.id, { hidden: !line.hidden })}
							onRemove={() => onChange({ ...doc, lines: doc.lines.length > 1 ? doc.lines.filter((l) => l.id !== line.id) : [{ ...withoutTypeset(line), text: "" }] })}
							onEnter={() => addAfter(index)}
							onSlider={(value) => onChange(withSliderValue(doc, line.id, value))}
							onRange={(min, max) => {
								if (Number.isFinite(min) && Number.isFinite(max) && min < max) patch(line.id, { min, max });
							}}
							onAddSlider={(name) => onChange(withSlider(doc, name))}
							onSwitchMode={(mode) => onChange(withMode(doc, mode))}
							onFocus={() => {
								focused.current = line.id;
							}}
							placeholder={index === 0 ? (doc.mode === "3d" ? "z = x^2 + y^2" : "y = x^2") : undefined}
						/>
					))}
				</div>
				<div className="flex border-t border-border">
					<button
						type="button"
						data-testid="plot-add-line"
						onClick={() => addAfter(doc.lines.length - 1)}
						disabled={doc.lines.length >= MAX_PLOT_LINES}
						className="flex flex-1 items-center gap-1.5 px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
					>
						<PlusIcon className="size-3" />
						Add expression
					</button>
					<button
						type="button"
						data-testid="keypad-toggle"
						aria-label={keypad ? "Hide the keypad" : "Show the keypad"}
						aria-pressed={keypad}
						title={keypad ? "Hide the keypad" : "Show the scientific keypad"}
						onMouseDown={(event) => event.preventDefault()}
						onClick={toggleKeypad}
						className={cn("flex items-center border-l border-border px-3 transition-colors hover:bg-accent hover:text-foreground", keypad ? "bg-accent text-foreground" : "text-muted-foreground")}
					>
						<KeyboardIcon className="size-4" />
					</button>
				</div>
				{keypad && <Keypad onKey={pressKey} />}
			</div>
			<PlotSurface doc={doc} onChange={onChange} canvasRef={canvasRef} className="min-w-0 flex-1" />
		</div>
	);
}

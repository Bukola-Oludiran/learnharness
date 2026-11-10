"use client";

import { createElement, useEffect, useRef, useState } from "react";
import { MAX_LINE_CHARS, readLatex, textToLatex } from "@/src/core";
import { applyKey, type Key } from "./keypad";

/**
 * One expression line as a maths editor (fork, phase 5c3 — see FORK.md).
 *
 * MathLive's <math-field> edits LaTeX; the grapher's truth is plain text.
 * On every edit the field's LaTeX is converted (core/plot/latex.ts) and
 * both are reported: the text is what is parsed, saved and sent to the
 * tutor; the LaTeX only keeps the field showing exactly what was typed.
 * When the text changes from outside the field (a slider drag, a graph
 * the tutor placed) the field is re-typeset from the text.
 *
 * MathLive is browser-only and loads on first use. Until it has loaded —
 * and in server rendering and tests — the line is a plain text box, which
 * edits the same text and stays a working fallback if the editor cannot
 * load.
 */

/** What the grapher and the keypad can do to a line. */
export interface LineHandle {
	focus: () => void;
	/** Apply a keypad key. Returns true when the key asks for a new line. */
	press: (key: Key) => boolean;
}

interface Mathfield extends HTMLElement {
	getValue(format?: string): string;
	setValue(value: string, options?: { silenceNotifications?: boolean }): void;
	insert(latex: string, options?: Record<string, unknown>): boolean;
	executeCommand(command: string | [string, ...unknown[]]): boolean;
	mathVirtualKeyboardPolicy: string;
	popoverPolicy: string;
	menuItems: unknown[];
	smartFence: boolean;
	placeholder: string;
}

let loading: Promise<boolean> | null = null;
/** True once the editor is in: a line added later is an editor from its first frame, so it can take the cursor at once. */
let loaded = false;
/** Load MathLive once; false when it cannot be loaded (the text boxes stay). */
function loadEditor(): Promise<boolean> {
	loading ??= import("mathlive")
		.then((module) => {
			// Fonts are served by the app itself (scripts/copy-excalidraw-assets.mjs), so the editor works offline.
			module.MathfieldElement.fontsDirectory = "/mathlive/fonts";
			module.MathfieldElement.soundsDirectory = null;
			loaded = true;
			return true;
		})
		.catch(() => false);
	return loading;
}

/** The editor's look, matched to the grapher; its own keyboard and menu buttons are hidden (the grapher has a keypad). */
export const MATH_LINE_CSS = `
math-field.lh-math-line { display: block; min-width: 0; flex: 1 1 0%; background: transparent; color: inherit; border: 0; outline: none; font-size: 1.05rem; padding: 2px 0;
	--caret-color: currentColor; --selection-background-color: rgba(120, 160, 255, 0.35); --selection-color: inherit; --contains-highlight-background-color: transparent;
	--placeholder-color: rgba(128, 128, 128, 0.7); --smart-fence-color: currentColor; }
math-field.lh-math-line::part(virtual-keyboard-toggle), math-field.lh-math-line::part(menu-toggle) { display: none; }
math-field.lh-math-line::part(content) { padding: 0; }
`;

export function MathLine({
	text,
	latex,
	functions,
	index,
	placeholder,
	onEdit,
	onFocus,
	onEnter,
	handleRef,
}: {
	text: string;
	/** The line as last typed in the editor, when it was. */
	latex?: string;
	/** The graph's function names, so f(x) typesets as a call. */
	functions?: ReadonlySet<string>;
	index: number;
	placeholder?: string;
	/** `latex` is absent for an edit made in the plain text box. */
	onEdit: (edit: { text: string; latex?: string; problem?: string }) => void;
	onFocus?: () => void;
	onEnter: () => void;
	handleRef?: (handle: LineHandle | null) => void;
}) {
	const [ready, setReady] = useState(loaded);
	const fieldRef = useRef<Mathfield | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	// The latest callbacks, for listeners attached once.
	const live = useRef({ onEdit, onFocus, onEnter });
	live.current = { onEdit, onFocus, onEnter };

	useEffect(() => {
		let mounted = true;
		void loadEditor().then((ok) => {
			if (mounted && ok) setReady(true);
		});
		return () => {
			mounted = false;
		};
	}, []);

	const shown = latex ?? textToLatex(text, functions);

	// Configure the field and listen, once it exists.
	useEffect(() => {
		const field = fieldRef.current;
		if (!ready || !field) return;
		field.mathVirtualKeyboardPolicy = "manual";
		field.popoverPolicy = "off";
		field.menuItems = [];
		field.smartFence = true;
		const onInput = () => {
			const value = field.getValue("latex");
			const read = readLatex(value);
			live.current.onEdit({ text: read.text.slice(0, MAX_LINE_CHARS), latex: value, ...(read.problem ? { problem: read.problem } : {}) });
		};
		// Enter starts a new line. The editor reports it as a line break; the
		// key itself is watched too, and the two are counted once.
		let lastEnter = 0;
		const enter = (event: Event) => {
			event.preventDefault();
			if (performance.now() - lastEnter < 80) return;
			lastEnter = performance.now();
			live.current.onEnter();
		};
		const onBeforeInput = (event: Event) => {
			if ((event as InputEvent).inputType === "insertLineBreak") enter(event);
		};
		const onKeyDown = (event: Event) => {
			const key = event as KeyboardEvent;
			if (key.key === "Enter" && !key.shiftKey && !key.isComposing) enter(event);
		};
		const onFocusIn = () => live.current.onFocus?.();
		field.addEventListener("input", onInput);
		field.addEventListener("beforeinput", onBeforeInput);
		field.addEventListener("keydown", onKeyDown, { capture: true });
		field.addEventListener("focusin", onFocusIn);
		return () => {
			field.removeEventListener("input", onInput);
			field.removeEventListener("beforeinput", onBeforeInput);
			field.removeEventListener("keydown", onKeyDown, { capture: true });
			field.removeEventListener("focusin", onFocusIn);
		};
	}, [ready]);

	// Keep the field showing the line: its own typing already matches; anything else is re-typeset.
	useEffect(() => {
		const field = fieldRef.current;
		if (!ready || !field) return;
		if (field.getValue("latex") !== shown) field.setValue(shown, { silenceNotifications: true });
		field.placeholder = placeholder ? `\\text{${placeholder.replace(/[\\{}^_]/g, "")}}` : "";
	}, [ready, shown, placeholder]);

	useEffect(() => {
		if (!handleRef) return;
		handleRef({
			focus: () => (fieldRef.current ?? inputRef.current)?.focus(),
			press: (key) => {
				const field = fieldRef.current;
				if (key.action === "enter") return true;
				if (ready && field) {
					field.focus();
					if (key.action === "left") field.executeCommand("moveToPreviousChar");
					else if (key.action === "right") field.executeCommand("moveToNextChar");
					else if (key.action === "backspace") field.executeCommand("deleteBackward");
					else field.insert(key.latex ?? key.insert ?? "", { focus: true, selectionMode: "placeholder", format: "latex" });
					return false;
				}
				const input = inputRef.current;
				if (!input) return false;
				const result = applyKey(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, key);
				if ("enter" in result) return true;
				if (result.text !== input.value) live.current.onEdit({ text: result.text });
				requestAnimationFrame(() => {
					inputRef.current?.focus();
					inputRef.current?.setSelectionRange(result.caret, result.caret);
				});
				return false;
			},
		});
		return () => handleRef(null);
	}, [handleRef, ready]);

	if (ready) {
		return createElement("math-field", {
			ref: fieldRef,
			class: "lh-math-line",
			"data-testid": "plot-line-math",
			"aria-label": `Expression ${index + 1}`,
		});
	}
	return (
		<input
			ref={inputRef}
			data-testid="plot-line-input"
			aria-label={`Expression ${index + 1}`}
			value={text}
			maxLength={MAX_LINE_CHARS}
			spellCheck={false}
			autoCapitalize="off"
			autoCorrect="off"
			placeholder={placeholder ?? ""}
			onChange={(event) => onEdit({ text: event.target.value })}
			onFocus={onFocus}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					onEnter();
				}
			}}
			className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/40"
		/>
	);
}

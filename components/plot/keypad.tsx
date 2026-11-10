"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The grapher's scientific keypad (fork, phases 5c2–5d — see FORK.md).
 * A key has no logic of its own: it inserts at the cursor of the focused
 * expression line (or moves the cursor, deletes, or starts a new line). In
 * the maths editor it inserts a structure; in a plain text box, text.
 * Either way the grapher's one parser reads the result, so a key and
 * typing the same thing can never disagree.
 */

export interface Key {
	label: string;
	/** Text put at the cursor of a plain text box. */
	insert?: string;
	/** What the maths editor inserts instead, when it differs: LaTeX, with #? for a box to fill. */
	latex?: string;
	/** How far back from the end of the inserted text the cursor lands (inside the brackets of `sin()`). */
	back?: number;
	action?: "left" | "right" | "backspace" | "enter";
	/** Spoken name, where the label is a symbol. */
	name?: string;
	/** Columns the key spans. */
	span?: number;
}

// Each key carries two spellings: `insert` for a plain text box, `latex` for
// the maths editor, where #? is a box to fill and #@ takes what is selected
// (or, with nothing selected, what stands before the cursor — as "/" does).
const command = (name: string) => (["sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh", "ln", "log", "exp", "min", "max", "gcd", "det"].includes(name) ? `\\${name}` : `\\operatorname{${name}}`);
const LATEX_NAME: Record<string, string> = { asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan" };
const fn = (label: string, name: string, args = 1): Key => ({
	label,
	insert: `${name}(${args === 2 ? ", " : ""})`,
	back: args === 2 ? 3 : 1,
	latex: `${LATEX_NAME[name] ?? command(name)}\\left(${args === 2 ? "#?,#?" : "#?"}\\right)`,
	name: label,
});
const k = (label: string, insert = label, name?: string, latex?: string): Key => ({ label, insert, ...(name ? { name } : {}), ...(latex ? { latex } : {}) });
const GREEK_COMMANDS: Record<string, string> = { α: "alpha", β: "beta", γ: "gamma", δ: "delta", λ: "lambda", μ: "mu", σ: "sigma", φ: "phi", ω: "omega" };

export type KeypadTab = "main" | "functions" | "calculus" | "vectors" | "letters";

/** A matrix key: an empty grid in the editor, [[, ], [, ]] in a text box. */
const grid = (size: number): Key => {
	const row = Array.from({ length: size }, () => "").join(", ");
	const insert = `[${Array.from({ length: size }, () => `[${row}]`).join(", ")}]`;
	return {
		label: `${size}×${size}`,
		insert,
		// The cursor lands in the first entry.
		back: insert.length - 2,
		latex: `\\begin{bmatrix}${Array.from({ length: size }, () => Array.from({ length: size }, () => "#?").join("&")).join("\\\\")}\\end{bmatrix}`,
		name: `${size} by ${size} matrix`,
	};
};

export const KEYPAD: Record<KeypadTab, { columns: number; keys: Key[] }> = {
	main: {
		columns: 6,
		keys: [
			k("x"), k("y"), k("z"), k("t"), k("("), k(")"),
			k("7"), k("8"), k("9"), k("÷", "/", "divide", "\\frac{#@}{#?}"), k("^", "^", "power", "^{#?}"), k("x²", "^2", "squared", "^2"),
			k("4"), k("5"), k("6"), k("×", "*", "times", "\\cdot "), { label: "√", insert: "sqrt()", back: 1, latex: "\\sqrt{#?}", name: "square root" }, { label: "|a|", insert: "||", back: 1, latex: "\\left|#?\\right|", name: "absolute value" },
			k("1"), k("2"), k("3"), k("−", "-", "minus"), k("π", "pi", "pi", "\\pi "), k("e"),
			k("0"), k("."), k(","), k("+", "+", "plus"), k("="), k("!", "!", "factorial"),
		],
	},
	functions: {
		columns: 4,
		keys: [
			fn("sin", "sin"), fn("cos", "cos"), fn("tan", "tan"), fn("exp", "exp"),
			fn("sin⁻¹", "asin"), fn("cos⁻¹", "acos"), fn("tan⁻¹", "atan"), fn("ln", "ln"),
			fn("sec", "sec"), fn("csc", "csc"), fn("cot", "cot"), fn("log", "log"),
			fn("sec⁻¹", "asec"), fn("csc⁻¹", "acsc"), fn("cot⁻¹", "acot"), { ...fn("logₐ", "log", 2), latex: "\\log_{#?}\\left(#?\\right)", name: "log to a base" },
			fn("sinh", "sinh"), fn("cosh", "cosh"), fn("tanh", "tanh"), { ...fn("ⁿ√", "root", 2), latex: "\\sqrt[#?]{#?}", name: "nth root" },
			fn("sinh⁻¹", "asinh"), fn("cosh⁻¹", "acosh"), fn("tanh⁻¹", "atanh"), k("n!", "!", "factorial"),
			fn("nCr", "nCr", 2), fn("nPr", "nPr", 2), fn("mod", "mod", 2), { ...fn("abs", "abs"), latex: "\\left|#?\\right|" },
			fn("gcd", "gcd", 2), fn("lcm", "lcm", 2), fn("min", "min", 2), fn("max", "max", 2),
			fn("floor", "floor"), fn("ceil", "ceil"), fn("round", "round"), fn("sign", "sign"),
		],
	},
	// Phase 5c3: structures. In a text box each types its function form.
	calculus: {
		columns: 4,
		keys: [
			{ label: "∫", insert: "int(, x, , )", back: 8, latex: "\\int_{#?}^{#?}#?\\,\\mathrm{d}x", name: "definite integral" },
			{ label: "d/dx", insert: "deriv(, x)", back: 4, latex: "\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left(#?\\right)", name: "derivative" },
			{ label: "Σ", insert: "sum(, n, , )", back: 8, latex: "\\sum_{n=#?}^{#?}#?", name: "sum" },
			{ label: "Π", insert: "prod(, n, , )", back: 8, latex: "\\prod_{n=#?}^{#?}#?", name: "product" },
			{ label: "a/b", insert: "/", latex: "\\frac{#@}{#?}", name: "fraction" },
			{ label: "f(x)=", insert: "f(x) = ", latex: "f\\left(x\\right)=", name: "define a function" },
			{ label: "f(x)", insert: "f()", back: 1, latex: "f\\left(#?\\right)", name: "call f" },
			{ label: "f′", insert: "f'()", back: 1, latex: "f'\\left(#?\\right)", name: "derivative of f" },
			k("′", "'", "prime"), k("n"), k("k"), k("i"),
		],
	},
	// Phase 5d: vectors and matrices.
	vectors: {
		columns: 4,
		keys: [
			{ label: "(a, b)", insert: "(, )", back: 3, latex: "\\left(#?,#?\\right)", name: "vector with two entries" },
			{ label: "(a, b, c)", insert: "(, , )", back: 5, latex: "\\left(#?,#?,#?\\right)", name: "vector with three entries" },
			grid(2), grid(3),
			grid(4), k("u·v", "*", "dot product", "\\cdot "), k("u×v", "×", "cross product", "\\times "), { label: "|v|", insert: "norm()", back: 1, latex: "\\left|#?\\right|", name: "length of a vector" },
			k("Aᵀ", "^T", "transpose", "^{T}"), k("A⁻¹", "^-1", "inverse", "^{-1}"), fn("det", "det"), fn("trace", "trace"),
			fn("span", "span"), k("u"), k("v"), k("w"),
			k("A"), k("B"), k("="), k(","),
			// Phase 5d-2: the visual tools.
			fn("transform", "transform"), fn("eigen", "eigen"), fn("solve", "solve", 2), k("b"),
		],
	},
	letters: {
		columns: 7,
		keys: [..."abcdefghijklmnopqrstuvwxyz"]
			.map((letter) => k(letter))
			.concat([k("θ", "theta", "theta", "\\theta "), ...[..."αβγδλμσφω"].map((letter) => k(letter, letter, undefined, `\\${GREEK_COMMANDS[letter]} `))]),
	},
};

const ACTIONS: Key[] = [
	{ label: "←", action: "left", name: "move left" },
	{ label: "→", action: "right", name: "move right" },
	{ label: "⌫", action: "backspace", name: "delete" },
	{ label: "↵", action: "enter", name: "new line", span: 3 },
];

export type KeyResult = { text: string; caret: number } | { enter: true };

/** What a key does to a line's text, given the selection. Pure. */
export function applyKey(text: string, selectionStart: number, selectionEnd: number, key: Key): KeyResult {
	const start = Math.max(0, Math.min(selectionStart, selectionEnd, text.length));
	const end = Math.max(start, Math.min(Math.max(selectionStart, selectionEnd), text.length));
	switch (key.action) {
		case "enter":
			return { enter: true };
		case "left":
			return { text, caret: start === end ? Math.max(0, start - 1) : start };
		case "right":
			return { text, caret: start === end ? Math.min(text.length, end + 1) : end };
		case "backspace":
			if (start !== end) return { text: text.slice(0, start) + text.slice(end), caret: start };
			return start === 0 ? { text, caret: 0 } : { text: text.slice(0, start - 1) + text.slice(start), caret: start - 1 };
		default: {
			const insert = key.insert ?? "";
			// A selection is wrapped by a bracketed key: select "x + 1", press sin → sin(x + 1).
			if (start !== end && key.back === 1 && insert.length >= 2) {
				const open = insert.slice(0, -1);
				const close = insert.slice(-1);
				const wrapped = `${open}${text.slice(start, end)}${close}`;
				return { text: text.slice(0, start) + wrapped + text.slice(end), caret: start + wrapped.length };
			}
			return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length - (key.back ?? 0) };
		}
	}
}

const TAB_LABEL: Record<KeypadTab, string> = { main: "123", functions: "f(x)", calculus: "∫ Σ", vectors: "[ ]", letters: "abc" };
const KEY = "flex h-8 items-center justify-center rounded-sm border border-border/70 bg-card text-xs transition-colors hover:bg-accent active:bg-accent/70";

export function Keypad({ onKey, initialTab = "main" }: { onKey: (key: Key) => void; initialTab?: KeypadTab }) {
	const [tab, setTab] = useState<KeypadTab>(initialTab);
	const layout = KEYPAD[tab];
	// A key must not take the focus (and so the cursor) away from the expression line.
	const keepFocus = (event: React.MouseEvent | React.PointerEvent) => event.preventDefault();
	const button = (key: Key, index: number) => (
		<button
			key={`${key.label}-${index}`}
			type="button"
			data-testid="keypad-key"
			data-key={key.action ?? key.insert}
			aria-label={key.name ?? key.label}
			title={key.name}
			tabIndex={-1}
			onMouseDown={keepFocus}
			onPointerDown={keepFocus}
			onClick={() => onKey(key)}
			className={cn(KEY, key.action ? "text-muted-foreground" : "font-mono")}
			style={key.span ? { gridColumn: `span ${key.span}` } : undefined}
		>
			{key.label}
		</button>
	);
	return (
		<div data-testid="keypad" className="border-t border-border bg-background p-2">
			<div role="tablist" aria-label="Keypad" className="mb-1.5 flex gap-1">
				{(Object.keys(KEYPAD) as KeypadTab[]).map((name) => (
					<button
						key={name}
						type="button"
						role="tab"
						data-testid={`keypad-tab-${name}`}
						aria-selected={tab === name}
						tabIndex={-1}
						onMouseDown={keepFocus}
						onClick={() => setTab(name)}
						className={cn("flex-1 rounded-sm px-2 py-1 font-mono text-xs transition-colors", tab === name ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
					>
						{TAB_LABEL[name]}
					</button>
				))}
			</div>
			<div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}>
				{layout.keys.map(button)}
			</div>
			<div className="mt-1 grid grid-cols-6 gap-1">{ACTIONS.map(button)}</div>
		</div>
	);
}

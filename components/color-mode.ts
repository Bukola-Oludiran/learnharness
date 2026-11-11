"use client";

import { useSyncExternalStore } from "react";

/**
 * The page's colour mode (fork, look 2 — see FORK.md). The truth is the
 * `dark` class on <html>: the stylesheet's `.dark` block and Tailwind's
 * `dark:` variant both read it. The appearance provider sets it from the
 * Mode setting; app/layout.tsx sets it before first paint from the copy
 * kept in this browser, so the app never opens in the wrong mode.
 *
 * Most of the app needs none of this: components use colour tokens and
 * follow the class by themselves. This hook is for what paints itself
 * (canvases, diagrams) and so must be told.
 */

export type ColorMode = "dark" | "light";

/** Where this browser remembers the mode between launches. */
export const MODE_STORAGE_KEY = "lh.mode";

/** The script the layout runs before first paint. The page is served dark; a remembered light mode removes the class. */
export const MODE_BOOT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)})==="light")document.documentElement.classList.remove("dark")}catch(e){}`;

export function currentColorMode(): ColorMode {
	return typeof document === "undefined" || document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Set the page's mode and remember it. */
export function applyColorMode(mode: ColorMode): void {
	document.documentElement.classList.toggle("dark", mode === "dark");
	try {
		window.localStorage.setItem(MODE_STORAGE_KEY, mode);
	} catch {
		// not remembered: the next launch opens dark until the setting loads
	}
}

function subscribe(onChange: () => void): () => void {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => observer.disconnect();
}

/** The current mode, re-rendering the caller when it changes. Dark during server render, as the page is served. */
export function useColorMode(): ColorMode {
	return useSyncExternalStore(subscribe, currentColorMode, () => "dark");
}

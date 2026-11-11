/**
 * Light and dark (fork, look 2 — FORK.md): the pure parts of the mode
 * switch. That the page actually repaints, opens without a flash and keeps
 * the choice was checked in a browser; a node test cannot see paint.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { currentColorMode, MODE_BOOT_SCRIPT, MODE_STORAGE_KEY } from "../components/color-mode.ts";
import { appearanceVars, derivedPalette, resolveAppearance } from "../components/settings/appearance.tsx";
import { STATE_TINT, stateTints } from "../components/idea-evidence.tsx";
import { LhMark } from "../components/lh-mark.tsx";
import { DARK_THEME, LIGHT_THEME } from "../components/plot/draw.ts";

const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const block = (selector: string) => {
	const start = css.indexOf(`\n${selector} {`);
	assert.ok(start >= 0, `${selector} block`);
	return css.slice(start, css.indexOf("\n}", start));
};
const token = (source: string, name: string) => new RegExp(`\\t--${name}: ([^;]+);`).exec(source)?.[1];

describe("the two palettes", () => {
	it(":root is light Ink and cobalt, .dark is dark Ink and cobalt, and each sets its colour scheme", () => {
		const light = block(":root");
		const dark = block(".dark");
		assert.match(light, /color-scheme: light;/);
		assert.match(dark, /color-scheme: dark;/);
		assert.deepEqual(["background", "foreground", "card", "primary", "border"].map((name) => token(light, name)), ["#f6f8fb", "#16223a", "#ffffff", "#1f4fd8", "#d3dbe8"]);
		assert.deepEqual(["background", "foreground", "card", "primary", "border"].map((name) => token(dark, name)), ["#131b2c", "#e6ecf7", "#1b2539", "#7da4ff", "#2d3b58"]);
	});

	it("every token the dark block sets, the light block sets too, so nothing is left dark on a light page", () => {
		const names = (source: string) => [...source.matchAll(/\t--([\w-]+):/g)].map((match) => match[1]!);
		const light = new Set(names(block(":root")));
		assert.deepEqual(names(block(".dark")).filter((name) => !light.has(name)), []);
	});
});

describe("the mode itself", () => {
	it("the page is served dark, and the pre-paint script only ever removes the class for a remembered light mode", () => {
		assert.equal(MODE_STORAGE_KEY, "lh.mode");
		assert.equal(MODE_BOOT_SCRIPT, 'try{if(localStorage.getItem("lh.mode")==="light")document.documentElement.classList.remove("dark")}catch(e){}');
		assert.equal(currentColorMode(), "dark", "with no document, as in a server render");
		const layout = fs.readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
		assert.match(layout, /className=\{`dark \$\{ui\.variable\} \$\{prose\.variable\}`\} suppressHydrationWarning>\s*<head>\s*<script dangerouslySetInnerHTML=\{\{ __html: MODE_BOOT_SCRIPT \}\} \/>/);
	});

	it("a custom background derives its surfaces for the mode: edges darker than the page in light, lighter in dark", () => {
		assert.deepEqual(derivedPalette("#141414"), derivedPalette("#141414", "dark"), "dark stays the default, as upstream's callers expect");
		const light = derivedPalette("#f0f0f0", "light");
		assert.deepEqual([light["--background"], light["--card"], light["--accent"], light["--border"]], ["#f0f0f0", "#f8f8f8", "#e2e2e2", "#cccccc"]);
		assert.equal(derivedPalette("#050505", "light")["--border"], "#000000", "never below black");
		assert.equal(appearanceVars(resolveAppearance({ mode: "light", background: "#f0f0f0" }))["--border"], "#cccccc");
		assert.equal(appearanceVars(resolveAppearance({ background: "#101010" }))["--border"], "#3f3f3f");
		assert.equal(resolveAppearance(undefined).mode, "dark", "the app stays dark until switched");
	});
});

describe("what paints itself", () => {
	it("idea tints, the grapher and the logo each have a version that reads in light", () => {
		assert.deepEqual(stateTints("light"), { demonstrated: "#17805a", shaky: "#a8690c", missed: "#c2362f" });
		assert.equal(stateTints("dark"), STATE_TINT);
		assert.equal(LIGHT_THEME.background, "#ffffff");
		assert.equal(DARK_THEME.background, "#131b2c");
		const mark = renderToStaticMarkup(<LhMark />);
		assert.doesNotMatch(mark, /#fff/, "the logo is no longer fixed white");
		assert.equal(mark.match(/fill:currentColor/g)?.length, 2);
	});
});

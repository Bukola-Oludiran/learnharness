/**
 * copy-excalidraw-assets.mjs (fork, phase 5a — see FORK.md): put the
 * canvas's fonts where the app serves them (public/excalidraw/fonts), so
 * drawing works offline. Excalidraw otherwise fetches them from a CDN.
 * Runs before `dev` and `build`; the copy is git-ignored.
 *
 * Xiaolai (a 12 MB handwritten CJK face) is left out: CJK text on the
 * canvas falls back to a system font.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FROM = path.join(ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const TO = path.join(ROOT, "public", "excalidraw", "fonts");

if (!fs.existsSync(FROM)) {
	console.error("[excalidraw-assets] fonts not found — run `npm install` first.");
	process.exit(1);
}
fs.rmSync(TO, { recursive: true, force: true });
fs.mkdirSync(TO, { recursive: true });
for (const family of fs.readdirSync(FROM)) {
	if (family === "Xiaolai") continue;
	fs.cpSync(path.join(FROM, family), path.join(TO, family), { recursive: true });
}
console.log(`[excalidraw-assets] fonts copied to ${path.relative(ROOT, TO)}`);

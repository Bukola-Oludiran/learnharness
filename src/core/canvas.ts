/**
 * Canvas domain logic (fork, phase 5a — see FORK.md): the outline of an
 * Excalidraw scene. A drawing reaches the tutor as a picture PLUS this
 * outline, computed from the scene's own structure: an arrow records the
 * ids of the shapes it is bound to, so "A → B" is a fact about the
 * drawing, not a reading of pixels. Pure; no IO and no Excalidraw import.
 */

/** The subset of an Excalidraw element the outline reads. */
export interface SceneElement {
	id: string;
	type: string;
	isDeleted?: boolean;
	x?: number;
	y?: number;
	/** text elements */
	text?: string;
	/** A text element bound inside a shape or onto an arrow. */
	containerId?: string | null;
	startBinding?: { elementId?: string } | null;
	endBinding?: { elementId?: string } | null;
	/** frames */
	name?: string | null;
}

export const MAX_SCENE_BYTES = 5 * 1024 * 1024;
const MAX_OUTLINE_LINES = 120;
const MAX_LABEL = 160;

const SHAPES = new Set(["rectangle", "ellipse", "diamond", "frame", "image"]);
const CONNECTORS = new Set(["arrow", "line"]);

const quote = (text: string) => JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL));

/** A, B, …, Z, AA, AB, … */
export function shapeLetter(index: number): string {
	let n = index;
	let out = "";
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

/** The scene's elements, when the value looks like a scene at all. */
export function sceneElements(scene: unknown): SceneElement[] | null {
	const elements = (scene as { elements?: unknown } | null)?.elements;
	if (!Array.isArray(elements)) return null;
	return elements.filter((el): el is SceneElement => el !== null && typeof el === "object" && typeof (el as SceneElement).id === "string" && typeof (el as SceneElement).type === "string");
}

/**
 * The outline of a scene: lettered shapes with their labels, arrows with
 * what they connect, loose text, and a count of freehand strokes. Shapes
 * are lettered in reading order (top to bottom, then left to right).
 * Empty string for an empty drawing.
 */
export function sceneOutline(all: readonly SceneElement[]): string {
	const elements = all.filter((el) => !el.isDeleted);
	const labelOf = new Map<string, string>();
	for (const el of elements) {
		if (el.type === "text" && el.containerId && typeof el.text === "string" && el.text.trim()) labelOf.set(el.containerId, el.text);
	}
	const shapes = elements
		.filter((el) => SHAPES.has(el.type))
		.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
	const letterOf = new Map(shapes.map((shape, index) => [shape.id, shapeLetter(index)]));
	const lines: string[] = [];
	if (shapes.length > 0) {
		lines.push("Shapes:");
		for (const shape of shapes) {
			const label = shape.type === "frame" ? (shape.name ?? labelOf.get(shape.id)) : labelOf.get(shape.id);
			lines.push(`- ${letterOf.get(shape.id)}: ${shape.type}${label?.trim() ? ` ${quote(label)}` : ", no label"}`);
		}
	}
	const connectors = elements.filter((el) => CONNECTORS.has(el.type));
	if (connectors.length > 0) {
		lines.push("Arrows:");
		for (const connector of connectors) {
			const from = letterOf.get(connector.startBinding?.elementId ?? "");
			const to = letterOf.get(connector.endBinding?.elementId ?? "");
			const label = labelOf.get(connector.id);
			const joiner = connector.type === "arrow" ? "→" : "—";
			const body =
				from && to
					? `${from} ${joiner} ${to}`
					: from
						? `from ${from} to nothing (not attached at its end)`
						: to
							? `from nothing to ${to} (not attached at its start)`
							: `a loose ${connector.type}, attached to nothing`;
			lines.push(`- ${body}${label?.trim() ? ` ${quote(label)}` : ""}`);
		}
	}
	const loose = elements.filter((el) => el.type === "text" && !el.containerId && typeof el.text === "string" && el.text.trim());
	if (loose.length > 0) lines.push(`Loose text: ${loose.map((el) => quote(el.text!)).join("; ")}`);
	const strokes = elements.filter((el) => el.type === "freedraw").length;
	if (strokes > 0) lines.push(`Freehand strokes: ${strokes}`);
	if (lines.length > MAX_OUTLINE_LINES) return [...lines.slice(0, MAX_OUTLINE_LINES), `(${lines.length - MAX_OUTLINE_LINES} more lines not shown)`].join("\n");
	return lines.join("\n");
}

/** The text block that precedes a drawing's image in the tutor's input
 *  (wording approved by the owner, 2026-11-10). */
export function drawingOutlineBlock(outline: string): string {
	return `The learner's drawing, as an outline computed from the canvas. Labels and connections are exact; layout is only in the image.\n\n${outline}`;
}

/** The paragraph the photo rule gains for canvas drawings (approved the same day). */
export const DRAWING_RULE =
	"A drawing made on the canvas arrives with an outline of its labelled shapes and arrows. Use the outline for what is labelled and what connects to what, and the image for layout. " +
	"When you give feedback, name the specific shapes and arrows you mean.";

/** One saved drawing of a session, as the canvas's "start from" list shows it. */
export interface CanvasSummary {
	/** The snapshot id of the drawing's image — its identity. */
	snapshotId: string;
	createdAt: string;
}

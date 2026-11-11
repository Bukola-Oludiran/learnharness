"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useColorMode } from "@/components/color-mode";
import type { CanvasSummary } from "@/src/core";

/**
 * The drawing canvas (fork, phase 5a — see FORK.md): Excalidraw in a
 * full-window overlay. "Use drawing" hands back a PNG and the scene; the
 * dock attaches the PNG like a photo and the server keeps the scene so the
 * drawing can be reopened and revised later in the session.
 *
 * This module is loaded lazily (answer-attachments.tsx): Excalidraw is
 * large and browser-only, and the docks must stay importable without it.
 */

type ExcalidrawApi = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>["excalidrawAPI"]>>[0];

declare global {
	interface Window {
		EXCALIDRAW_ASSET_PATH?: string;
	}
}
// The fonts are served by the app itself (scripts/copy-excalidraw-assets.mjs), so the canvas works offline.
if (typeof window !== "undefined") window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";

const QUIET = "rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";
const EXPORT_MAX_SIDE = 2000;

/** "Drawing 2 · 14:05" — the start-from list's label. */
export function canvasLabel(canvas: CanvasSummary, index: number): string {
	const at = new Date(canvas.createdAt);
	const time = Number.isNaN(at.getTime()) ? "" : ` · ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	return `Drawing ${index + 1}${time}`;
}

export default function CanvasEditor({
	chatId,
	onUse,
	onClose,
}: {
	chatId: string;
	/** The finished drawing: its picture and its editable scene. */
	onUse: (image: File, scene: string) => void;
	onClose: () => void;
}) {
	const apiRef = useRef<ExcalidrawApi | null>(null);
	const mode = useColorMode();
	const [earlier, setEarlier] = useState<CanvasSummary[]>([]);
	const [startFrom, setStartFrom] = useState("");
	const [empty, setEmpty] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		void fetch(`/api/chats/${encodeURIComponent(chatId)}/canvases`, { cache: "no-store", signal: controller.signal })
			.then(async (res) => (res.ok ? setEarlier(((await res.json()) as { canvases: CanvasSummary[] }).canvases.filter((canvas) => canvas.kind === "drawing")) : undefined))
			.catch(() => undefined);
		return () => controller.abort();
	}, [chatId]);

	// While the canvas is open every key belongs to it: claimed at the
	// document so the app's window-level shortcuts (and the one-Esc turn
	// abort) never fire. Excalidraw's own document listeners still run.
	useEffect(() => {
		const claim = (event: KeyboardEvent) => event.stopPropagation();
		document.addEventListener("keydown", claim);
		return () => document.removeEventListener("keydown", claim);
	}, []);

	const load = useCallback(
		async (snapshotId: string) => {
			const api = apiRef.current;
			if (!api) return;
			setError(null);
			if (!snapshotId) {
				api.resetScene();
				return;
			}
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/canvases/${snapshotId}`, { cache: "no-store" });
				if (!res.ok) throw new Error();
				const scene = (await res.json()) as { elements?: unknown[]; files?: Record<string, unknown> };
				api.resetScene();
				if (scene.files) api.addFiles(Object.values(scene.files) as never);
				api.updateScene({ elements: (scene.elements ?? []) as never });
				api.scrollToContent(undefined, { fitToContent: true });
			} catch {
				setError("Could not open that drawing.");
			}
		},
		[chatId],
	);

	const use = async () => {
		const api = apiRef.current;
		if (!api || busy) return;
		const elements = api.getSceneElements();
		if (elements.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const files = api.getFiles();
			// Always a light, opaque picture: the tutor reads it, whatever the app's theme.
			const appState = { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: "#ffffff" };
			const blob = await exportToBlob({ elements, appState, files, mimeType: "image/png", exportPadding: 24, maxWidthOrHeight: EXPORT_MAX_SIDE });
			onUse(new File([blob], "drawing.png", { type: "image/png" }), serializeAsJSON(elements, appState, files, "local"));
		} catch {
			setError("Could not export the drawing. Try again.");
			setBusy(false);
		}
	};

	return createPortal(
		<div role="dialog" aria-modal="true" aria-label="Drawing canvas" data-testid="canvas-editor" className="lh-no-drag fixed inset-0 z-50 flex flex-col bg-background">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Draw your answer</span>
				{earlier.length > 0 && (
					<select
						data-testid="canvas-start-from"
						aria-label="Start from"
						value={startFrom}
						disabled={busy}
						onChange={(event) => {
							setStartFrom(event.target.value);
							void load(event.target.value);
						}}
						className="ml-2 rounded-sm border border-input bg-background px-1.5 py-1 text-xs"
					>
						<option value="">Blank canvas</option>
						{earlier.map((canvas, index) => (
							<option key={canvas.snapshotId} value={canvas.snapshotId}>
								Start from {canvasLabel(canvas, index)}
							</option>
						))}
					</select>
				)}
				{error && (
					<span role="alert" data-testid="canvas-error" className="ml-2 text-xs text-destructive">
						{error}
					</span>
				)}
				<span className="flex-1" />
				<button type="button" data-testid="canvas-cancel" onClick={onClose} disabled={busy} className={QUIET}>
					Cancel
				</button>
				<button type="button" data-testid="canvas-use" onClick={() => void use()} disabled={busy || empty} className={ACTION}>
					{busy ? "Attaching…" : "Use drawing"}
				</button>
			</div>
			<div className="min-h-0 flex-1" data-testid="canvas-surface">
				<Excalidraw
					excalidrawAPI={(api) => {
						apiRef.current = api;
					}}
					theme={mode}
					onChange={(elements) => setEmpty(!elements.some((element) => !element.isDeleted))}
					UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: true } }}
				/>
			</div>
		</div>,
		document.body,
	);
}

"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, PaperclipIcon, PencilLineIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ATTACHMENT_ACCEPT, MAX_ANSWER_ATTACHMENTS } from "@/src/core";

/**
 * Answer attachments (fork, phase 2 — see FORK.md): photos of the learner's
 * work on a practice submission or a written answer.
 *
 * A picked or pasted photo uploads at once to the session's attachments
 * route, which stores it in the session image pool and returns its
 * snapshot id. The answer then carries ids only. Dropping a file on the
 * dock keeps upstream's behavior (it inserts the file's path).
 *
 * Phase 5a adds drawings: the Draw button opens the canvas
 * (canvas-editor.tsx, loaded only when first opened); a finished drawing
 * uploads like a photo, and its scene is then kept under the snapshot id
 * so it can be reopened later in the session.
 *
 * This module is the DOCK side and deliberately imports nothing from
 * chat.tsx (the docks are mounted standalone in tests and must not pull the
 * whole session view in); the transcript's thumbnails live in
 * attachment-thumbs.tsx.
 */

export interface AttachmentItem {
	key: string;
	name: string;
	/** Object URL of the picked file — a local preview while it uploads. */
	previewUrl: string;
	status: "uploading" | "ready" | "error";
	snapshotId?: string;
	error?: string;
}

const HEIC_NAME = /\.hei[cf]$/i;

export function isAttachableImage(file: Pick<File, "type" | "name">): boolean {
	return file.type.startsWith("image/") || HEIC_NAME.test(file.name);
}

/** The ids ready to ride an answer, in the order the photos were added. */
export function readyAttachmentIds(items: readonly AttachmentItem[]): string[] {
	return [...new Set(items.filter((item) => item.status === "ready" && item.snapshotId).map((item) => item.snapshotId!))];
}

export interface AnswerAttachments {
	items: AttachmentItem[];
	/** True while any photo is still uploading — submit waits. */
	uploading: boolean;
	/** A notice about the last add (too many, not an image). */
	notice: string | null;
	addFiles: (files: Iterable<File>) => void;
	/** A canvas drawing: its picture uploads like a photo, then its scene is saved under the snapshot id. */
	addDrawing: (image: File, scene: string) => void;
	/** The session attachments go to; absent → nothing can be attached. */
	chatId?: string;
	remove: (key: string) => void;
	clear: () => void;
	/** Capture-phase paste handler for the dock: image data in the clipboard
	 *  becomes an attachment instead of reaching the text field. */
	onPasteCapture: (event: React.ClipboardEvent) => void;
}

export function useAnswerAttachments(chatId: string | undefined): AnswerAttachments {
	const [items, setItems] = useState<AttachmentItem[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const itemsRef = useRef(items);
	itemsRef.current = items;

	// Object URLs are released when their item leaves, and all at unmount.
	const release = (list: readonly AttachmentItem[]) => list.forEach((item) => URL.revokeObjectURL(item.previewUrl));
	useEffect(() => () => release(itemsRef.current), []);

	const upload = useCallback(
		async (key: string, file: File, scene?: string) => {
			const settle = (patch: Partial<AttachmentItem>) =>
				setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
			if (!chatId) {
				settle({ status: "error", error: "No session to attach to." });
				return;
			}
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/attachments`, {
					method: "POST",
					headers: { "Content-Type": file.type || "application/octet-stream" },
					body: file,
				});
				const body = (await res.json().catch(() => ({}))) as { snapshotId?: string; error?: string };
				if (!res.ok || typeof body.snapshotId !== "string") {
					settle({ status: "error", error: body.error ?? `Upload failed (${res.status}).` });
					return;
				}
				if (scene !== undefined) {
					// The picture is in; keep the editable scene beside it. A drawing
					// whose scene cannot be saved still goes as its picture.
					await fetch(`/api/chats/${encodeURIComponent(chatId)}/canvases/${body.snapshotId}`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: scene,
					}).catch(() => undefined);
				}
				settle({ status: "ready", snapshotId: body.snapshotId });
			} catch {
				settle({ status: "error", error: "Upload failed — network error." });
			}
		},
		[chatId],
	);

	const addFiles = useCallback(
		(files: Iterable<File>) => {
			const images = [...files].filter(isAttachableImage);
			if (images.length === 0) {
				setNotice("Only images can be attached here.");
				return;
			}
			const room = MAX_ANSWER_ATTACHMENTS - itemsRef.current.length;
			const accepted = images.slice(0, Math.max(0, room));
			setNotice(accepted.length < images.length ? `An answer can carry at most ${MAX_ANSWER_ATTACHMENTS} photos.` : null);
			if (accepted.length === 0) return;
			const added = accepted.map((file) => ({
				item: {
					key: crypto.randomUUID(),
					name: file.name || "Pasted image",
					previewUrl: URL.createObjectURL(file),
					status: "uploading" as const,
				},
				file,
			}));
			setItems((prev) => [...prev, ...added.map((a) => a.item)]);
			for (const { item, file } of added) void upload(item.key, file);
		},
		[upload],
	);

	const addDrawing = useCallback(
		(image: File, scene: string) => {
			if (itemsRef.current.length >= MAX_ANSWER_ATTACHMENTS) {
				setNotice(`An answer can carry at most ${MAX_ANSWER_ATTACHMENTS} photos and drawings.`);
				return;
			}
			setNotice(null);
			const item = { key: crypto.randomUUID(), name: "Drawing", previewUrl: URL.createObjectURL(image), status: "uploading" as const };
			setItems((prev) => [...prev, item]);
			void upload(item.key, image, scene);
		},
		[upload],
	);

	const remove = useCallback((key: string) => {
		setItems((prev) => {
			release(prev.filter((item) => item.key === key));
			return prev.filter((item) => item.key !== key);
		});
		setNotice(null);
	}, []);

	const clear = useCallback(() => {
		setItems((prev) => {
			release(prev);
			return [];
		});
		setNotice(null);
	}, []);

	const onPasteCapture = useCallback(
		(event: React.ClipboardEvent) => {
			const files = [...event.clipboardData.files].filter(isAttachableImage);
			if (files.length === 0) return; // text paste: the field's own handler
			event.preventDefault();
			event.stopPropagation();
			addFiles(files);
		},
		[addFiles],
	);

	return { items, uploading: items.some((item) => item.status === "uploading"), notice, addFiles, addDrawing, chatId, remove, clear, onPasteCapture };
}

// Excalidraw is large and browser-only: fetched the first time the canvas opens.
const CanvasEditor = lazy(() => import("@/components/canvas-editor"));
const DOCK_BUTTON =
	"flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** The attach buttons: Draw opens the canvas, Photo the system file picker.
 *  (One component, so the docks that render it needed no further edit.) */
export function AttachPhotoButton({ attachments, disabled = false }: { attachments: AnswerAttachments; disabled?: boolean }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [drawing, setDrawing] = useState(false);
	const full = attachments.items.length >= MAX_ANSWER_ATTACHMENTS;
	return (
		<>
			{attachments.chatId && (
				<button
					type="button"
					data-testid="attach-drawing"
					aria-label="Draw your answer"
					title={full ? `At most ${MAX_ANSWER_ATTACHMENTS} photos and drawings` : "Draw your answer on a canvas"}
					disabled={disabled || full}
					onClick={() => setDrawing(true)}
					className={DOCK_BUTTON}
				>
					<PencilLineIcon className="size-3.5" />
					Draw
				</button>
			)}
			{drawing && attachments.chatId && (
				<Suspense fallback={null}>
					<CanvasEditor
						chatId={attachments.chatId}
						onClose={() => setDrawing(false)}
						onUse={(image, scene) => {
							attachments.addDrawing(image, scene);
							setDrawing(false);
						}}
					/>
				</Suspense>
			)}
			<input
				ref={inputRef}
				type="file"
				accept={ATTACHMENT_ACCEPT}
				multiple
				hidden
				data-testid="attach-photo-input"
				onChange={(event) => {
					if (event.target.files) attachments.addFiles(event.target.files);
					event.target.value = ""; // the same file can be picked again
				}}
			/>
			<button
				type="button"
				data-testid="attach-photo"
				aria-label="Attach a photo of your work"
				title={full ? `At most ${MAX_ANSWER_ATTACHMENTS} photos` : "Attach a photo of your work (or paste one)"}
				disabled={disabled || full}
				onClick={() => inputRef.current?.click()}
				className="flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
			>
				<PaperclipIcon className="size-3.5" />
				Photo
			</button>
		</>
	);
}

function Preview({ item }: { item: AttachmentItem }) {
	// A HEIC file has no in-browser preview; the icon stands in.
	const [broken, setBroken] = useState(false);
	return broken ? (
		<span className="flex size-full items-center justify-center text-muted-foreground">
			<ImageIcon className="size-5" />
		</span>
	) : (
		// eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimizable asset
		<img src={item.previewUrl} alt={item.name} onError={() => setBroken(true)} className="size-full object-cover" />
	);
}

/** The pure tray — exported for render tests. Renders nothing when empty. */
export function AttachmentTrayView({
	items,
	notice,
	onRemove,
}: {
	items: readonly AttachmentItem[];
	notice: string | null;
	onRemove: (key: string) => void;
}) {
	if (items.length === 0 && !notice) return null;
	const failed = items.find((item) => item.status === "error");
	return (
		<div data-testid="attachment-tray" className="px-2.5 pb-1">
			{items.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{items.map((item) => (
						<div
							key={item.key}
							data-testid="attachment-item"
							data-status={item.status}
							className={cn(
								"relative size-16 overflow-hidden rounded-md border border-border/70 bg-background",
								item.status === "uploading" && "opacity-60",
								item.status === "error" && "border-destructive/60",
							)}
						>
							<Preview item={item} />
							<button
								type="button"
								aria-label={`Remove ${item.name}`}
								data-testid="attachment-remove"
								onClick={() => onRemove(item.key)}
								className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground hover:bg-accent"
							>
								<XIcon className="size-3" />
							</button>
						</div>
					))}
				</div>
			)}
			{(failed?.error || notice) && (
				<p role="alert" data-testid="attachment-problem" className="mt-1 text-xs text-destructive">
					{failed?.error ? `${failed.error} Remove it to submit.` : notice}
				</p>
			)}
		</div>
	);
}

export function AttachmentTray({ attachments }: { attachments: AnswerAttachments }) {
	return <AttachmentTrayView items={attachments.items} notice={attachments.notice} onRemove={attachments.remove} />;
}

/** Can the dock submit, as far as attachments go? Nothing uploading, nothing failed. */
export function attachmentsSettled(items: readonly AttachmentItem[]): boolean {
	return items.every((item) => item.status === "ready");
}

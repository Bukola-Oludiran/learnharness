"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UploadIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { AI_READ_MARK, MATERIAL_ACCEPT, type MaterialView } from "@/src/core";

/**
 * A course's materials (fork, phase 3a — see FORK.md): upload notes
 * (PowerPoint, PDF, photos, text), watch them convert, review anything a
 * vision model had to read, and see them land in the knowledge graph.
 * The server owns every state; this view fetches on `materials-changed`.
 */

const SECTION = "text-xs uppercase tracking-widest text-muted-foreground/70";
const QUIET = "rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";

const FORMAT_LABEL: Record<MaterialView["format"], string> = { pptx: "Slides", pdf: "PDF", image: "Photo", text: "Text", epub: "Book" };

/** The row's one-line state. Pure — exported for tests. */
export function materialStatus(material: MaterialView): { label: string; busy: boolean; tone: "quiet" | "attention" | "problem" } {
	if (material.interrupted) return { label: "Interrupted", busy: false, tone: "problem" };
	switch (material.status) {
		case "processing":
			return { label: material.stage === "extracting" ? "Adding to graph…" : "Converting…", busy: true, tone: "quiet" };
		case "review":
			return { label: "Needs review", busy: false, tone: "attention" };
		case "ready":
			return { label: "In graph", busy: false, tone: "quiet" };
		case "failed":
			return { label: "Failed", busy: false, tone: "problem" };
	}
}

/** One material row. Pure — exported for render tests. */
export function MaterialRow({
	material,
	confirmingDelete = false,
	onReview,
	onRetry,
	onAskDelete,
	onCancelDelete,
	onDelete,
}: {
	material: MaterialView;
	confirmingDelete?: boolean;
	onReview: () => void;
	onRetry: () => void;
	onAskDelete: () => void;
	onCancelDelete: () => void;
	onDelete: () => void;
}) {
	const status = materialStatus(material);
	const detail = material.interrupted ? "The app closed before this finished." : material.status === "failed" ? material.error : material.notice;
	return (
		<div data-testid="material-row" data-status={material.interrupted ? "interrupted" : material.status} className="rounded-lg px-3 py-2 hover:bg-accent/40">
			<div className="flex items-center gap-2">
				{status.busy && <BrailleSpinner />}
				<span className="min-w-0 flex-1">
					<span className="block truncate font-prose text-(length:--lh-prose-size)">{material.title}</span>
					<span className="block text-xs text-muted-foreground">
						{FORMAT_LABEL[material.format]} ·{" "}
						<span
							data-testid="material-status"
							className={cn(status.tone === "attention" && "text-foreground", status.tone === "problem" && "text-destructive")}
						>
							{status.label}
						</span>
					</span>
				</span>
				{confirmingDelete ? (
					<>
						<span className="text-xs text-muted-foreground">Delete?</span>
						<button type="button" data-testid="material-delete-confirm" onClick={onDelete} className={cn(ACTION, "border-destructive/50 text-destructive")}>
							Delete
						</button>
						<button type="button" onClick={onCancelDelete} className={QUIET}>
							Keep
						</button>
					</>
				) : (
					<>
						{material.status === "review" && (
							<button type="button" data-testid="material-review" onClick={onReview} className={ACTION}>
								Review
							</button>
						)}
						{(material.status === "failed" || material.interrupted) && (
							<button type="button" data-testid="material-retry" onClick={onRetry} className={ACTION}>
								Retry
							</button>
						)}
						<button type="button" data-testid="material-delete" aria-label={`Delete ${material.title}`} onClick={onAskDelete} className={QUIET}>
							Delete
						</button>
					</>
				)}
			</div>
			{detail && (
				<p data-testid="material-detail" className={cn("mt-1 text-xs", material.status === "failed" || material.interrupted ? "text-destructive" : "text-muted-foreground")}>
					{detail}
				</p>
			)}
		</div>
	);
}

/** The review dialog's pure body — exported for render tests. */
export function MaterialReviewBody({
	material,
	text,
	busy,
	error,
	onText,
	onApprove,
	onDiscard,
	onClose,
}: {
	material: Pick<MaterialView, "title" | "aiReadParts" | "notice">;
	/** null while the transcript loads. */
	text: string | null;
	busy: boolean;
	error: string | null;
	onText: (next: string) => void;
	onApprove: () => void;
	onDiscard: () => void;
	onClose: () => void;
}) {
	const parts = material.aiReadParts === 1 ? "1 part" : `${material.aiReadParts} parts`;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Review transcript"
			data-testid="material-review-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[calc(100vh-4rem)] w-[52rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">Review transcript</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{material.title}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				A vision model read {parts} of this material. Each is marked “{AI_READ_MARK.replace(/^> /, "")}”, and anything it was unsure of ends in{" "}
				<code className="font-mono">[?]</code>. Correct the text against your original, then approve. Nothing reaches your graph until you do.
			</p>
			{material.notice && <p className="mt-1 text-xs text-muted-foreground">{material.notice}</p>}
			{text === null ? (
				<div className="mt-3 py-8 text-center text-xs text-muted-foreground">Loading…</div>
			) : (
				<textarea
					data-testid="material-review-text"
					aria-label="Transcript"
					value={text}
					spellCheck={false}
					disabled={busy}
					onChange={(e) => onText(e.target.value)}
					className="mt-3 min-h-64 flex-1 resize-none rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring"
				/>
			)}
			{error && (
				<p role="alert" data-testid="material-review-error" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
			<div className="mt-4 flex items-center gap-2">
				<button type="button" data-testid="material-review-discard" onClick={onDiscard} disabled={busy} className={cn(QUIET, "hover:text-destructive")}>
					Discard material
				</button>
				<span className="flex-1" />
				<button type="button" onClick={onClose} disabled={busy} className={QUIET}>
					Not now
				</button>
				<button
					type="button"
					data-testid="material-review-approve"
					onClick={onApprove}
					disabled={busy || text === null || text.trim() === ""}
					className={ACTION}
				>
					{busy ? "Approving…" : "Approve and add to graph"}
				</button>
			</div>
		</div>
	);
}

function MaterialReviewDialog({ material, onClose }: { material: MaterialView | null; onClose: () => void }) {
	const [text, setText] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	const id = material?.id;

	useEffect(() => {
		setText(null);
		setBusy(false);
		setError(null);
		if (!id) return;
		const controller = new AbortController();
		void fetch(`/api/materials/${id}`, { cache: "no-store", signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error();
				setText(((await res.json()) as { text: string | null }).text ?? "");
			})
			.catch(() => {
				if (!controller.signal.aborted) setError("Could not load the transcript.");
			});
		return () => controller.abort();
	}, [id]);

	useEffect(() => {
		if (!id) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// The one-Esc law: claimed here so it never also aborts a turn.
				e.preventDefault();
				e.stopPropagation();
				if (!busy) onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [id, busy, onClose]);

	const run = async (request: () => Promise<Response>, failure: string) => {
		setBusy(true);
		setError(null);
		try {
			const res = await request();
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? failure);
				setBusy(false);
				return;
			}
			onClose();
		} catch {
			setError(failure);
			setBusy(false);
		}
	};

	if (!material) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<MaterialReviewBody
				material={material}
				text={text}
				busy={busy}
				error={error}
				onText={setText}
				onClose={onClose}
				onApprove={() =>
					void run(
						() =>
							fetch(`/api/materials/${material.id}`, {
								method: "PUT",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ text }),
							}),
						"Could not approve the transcript. Try again.",
					)
				}
				onDiscard={() => void run(() => fetch(`/api/materials/${material.id}`, { method: "DELETE" }), "Could not discard the material. Try again.")}
			/>
		</div>,
		document.body,
	);
}

export function CourseMaterials({ courseId }: { courseId: string }) {
	const [materials, setMaterials] = useState<MaterialView[] | null>(null);
	const [problems, setProblems] = useState<string[]>([]);
	const [uploading, setUploading] = useState(0);
	const [reviewingId, setReviewingId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/materials?courseId=${encodeURIComponent(courseId)}`, { cache: "no-store" });
			if (res.ok) setMaterials(((await res.json()) as { materials: MaterialView[] }).materials);
		} catch {
			setMaterials((prev) => prev ?? []); // a transient failure keeps the last snapshot
		}
	}, [courseId]);

	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleRefresh = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("materials-changed", scheduleRefresh);
	useServerResync(() => void refresh());
	useEffect(() => {
		void refresh();
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh]);

	const upload = async (files: FileList) => {
		const list = [...files];
		setProblems([]);
		setUploading((n) => n + list.length);
		// One at a time: each upload is a whole file in memory on both ends.
		for (const file of list) {
			try {
				const res = await fetch(`/api/materials?courseId=${encodeURIComponent(courseId)}&name=${encodeURIComponent(file.name)}`, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body: file,
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setProblems((prev) => [...prev, `${file.name}: ${body.error ?? `Upload failed (${res.status}).`}`]);
				}
			} catch {
				setProblems((prev) => [...prev, `${file.name}: Upload failed — network error.`]);
			} finally {
				setUploading((n) => n - 1);
			}
		}
		void refresh();
	};

	const act = (path: string, method: "POST" | "DELETE") => {
		void fetch(path, { method })
			.catch(() => undefined)
			.then(() => refresh());
	};

	const reviewing = materials?.find((m) => m.id === reviewingId && m.status === "review") ?? null;

	return (
		<section className="mt-8" data-testid="course-materials">
			<div className="flex items-center justify-between">
				<h2 className={SECTION}>Materials</h2>
				<input
					ref={inputRef}
					type="file"
					multiple
					hidden
					accept={MATERIAL_ACCEPT}
					data-testid="material-upload-input"
					onChange={(e) => {
						if (e.target.files && e.target.files.length > 0) void upload(e.target.files);
						e.target.value = "";
					}}
				/>
				<button
					type="button"
					data-testid="material-upload"
					onClick={() => inputRef.current?.click()}
					disabled={uploading > 0}
					className={cn(QUIET, "flex items-center gap-1.5")}
				>
					<UploadIcon className="size-3" />
					{uploading > 0 ? "Uploading…" : "Upload notes"}
				</button>
			</div>
			{problems.length > 0 && (
				<ul role="alert" data-testid="material-upload-problems" className="mt-2 space-y-0.5 text-xs text-destructive">
					{problems.map((problem) => (
						<li key={problem}>{problem}</li>
					))}
				</ul>
			)}
			<div className="mt-2">
				{materials === null ? (
					<div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
				) : materials.length === 0 ? (
					<div data-testid="course-materials-empty" className="px-2 py-3 text-xs text-muted-foreground">
						No materials yet. Upload slides (.pptx), PDFs, photos of notes, or text files, and their ideas join your knowledge graph.
					</div>
				) : (
					materials.map((material) => (
						<MaterialRow
							key={material.id}
							material={material}
							confirmingDelete={deletingId === material.id}
							onReview={() => setReviewingId(material.id)}
							onRetry={() => act(`/api/materials/${material.id}/retry`, "POST")}
							onAskDelete={() => setDeletingId(material.id)}
							onCancelDelete={() => setDeletingId(null)}
							onDelete={() => {
								setDeletingId(null);
								act(`/api/materials/${material.id}`, "DELETE");
							}}
						/>
					))
				)}
			</div>
			<MaterialReviewDialog material={reviewing} onClose={() => setReviewingId(null)} />
		</section>
	);
}

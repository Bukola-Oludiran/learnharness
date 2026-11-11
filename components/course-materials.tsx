"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UploadIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { FolderUpload } from "@/components/folder-upload";
import { TestReviewBody } from "@/components/test-review";
import { AI_READ_MARK, BOOK_ACCEPT, MATERIAL_ACCEPT, TEST_ACCEPT, type MaterialView, type TestReading } from "@/src/core";

/**
 * The materials panel (fork, phases 3a–3b2 — see FORK.md), for one course
 * or — with no course — the whole library: upload notes (PowerPoint, Word,
 * PDF, photos, text), marked tests or a folder of both, watch them convert, review anything a
 * vision model had to read, and see them land in the knowledge graph.
 * The server owns every state; this view fetches on `materials-changed`.
 */

const SECTION = "text-xs uppercase tracking-widest text-muted-foreground/70";
const QUIET = "rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";

const FORMAT_LABEL: Record<MaterialView["format"], string> = { pptx: "Slides", docx: "Document", pdf: "PDF", image: "Photo", text: "Text", epub: "Book" };

/** The row's one-line state. Pure — exported for tests. */
export function materialStatus(material: MaterialView): { label: string; busy: boolean; tone: "quiet" | "attention" | "problem" } {
	if (material.interrupted) return { label: "Interrupted", busy: false, tone: "problem" };
	switch (material.status) {
		case "processing":
			if (material.stage === "queued") return { label: "Waiting…", busy: false, tone: "quiet" };
			if (material.kind === "book") return { label: "Splitting into sections…", busy: true, tone: "quiet" };
			if (material.kind === "test") return { label: material.stage === "extracting" ? "Recording results…" : "Reading the paper…", busy: true, tone: "quiet" };
			return { label: material.stage === "extracting" ? "Adding to graph…" : "Converting…", busy: true, tone: "quiet" };
		case "review":
			if (material.pendingChoice) return { label: `${material.pageCount ?? "Many"} pages: book or notes?`, busy: false, tone: "attention" };
			return { label: "Needs review", busy: false, tone: "attention" };
		case "ready":
			if (material.kind === "book") {
				const unit = material.format === "epub" ? "chapter file" : "page";
				const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
				return { label: `${count(material.sections.length, "section")} · ${count(material.pageCount ?? 0, unit)}`, busy: false, tone: "quiet" };
			}
			if (material.kind === "test") {
				const score = material.score ? `Score ${material.score.earned}/${material.score.possible}` : "Recorded";
				const unplaced = material.unplaced ? ` · ${material.unplaced} unplaced` : "";
				return { label: `${score}${unplaced}`, busy: false, tone: "quiet" };
			}
			return { label: "In graph", busy: false, tone: "quiet" };
		case "failed":
			return { label: "Failed", busy: false, tone: "problem" };
	}
}

/** One material row. Pure — exported for render tests. */
export function MaterialRow({
	material,
	where,
	confirmingDelete = false,
	onReview,
	onContents,
	onChoose,
	onResults,
	onRetry,
	onAskDelete,
	onCancelDelete,
	onDelete,
}: {
	material: MaterialView;
	/** The library's extra context: the folder the file came from. */
	where?: string;
	confirmingDelete?: boolean;
	onReview: () => void;
	/** Open a book's contents. */
	onContents?: () => void;
	/** Answer a long PDF's "book or notes?" pause. */
	onChoose?: (choice: "book" | "notes") => void;
	/** Open an approved test's results. */
	onResults?: () => void;
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
						{material.kind === "test" ? "Marked test" : material.kind === "book" ? "Book" : FORMAT_LABEL[material.format]}
						{where ? ` · ${where}` : ""} ·{" "}
						<span
							data-testid="material-status"
							className={cn(status.tone === "attention" && "text-warn", status.tone === "problem" && "text-bad")}
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
						{material.status === "review" && !material.pendingChoice && (
							<button type="button" data-testid="material-review" onClick={onReview} className={ACTION}>
								Review
							</button>
						)}
						{material.pendingChoice && onChoose && (
							<>
								<button type="button" data-testid="material-choose-book" onClick={() => onChoose("book")} className={ACTION}>
									Add as book
								</button>
								<button type="button" data-testid="material-choose-notes" onClick={() => onChoose("notes")} className={ACTION}>
									Extract as notes
								</button>
							</>
						)}
						{material.kind === "book" && material.status === "ready" && onContents && (
							<button type="button" data-testid="material-contents" onClick={onContents} className={ACTION}>
								Contents
							</button>
						)}
						{material.kind === "test" && material.status === "ready" && onResults && (
							<button type="button" data-testid="material-results" onClick={onResults} className={ACTION}>
								Results
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

/** A book's contents — the pure body, exported for render tests. */
export function BookContentsBody({ material, onClose }: { material: Pick<MaterialView, "title" | "sections" | "format" | "sectioning" | "notice">; onClose: () => void }) {
	const unit = material.format === "epub" ? "file" : "p.";
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Book contents"
			data-testid="book-contents-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[calc(100vh-4rem)] w-[40rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">Contents</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{material.title}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				{material.sectioning === "outline"
					? "Sections come from the book's own table of contents."
					: material.sectioning === "model"
						? "This book has no table of contents, so a model proposed where its chapters begin."
						: "This book has no table of contents, so it is split into equal sections."}{" "}
				Nothing here is in your graph until a session teaches it. Ask the tutor to teach a section by name.
			</p>
			{material.notice && <p className="mt-1 text-xs text-muted-foreground">{material.notice}</p>}
			<div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-border/60">
				{material.sections.map((section) => (
					<div
						key={section.id}
						data-testid="book-section"
						className={cn("flex items-baseline gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0", section.level > 1 && "pl-8")}
					>
						<span className={cn("min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size)", section.level > 1 && "text-muted-foreground")}>{section.title}</span>
						<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
							{unit} {section.pageStart === section.pageEnd ? section.pageStart : `${section.pageStart}–${section.pageEnd}`}
						</span>
					</div>
				))}
			</div>
			<div className="mt-4 flex justify-end">
				<button type="button" data-testid="book-contents-close" onClick={onClose} className={QUIET}>
					Close
				</button>
			</div>
		</div>
	);
}

function BookContentsDialog({ material, onClose }: { material: MaterialView | null; onClose: () => void }) {
	const backdropDismiss = useBackdropDismiss(onClose);
	const open = material !== null;
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// The one-Esc law: claimed here so it never also aborts a turn.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);
	if (!material) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<BookContentsBody material={material} onClose={onClose} />
		</div>,
		document.body,
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
	const [reading, setReading] = useState<TestReading | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	const id = material?.id;

	useEffect(() => {
		setText(null);
		setReading(null);
		setBusy(false);
		setError(null);
		if (!id) return;
		const controller = new AbortController();
		void fetch(`/api/materials/${id}`, { cache: "no-store", signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error();
				const body = (await res.json()) as { text: string | null; reading: TestReading | null };
				setText(body.text ?? "");
				setReading(body.reading ?? { questions: [] });
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
	const approve = (body: object, failure: string) =>
		void run(() => fetch(`/api/materials/${material.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), failure);
	const discard = () => void run(() => fetch(`/api/materials/${material.id}`, { method: "DELETE" }), "Could not discard the material. Try again.");
	if (material.kind === "test") {
		return createPortal(
			<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
				<TestReviewBody
					material={material}
					reading={reading}
					readOnly={material.status !== "review"}
					busy={busy}
					error={error}
					onReading={setReading}
					onClose={onClose}
					onApprove={() => approve({ reading }, "Could not approve the test. Try again.")}
					onDiscard={discard}
				/>
			</div>,
			document.body,
		);
	}
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

/** The folder a library material was filed under (its source path minus the file). */
export function materialFolder(material: Pick<MaterialView, "sourcePath">): string | undefined {
	const at = material.sourcePath.lastIndexOf("/");
	return at > 0 ? material.sourcePath.slice(0, at) : undefined;
}

export function CourseMaterials({ courseId }: { courseId: string }) {
	return <MaterialsPanel courseId={courseId} />;
}

/** `courseId` absent = the library: every material, plus folder upload. */
export function MaterialsPanel({ courseId }: { courseId?: string }) {
	const scope = courseId ? `courseId=${encodeURIComponent(courseId)}&` : "";
	const [materials, setMaterials] = useState<MaterialView[] | null>(null);
	const [problems, setProblems] = useState<string[]>([]);
	const [uploading, setUploading] = useState(0);
	const [reviewingId, setReviewingId] = useState<string | null>(null);
	const [contentsId, setContentsId] = useState<string | null>(null);
	const bookInputRef = useRef<HTMLInputElement>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/materials?${scope}`, { cache: "no-store" });
			if (res.ok) setMaterials(((await res.json()) as { materials: MaterialView[] }).materials);
		} catch {
			setMaterials((prev) => prev ?? []); // a transient failure keeps the last snapshot
		}
	}, [scope]);

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
				const res = await fetch(`/api/materials?${scope}name=${encodeURIComponent(file.name)}`, {
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

	/** Books go up one at a time, raw, like notes; they can be far larger. */
	const uploadBooks = async (files: FileList) => {
		const list = [...files];
		setProblems([]);
		setUploading((n) => n + list.length);
		for (const file of list) {
			try {
				const res = await fetch(`/api/materials?kind=book&name=${encodeURIComponent(file.name)}`, {
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

	const choose = (id: string, choice: "book" | "notes") => {
		void fetch(`/api/materials/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }) })
			.catch(() => undefined)
			.then(() => refresh());
	};

	const act = (path: string, method: "POST" | "DELETE") => {
		void fetch(path, { method })
			.catch(() => undefined)
			.then(() => refresh());
	};

	// Review while waiting; an approved test reopens read-only as its results.
	const reviewing = materials?.find((m) => m.id === reviewingId && ((m.status === "review" && !m.pendingChoice) || (m.kind === "test" && m.status === "ready"))) ?? null;
	const testInputRef = useRef<HTMLInputElement>(null);

	/** A marked test: every chosen page goes up together and becomes ONE material. */
	const uploadTest = async (files: FileList) => {
		const form = new FormData();
		for (const file of files) form.append("files", file);
		setProblems([]);
		setUploading((n) => n + 1);
		try {
			const res = await fetch(`/api/materials?${scope}kind=test`, { method: "POST", body: form });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setProblems([body.error ?? `Upload failed (${res.status}).`]);
			}
		} catch {
			setProblems(["Upload failed — network error."]);
		} finally {
			setUploading((n) => n - 1);
		}
		void refresh();
	};

	const stuck = materials?.filter((m) => m.status === "failed" || m.interrupted).length ?? 0;

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
				<input
					ref={testInputRef}
					type="file"
					multiple
					hidden
					accept={TEST_ACCEPT}
					data-testid="test-upload-input"
					onChange={(e) => {
						if (e.target.files && e.target.files.length > 0) void uploadTest(e.target.files);
						e.target.value = "";
					}}
				/>
				<span className="flex-1" />
				{stuck > 1 && (
					<button type="button" data-testid="material-retry-all" onClick={() => act("/api/materials/retry", "POST")} className={QUIET}>
						Retry all failed
					</button>
				)}
				{!courseId && (
					<>
						<input
							ref={bookInputRef}
							type="file"
							multiple
							hidden
							accept={BOOK_ACCEPT}
							data-testid="book-upload-input"
							onChange={(e) => {
								if (e.target.files && e.target.files.length > 0) void uploadBooks(e.target.files);
								e.target.value = "";
							}}
						/>
						<button
							type="button"
							data-testid="book-upload"
							title="A PDF or EPUB book: stored and split into sections, taught from as you cover it"
							onClick={() => bookInputRef.current?.click()}
							disabled={uploading > 0}
							className={cn(QUIET, "flex items-center gap-1.5")}
						>
							<UploadIcon className="size-3" />
							Upload book
						</button>
					</>
				)}
				{!courseId && (
					<FolderUpload
						disabled={uploading > 0}
						onDone={(refused) => {
							setProblems(refused);
							void refresh();
						}}
					/>
				)}
				<button
					type="button"
					data-testid="test-upload"
					title="Choose every page of one marked test (photos), or one scanned PDF"
					onClick={() => testInputRef.current?.click()}
					disabled={uploading > 0}
					className={cn(QUIET, "flex items-center gap-1.5")}
				>
					<UploadIcon className="size-3" />
					Upload marked test
				</button>
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
						No materials yet. {!courseId && "Upload a book (PDF or EPUB) and the tutor teaches from it section by section. "}Upload slides (.pptx), Word documents (.docx), PDFs, photos of notes, or text files, and their ideas join your
						knowledge graph. Upload a marked test and its results are recorded on the ideas it tests.
						{!courseId && " Upload folder takes a whole folder at once and lets you check each file first."}
					</div>
				) : (
					materials.map((material) => (
						<MaterialRow
							key={material.id}
							material={material}
							where={courseId ? undefined : materialFolder(material)}
							confirmingDelete={deletingId === material.id}
							onReview={() => setReviewingId(material.id)}
							onContents={() => setContentsId(material.id)}
							onChoose={(choice) => choose(material.id, choice)}
							onResults={() => setReviewingId(material.id)}
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
			<BookContentsDialog material={materials?.find((m) => m.id === contentsId && m.kind === "book") ?? null} onClose={() => setContentsId(null)} />
		</section>
	);
}

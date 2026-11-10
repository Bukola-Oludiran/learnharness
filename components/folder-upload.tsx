"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderUpIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { cn } from "@/lib/utils";
import { LONG_NOTES_PAGES, MAX_FOLDER_FILES, MAX_MATERIAL_BYTES, folderFileVerdict, pdfPageCountHint, type FolderChoice } from "@/src/core";

/**
 * Folder upload (fork, phase 3b2 — see FORK.md): pick a folder, then a
 * checklist (owner choice 2026-11-10) — every file set to Notes, Marked
 * test or Skip, pre-selected from its name, unreadable files greyed out.
 * Nothing is uploaded or read until Start. Each file becomes one library
 * material, filed under its own folder path.
 */

const QUIET = "rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";

export interface FolderItem {
	/** The folder-relative path, root folder included (`Uni/Stats 201/Week 2.pdf`). */
	path: string;
	size: number;
	choice: FolderChoice;
	testable: boolean;
	bookable: boolean;
	refused?: string;
}

/** `1.2 MB`, `340 KB`. Pure — exported for tests. */
export function fileSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The checklist's items for a picked folder, sorted by path; files in
 *  hidden folders (`.git`) and dot-files are left out. Pure. */
export function folderItems(files: readonly { name: string; size: number; path: string }[]): FolderItem[] {
	return files
		.filter((file) => !file.path.split("/").some((segment) => segment.startsWith(".")))
		.map((file) => ({ path: file.path, size: file.size, ...folderFileVerdict(file.name, file.size) }))
		.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** "12 sets of notes · 3 marked tests · 1 book · 4 skipped". Pure. */
export function folderSummary(items: readonly FolderItem[]): { notes: number; tests: number; books: number; skipped: number; label: string } {
	const notes = items.filter((item) => item.choice === "notes").length;
	const tests = items.filter((item) => item.choice === "test").length;
	const books = items.filter((item) => item.choice === "book").length;
	const skipped = items.length - notes - tests - books;
	const label = [
		`${notes} ${notes === 1 ? "set of notes" : "sets of notes"}`,
		`${tests} marked ${tests === 1 ? "test" : "tests"}`,
		...(books > 0 ? [`${books} ${books === 1 ? "book" : "books"}`] : []),
		`${skipped} skipped`,
	].join(" · ");
	return { notes, tests, books, skipped, label };
}

/** The checklist dialog's pure body — exported for render tests. */
export function FolderChecklistBody({
	items,
	progress,
	onChoice,
	onStart,
	onClose,
}: {
	items: readonly FolderItem[];
	/** Set while uploading. */
	progress: { done: number; total: number } | null;
	onChoice: (index: number, choice: FolderChoice) => void;
	onStart: () => void;
	onClose: () => void;
}) {
	const summary = folderSummary(items);
	const chosen = summary.notes + summary.tests + summary.books;
	const tooMany = items.length > MAX_FOLDER_FILES;
	const busy = progress !== null;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Upload folder"
			data-testid="folder-checklist"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[calc(100vh-4rem)] w-[52rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">Upload folder</h2>
			{tooMany ? (
				<p data-testid="folder-too-many" className="mt-2 text-sm text-muted-foreground">
					This folder has {items.length.toLocaleString("en-US")} files. One upload can list at most {MAX_FOLDER_FILES.toLocaleString("en-US")}; choose a
					smaller folder, such as one course or one year.
				</p>
			) : items.length === 0 ? (
				<p data-testid="folder-empty" className="mt-2 text-sm text-muted-foreground">
					This folder has no files.
				</p>
			) : (
				<>
					<p className="mt-2 text-sm text-muted-foreground">
						Check what each file is. Nothing is uploaded or read until you press Start. Notes and tests are read by your model plan: at least two model
						calls each, and one more for every photo or scanned page. A book is only stored and split into sections. Files are processed two at a time, and you can keep using the app while they run.
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						A marked test photographed as several separate images should be skipped here and uploaded with “Upload marked test”, so its pages stay
						together.
					</p>
					<div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-border/60">
						{items.map((item, index) => (
							<div
								key={item.path}
								data-testid="folder-item"
								data-choice={item.refused ? "refused" : item.choice}
								className={cn("flex items-center gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0", (item.refused || item.choice === "skip") && "opacity-50")}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate font-mono text-xs" title={item.path}>
										{item.path}
									</span>
									{item.refused && <span className="block text-xs text-muted-foreground">{item.refused}</span>}
								</span>
								<span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fileSize(item.size)}</span>
								{item.refused ? (
									<span className="w-28 shrink-0 text-right text-xs text-muted-foreground">Can’t be read</span>
								) : (
									<select
										aria-label={`What ${item.path} is`}
										value={item.choice}
										disabled={busy}
										onChange={(e) => onChoice(index, e.target.value as FolderChoice)}
										className="w-28 shrink-0 rounded-sm border border-input bg-background px-1 py-0.5 text-xs"
									>
										{item.size <= MAX_MATERIAL_BYTES && <option value="notes">Notes</option>}
										{item.testable && <option value="test">Marked test</option>}
										{item.bookable && <option value="book">Book</option>}
										<option value="skip">Skip</option>
									</select>
								)}
							</div>
						))}
					</div>
				</>
			)}
			<div className="mt-4 flex items-center gap-2">
				{!tooMany && items.length > 0 && (
					<span data-testid="folder-summary" className="text-xs text-muted-foreground">
						{busy ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : summary.label}
					</span>
				)}
				<span className="flex-1" />
				<button type="button" data-testid="folder-cancel" onClick={onClose} disabled={busy} className={QUIET}>
					Cancel
				</button>
				{!tooMany && items.length > 0 && (
					<button type="button" data-testid="folder-start" onClick={onStart} disabled={busy || chosen === 0} className={ACTION}>
						{busy ? "Uploading…" : `Start (${chosen} ${chosen === 1 ? "file" : "files"})`}
					</button>
				)}
			</div>
		</div>
	);
}

async function uploadOne(file: File, path: string, choice: FolderChoice): Promise<string | null> {
	try {
		const query = `path=${encodeURIComponent(path)}`;
		let res: Response;
		if (choice === "book") {
			res = await fetch(`/api/materials?kind=book&name=${encodeURIComponent(file.name)}&${query}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: file,
			});
		} else if (choice === "test") {
			const form = new FormData();
			form.append("files", file);
			res = await fetch(`/api/materials?kind=test&${query}`, { method: "POST", body: form });
		} else {
			res = await fetch(`/api/materials?name=${encodeURIComponent(file.name)}&${query}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: file,
			});
		}
		if (res.ok) return null;
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		return `${path}: ${body.error ?? `Upload failed (${res.status}).`}`;
	} catch {
		return `${path}: Upload failed — network error.`;
	}
}

/** The "Upload folder" button and its checklist. `onDone` receives the
 *  uploads that were refused, once the rest are stored and queued. */
export function FolderUpload({ disabled, onDone }: { disabled?: boolean; onDone: (problems: string[]) => void }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [picked, setPicked] = useState<{ files: Map<string, File>; items: FolderItem[] } | null>(null);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const busy = progress !== null;
	const close = () => {
		if (!busy) setPicked(null);
	};
	const backdropDismiss = useBackdropDismiss(close);

	useEffect(() => {
		if (!picked) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// The one-Esc law: claimed here so it never also aborts a turn.
				e.preventDefault();
				e.stopPropagation();
				if (!busy) setPicked(null);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [picked, busy]);

	const pick = (list: FileList) => {
		const files = new Map<string, File>();
		for (const file of list) files.set(file.webkitRelativePath || file.name, file);
		setPicked({ files, items: folderItems([...files].map(([path, file]) => ({ name: file.name, size: file.size, path }))) });
		// The length hint: a PDF whose page count can be read from its bytes
		// and is long is pre-selected as a book. Best effort, off the main path.
		for (const [path, file] of files) {
			if (!/\.pdf$/i.test(file.name) || file.size > MAX_MATERIAL_BYTES) continue;
			void file
				.arrayBuffer()
				.then((buffer) => {
					const pages = pdfPageCountHint(new Uint8Array(buffer));
					if (pages === undefined || pages <= LONG_NOTES_PAGES) return;
					setPicked((prev) =>
						prev ? { ...prev, items: prev.items.map((item) => (item.path === path && item.choice === "notes" && item.bookable ? { ...item, choice: "book" } : item)) } : prev,
					);
				})
				.catch(() => undefined);
		}
	};

	const start = async () => {
		if (!picked || busy) return;
		const chosen = picked.items.filter((item) => !item.refused && item.choice !== "skip");
		const problems: string[] = [];
		setProgress({ done: 0, total: chosen.length });
		// One at a time: each upload is a whole file in memory on both ends.
		for (const [index, item] of chosen.entries()) {
			const file = picked.files.get(item.path);
			const problem = file ? await uploadOne(file, item.path, item.choice) : `${item.path}: The file is no longer there.`;
			if (problem) problems.push(problem);
			setProgress({ done: index + 1, total: chosen.length });
		}
		setProgress(null);
		setPicked(null);
		onDone(problems);
	};

	return (
		<>
			<input
				ref={inputRef}
				type="file"
				multiple
				hidden
				data-testid="folder-upload-input"
				// Not in React's typings: the folder picker.
				{...({ webkitdirectory: "" } as object)}
				onChange={(e) => {
					if (e.target.files) pick(e.target.files);
					e.target.value = "";
				}}
			/>
			<button
				type="button"
				data-testid="folder-upload"
				title="Choose a folder of notes and marked tests"
				onClick={() => inputRef.current?.click()}
				disabled={disabled || busy}
				className={cn(QUIET, "flex items-center gap-1.5")}
			>
				<FolderUpIcon className="size-3" />
				Upload folder
			</button>
			{picked &&
				createPortal(
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
						<FolderChecklistBody
							items={picked.items}
							progress={progress}
							onChoice={(index, choice) =>
								setPicked((prev) => (prev ? { ...prev, items: prev.items.map((item, i) => (i === index ? { ...item, choice } : item)) } : prev))
							}
							onStart={() => void start()}
							onClose={close}
						/>
					</div>,
					document.body,
				)}
		</>
	);
}

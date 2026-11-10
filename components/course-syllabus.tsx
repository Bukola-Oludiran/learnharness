"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { SessionStarter } from "@/components/start-session";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SYLLABUS_NOTE_MAX, UNIT_TITLE_MAX, buildBlocker, nextUnit, type CourseRecord, type MaterialView, type SyllabusUnit } from "@/src/core";

/**
 * A course's books and syllabus (fork, phase 4b — see FORK.md). Books are
 * picked from the library; the syllabus is drafted by a model only when
 * the learner asks, then adjusted by hand: rename, reorder, skip, delete,
 * or rebuild with a note. Phase 4c: each unit starts (or reopens) its own
 * teaching session, "Continue course" goes to the next unit that is ready,
 * and a unit can be marked covered or not by hand. The server owns every state; this view refetches
 * on `courses-changed` and `materials-changed`.
 */

const SECTION = "text-xs uppercase tracking-widest text-muted-foreground/70";
const QUIET = "rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";
const ICON = "flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30";

type Book = Pick<MaterialView, "id" | "title" | "status" | "sections" | "pageCount" | "format">;

/** "Algebra · Sets (p. 3–8); Groups (p. 9)". Pure — exported for tests. */
export function unitSourcesLabel(unit: SyllabusUnit, books: readonly Book[]): string {
	const byBook = new Map<string, string[]>();
	for (const source of unit.sources) {
		const book = books.find((b) => b.id === source.materialId);
		const section = book?.sections.find((s) => s.id === source.sectionId);
		if (!book || !section) continue;
		const pages = section.pageStart === section.pageEnd ? `${section.pageStart}` : `${section.pageStart}–${section.pageEnd}`;
		const list = byBook.get(book.title) ?? [];
		list.push(`${section.title} (${book.format === "epub" ? "file" : "p."} ${pages})`);
		byBook.set(book.title, list);
	}
	return [...byBook].map(([title, sections]) => `${title} · ${sections.join("; ")}`).join(" | ");
}

/** "After: Sets, Maps". Pure. */
export function unitDependsLabel(unit: SyllabusUnit, units: readonly SyllabusUnit[]): string {
	const titles = unit.dependsOn.map((id) => units.find((u) => u.id === id)?.title).filter((title): title is string => title !== undefined);
	return titles.length > 0 ? `After: ${titles.join(", ")}` : "";
}

const STATUS_LABEL: Record<SyllabusUnit["status"], string> = { todo: "", active: "In progress", covered: "Covered", skipped: "Skipped" };

/** The Books section's pure body — exported for render tests. */
export function CourseBooksBody({
	books,
	library,
	picking,
	error,
	onTogglePicking,
	onAdd,
	onRemove,
}: {
	/** The course's books that still exist. */
	books: readonly Book[];
	/** Library books not yet in the course; null while loading. */
	library: readonly Book[] | null;
	picking: boolean;
	error: string | null;
	onTogglePicking: () => void;
	onAdd: (materialId: string) => void;
	onRemove: (materialId: string) => void;
}) {
	return (
		<section className="mt-8" data-testid="course-books">
			<div className="flex items-center justify-between">
				<h2 className={SECTION}>Books</h2>
				<button type="button" data-testid="course-add-book" onClick={onTogglePicking} className={cn(QUIET, "flex items-center gap-1.5")}>
					{!picking && <PlusIcon className="size-3" />}
					{picking ? "Done" : "Add book"}
				</button>
			</div>
			{error && (
				<p role="alert" data-testid="course-books-error" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
			{picking && (
				<div data-testid="course-book-picker" className="mt-2 rounded-lg border border-border/60 p-2">
					{library === null ? (
						<div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
					) : library.length === 0 ? (
						<div className="px-2 py-3 text-xs text-muted-foreground">No other books in your Library. Upload one there with “Upload book”.</div>
					) : (
						library.map((book) => (
							<button
								key={book.id}
								type="button"
								data-testid="course-book-option"
								onClick={() => onAdd(book.id)}
								disabled={book.status !== "ready"}
								className="flex w-full items-baseline gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-40"
							>
								<span className="min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size)">{book.title}</span>
								<span className="shrink-0 text-xs text-muted-foreground">{book.status === "ready" ? `${book.sections.length} sections` : "Not ready"}</span>
							</button>
						))
					)}
				</div>
			)}
			<div className="mt-2">
				{books.length === 0 ? (
					<div data-testid="course-books-empty" className="px-2 py-3 text-xs text-muted-foreground">
						No books yet. Add one from your Library and the tutor can teach from it; with a goal as well, you can build a syllabus.
					</div>
				) : (
					books.map((book) => (
						<div key={book.id} data-testid="course-book" className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-accent/40">
							<span className="min-w-0 flex-1">
								<span className="block truncate font-prose text-(length:--lh-prose-size)">{book.title}</span>
								<span className="block text-xs text-muted-foreground">
									{book.status === "ready" ? `${book.sections.length} sections · ${book.pageCount ?? 0} ${book.format === "epub" ? "chapter files" : "pages"}` : "Not ready yet"}
								</span>
							</span>
							<button type="button" data-testid="course-remove-book" aria-label={`Remove ${book.title} from this course`} onClick={() => onRemove(book.id)} className={QUIET}>
								Remove
							</button>
						</div>
					))
				)}
			</div>
		</section>
	);
}

/** The first message of a unit's session: the learner's opening request. */
export const unitOpeningPrompt = (unit: Pick<SyllabusUnit, "title">) => `Start the unit: ${unit.title}`;

/** One unit row. Pure — exported for render tests. */
export function UnitRow({
	unit,
	number,
	units,
	books,
	first,
	last,
	renaming,
	draftTitle,
	onDraftTitle,
	onStartRename,
	onCommitRename,
	onCancelRename,
	onMove,
	onSkip,
	onDelete,
	hasSession = false,
	starting = false,
	onStart,
	onCover,
}: {
	/** The unit already has a session: Start becomes Open session. */
	hasSession?: boolean;
	/** A session is being created for some unit. */
	starting?: boolean;
	/** Start the unit's session, or open the one it has. */
	onStart?: () => void;
	/** The learner's override of covered / not covered. */
	onCover?: (covered: boolean) => void;
	unit: SyllabusUnit;
	number: number;
	units: readonly SyllabusUnit[];
	books: readonly Book[];
	first: boolean;
	last: boolean;
	renaming: boolean;
	draftTitle: string;
	onDraftTitle: (next: string) => void;
	onStartRename: () => void;
	onCommitRename: () => void;
	onCancelRename: () => void;
	onMove: (direction: "up" | "down") => void;
	onSkip: (skipped: boolean) => void;
	onDelete: () => void;
}) {
	const sources = unitSourcesLabel(unit, books);
	const depends = unitDependsLabel(unit, units);
	const status = STATUS_LABEL[unit.status];
	return (
		<div data-testid="syllabus-unit" data-status={unit.status} className={cn("flex items-start gap-2 rounded-lg px-3 py-2 hover:bg-accent/40", unit.status === "skipped" && "opacity-50")}>
			<span className="w-6 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground">{number}</span>
			<span className="min-w-0 flex-1">
				{renaming ? (
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							onCommitRename();
						}}
					>
						<Input
							data-testid="syllabus-unit-title-input"
							aria-label="Unit title"
							value={draftTitle}
							maxLength={UNIT_TITLE_MAX}
							onChange={(e) => onDraftTitle(e.target.value)}
							autoFocus
							className="h-7 text-sm"
						/>
						<button type="submit" disabled={draftTitle.trim() === ""} className={ACTION}>
							Save
						</button>
						<button type="button" onClick={onCancelRename} className={QUIET}>
							Cancel
						</button>
					</form>
				) : (
					<span className="block font-prose text-(length:--lh-prose-size)">
						{unit.title}
						{status && (
							<span data-testid="syllabus-unit-status" className="ml-2 text-xs text-muted-foreground">
								{status}
							</span>
						)}
					</span>
				)}
				{sources && <span className="block text-xs text-muted-foreground">{sources}</span>}
				{depends && <span className="block text-xs text-muted-foreground/80">{depends}</span>}
			</span>
			{!renaming && (
				<span className="flex shrink-0 items-center gap-0.5">
					{onStart && unit.status !== "skipped" && (
						<button type="button" data-testid="syllabus-unit-start" onClick={onStart} disabled={starting} className={ACTION}>
							{hasSession ? "Open session" : "Start"}
						</button>
					)}
					{onCover && unit.status !== "skipped" && (
						<button type="button" data-testid="syllabus-unit-cover" onClick={() => onCover(unit.status !== "covered")} className={QUIET}>
							{unit.status === "covered" ? "Not covered" : "Mark covered"}
						</button>
					)}
					<button type="button" data-testid="syllabus-unit-up" aria-label={`Move ${unit.title} up`} onClick={() => onMove("up")} disabled={first} className={ICON}>
						<ArrowUpIcon className="size-3" />
					</button>
					<button type="button" data-testid="syllabus-unit-down" aria-label={`Move ${unit.title} down`} onClick={() => onMove("down")} disabled={last} className={ICON}>
						<ArrowDownIcon className="size-3" />
					</button>
					<button type="button" data-testid="syllabus-unit-rename" onClick={onStartRename} className={QUIET}>
						Rename
					</button>
					{unit.status !== "covered" && (
						<button type="button" data-testid="syllabus-unit-skip" onClick={() => onSkip(unit.status !== "skipped")} className={QUIET}>
							{unit.status === "skipped" ? "Un-skip" : "Skip"}
						</button>
					)}
					<button type="button" data-testid="syllabus-unit-delete" aria-label={`Delete ${unit.title}`} onClick={onDelete} className={cn(QUIET, "hover:text-destructive")}>
						Delete
					</button>
				</span>
			)}
		</div>
	);
}

/** The Syllabus section's pure frame — exported for render tests. */
export function SyllabusBody({
	course,
	readyBooks,
	building,
	error,
	rebuilding,
	note,
	onNote,
	onBuild,
	onToggleRebuild,
	onContinue,
	starting = false,
	children,
}: {
	/** Go to the next unit that is ready (phase 4c). */
	onContinue?: () => void;
	starting?: boolean;
	course: Pick<CourseRecord, "goal" | "syllabus" | "syllabusError">;
	readyBooks: number;
	building: boolean;
	/** A request that failed (the build's own failure rides the course). */
	error: string | null;
	/** The rebuild panel is open. */
	rebuilding: boolean;
	note: string;
	onNote: (next: string) => void;
	onBuild: () => void;
	onToggleRebuild: () => void;
	/** The unit rows. */
	children?: React.ReactNode;
}) {
	const blocker = buildBlocker(course, readyBooks);
	const units = course.syllabus?.units ?? [];
	const problem = error ?? course.syllabusError ?? null;
	const upNext = course.syllabus ? nextUnit(course.syllabus) : null;
	const allDone = units.length > 0 && !upNext;
	const notePanel = (confirmLabel: string) => (
		<div data-testid="syllabus-note-panel" className="mt-2 rounded-lg border border-border/60 p-3">
			<label className="block text-xs text-muted-foreground" htmlFor="syllabus-note">
				Note to the builder (optional)
			</label>
			<textarea
				id="syllabus-note"
				data-testid="syllabus-note"
				value={note}
				maxLength={SYLLABUS_NOTE_MAX}
				onChange={(e) => onNote(e.target.value)}
				placeholder="For example: skip the history chapters, or split the calculus review in two"
				className="mt-1 min-h-16 w-full resize-none rounded-md border border-input bg-background p-2 text-sm outline-none focus-visible:border-ring"
			/>
			<div className="mt-2 flex items-center gap-2">
				<span className="flex-1 text-xs text-muted-foreground">{units.length > 0 ? "This replaces the current syllabus and your edits to it. Covered units are kept." : ""}</span>
				<button type="button" data-testid="syllabus-build-confirm" onClick={onBuild} disabled={blocker !== null} className={ACTION}>
					{confirmLabel}
				</button>
			</div>
		</div>
	);
	return (
		<section className="mt-8" data-testid="course-syllabus">
			<div className="flex items-center justify-between">
				<h2 className={SECTION}>Syllabus</h2>
				<span className="flex-1" />
				{!building && upNext && onContinue && (
					<button type="button" data-testid="syllabus-continue" title={`Next: ${upNext.title}`} onClick={onContinue} disabled={starting} className={cn(ACTION, "mr-1")}>
						{starting ? "Starting…" : "Continue course"}
					</button>
				)}
				{!building && units.length > 0 && (
					<button type="button" data-testid="syllabus-rebuild" onClick={onToggleRebuild} className={QUIET}>
						{rebuilding ? "Cancel" : "Rebuild…"}
					</button>
				)}
			</div>
			{problem && (
				<p role="alert" data-testid="syllabus-error" className="mt-2 text-xs text-destructive">
					{problem}
				</p>
			)}
			{building ? (
				<div data-testid="syllabus-building" className="mt-2 flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
					<BrailleSpinner />
					Drafting the syllabus from your goal and the books’ contents. You can keep using the app.
				</div>
			) : units.length === 0 ? (
				<>
					<div data-testid="syllabus-empty" className="mt-2 px-2 py-2 text-xs text-muted-foreground">
						No syllabus yet. Building one sends your goal and the books’ contents lists to the model, which drafts units in order. {blocker ?? ""}
					</div>
					{notePanel(course.syllabusError ? "Retry" : "Build syllabus")}
				</>
			) : (
				rebuilding && notePanel("Replace the syllabus")
			)}
			{!building && allDone && (
				<p data-testid="syllabus-done" className="mt-2 px-2 text-xs text-muted-foreground">
					Every unit is covered or skipped.
				</p>
			)}
			{!building && units.length > 0 && <div className="mt-2">{children}</div>}
		</section>
	);
}

export function CourseSyllabus({ course, onChanged }: { course: CourseRecord; onChanged: () => void }) {
	const courseId = course.id;
	const [library, setLibrary] = useState<Book[] | null>(null);
	const [building, setBuilding] = useState(false);
	const [picking, setPicking] = useState(false);
	const [booksError, setBooksError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [rebuilding, setRebuilding] = useState(false);
	const [note, setNote] = useState("");
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [draftTitle, setDraftTitle] = useState("");
	const [starting, setStarting] = useState(false);
	const router = useRouter();
	const starterRef = useRef(new SessionStarter());

	const refresh = useCallback(async () => {
		try {
			const [materialsRes, statusRes] = await Promise.all([
				fetch("/api/materials", { cache: "no-store" }),
				fetch(`/api/courses/${courseId}/syllabus`, { cache: "no-store" }),
			]);
			if (materialsRes.ok) setLibrary(((await materialsRes.json()) as { materials: MaterialView[] }).materials.filter((m) => m.kind === "book"));
			if (statusRes.ok) setBuilding(((await statusRes.json()) as { building: boolean }).building);
		} catch {
			setLibrary((prev) => prev ?? []); // a transient failure keeps the last snapshot
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
	useServerEvent("courses-changed", scheduleRefresh);
	useServerEvent("materials-changed", scheduleRefresh);
	useServerResync(() => void refresh());
	useEffect(() => {
		void refresh();
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh]);

	/** Every change goes to the server; the course page then refetches the record. */
	const send = async (path: string, init: RequestInit, onError: (message: string) => void, failure: string): Promise<boolean> => {
		onError("");
		try {
			const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				onError(body.error ?? failure);
				return false;
			}
			onChanged();
			void refresh();
			return true;
		} catch {
			onError(failure);
			return false;
		}
	};
	const setBooksProblem = (message: string) => setBooksError(message || null);
	const setProblem = (message: string) => setError(message || null);
	const editUnit = (unitId: string, edit: object) =>
		void send(`/api/courses/${courseId}/syllabus`, { method: "PATCH", body: JSON.stringify({ unitId, ...edit }) }, setProblem, "Could not change the unit. Try again.");

	const sessionOf = (unitId: string) => course.sessions.find((session) => session.unitIds.includes(unitId))?.chatId;
	/** Open the unit's session, or create one scoped to it with the opening request ready to send. */
	const startUnit = (unit: SyllabusUnit) => {
		const existing = sessionOf(unit.id);
		if (existing) {
			router.push(`/chat/${existing}`);
			return;
		}
		if (starting) return;
		setStarting(true);
		setError(null);
		void starterRef.current
			.start({ title: unitOpeningPrompt(unit), courseId, unitId: unit.id }, fetch)
			.then((target) => router.push(target))
			.catch(() => {
				setStarting(false);
				setError("Could not start the session. Try again.");
			});
	};

	const inCourse = new Set(course.bookIds ?? []);
	const books = (course.bookIds ?? []).map((id) => library?.find((book) => book.id === id)).filter((book): book is Book => book !== undefined);
	const units = course.syllabus?.units ?? [];

	return (
		<>
			<CourseBooksBody
				books={books}
				library={library?.filter((book) => !inCourse.has(book.id)) ?? null}
				picking={picking}
				error={booksError}
				onTogglePicking={() => setPicking((v) => !v)}
				onAdd={(materialId) =>
					void send(`/api/courses/${courseId}/books`, { method: "POST", body: JSON.stringify({ materialId }) }, setBooksProblem, "Could not add the book. Try again.")
				}
				onRemove={(materialId) =>
					void send(`/api/courses/${courseId}/books?materialId=${encodeURIComponent(materialId)}`, { method: "DELETE" }, setBooksProblem, "Could not remove the book. Try again.")
				}
			/>
			<SyllabusBody
				course={course}
				readyBooks={books.filter((book) => book.status === "ready").length}
				building={building}
				error={error}
				rebuilding={rebuilding}
				note={note}
				onNote={setNote}
				onToggleRebuild={() => setRebuilding((v) => !v)}
				starting={starting}
				onContinue={() => {
					const next = course.syllabus ? nextUnit(course.syllabus) : null;
					if (next) startUnit(next);
				}}
				onBuild={() =>
					void send(`/api/courses/${courseId}/syllabus`, { method: "POST", body: JSON.stringify({ note }) }, setProblem, "Could not start the build. Try again.").then((started) => {
						if (!started) return;
						setBuilding(true);
						setRebuilding(false);
						setNote("");
					})
				}
			>
				{units.map((unit, index) => (
					<UnitRow
						key={unit.id}
						unit={unit}
						number={index + 1}
						units={units}
						books={books}
						first={index === 0}
						last={index === units.length - 1}
						renaming={renamingId === unit.id}
						draftTitle={draftTitle}
						onDraftTitle={setDraftTitle}
						onStartRename={() => {
							setRenamingId(unit.id);
							setDraftTitle(unit.title);
						}}
						onCancelRename={() => setRenamingId(null)}
						onCommitRename={() => {
							setRenamingId(null);
							if (draftTitle.trim() !== unit.title) editUnit(unit.id, { op: "rename", title: draftTitle });
						}}
						onMove={(direction) => editUnit(unit.id, { op: "move", direction })}
						onSkip={(skipped) => editUnit(unit.id, { op: "skip", skipped })}
						onDelete={() => editUnit(unit.id, { op: "delete" })}
						hasSession={sessionOf(unit.id) !== undefined}
						starting={starting}
						onStart={() => startUnit(unit)}
						onCover={(covered) => editUnit(unit.id, { op: "cover", covered })}
					/>
				))}
			</SyllabusBody>
		</>
	);
}

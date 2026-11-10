"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { COURSE_GOAL_MAX, COURSE_TITLE_MAX, type CourseRecord } from "@/src/core";

/**
 * Course dialogs (fork, phase 1): the create/edit form and the delete
 * confirmation. Both follow the session-deletion dialog's shape — portaled
 * z-50, backdrop dismiss, Esc claimed at the document — with a pure body
 * exported for render tests.
 */

const DIALOG = "w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl";
const QUIET_BUTTON = "rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";

/** Esc closes, claimed so it never also aborts a turn (the one-Esc law). */
function useEscape(active: boolean, onClose: () => void) {
	useEffect(() => {
		if (!active) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [active, onClose]);
}

/** The form's pure body — create when `course` is absent, edit otherwise. */
export function CourseFormBody({
	editing,
	title,
	goal,
	busy,
	error,
	onTitle,
	onGoal,
	onClose,
	onSubmit,
	titleRef,
}: {
	editing: boolean;
	title: string;
	goal: string;
	busy: boolean;
	error: string | null;
	onTitle: (next: string) => void;
	onGoal: (next: string) => void;
	onClose: () => void;
	onSubmit: () => void;
	titleRef?: React.Ref<HTMLInputElement>;
}) {
	return (
		<form
			role="dialog"
			aria-modal="true"
			aria-label={editing ? "Edit course" : "New course"}
			data-testid="course-form-dialog"
			onClick={(e) => e.stopPropagation()}
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
			className={DIALOG}
		>
			<h2 className="text-sm font-semibold">{editing ? "Edit course" : "New course"}</h2>
			<label className="mt-4 block text-xs text-muted-foreground" htmlFor="course-title">
				Title
			</label>
			<Input
				id="course-title"
				ref={titleRef}
				data-testid="course-title-input"
				value={title}
				maxLength={COURSE_TITLE_MAX}
				onChange={(e) => onTitle(e.target.value)}
				disabled={busy}
				className="mt-1"
			/>
			<label className="mt-4 block text-xs text-muted-foreground" htmlFor="course-goal">
				Goal (optional)
			</label>
			<Textarea
				id="course-goal"
				data-testid="course-goal-input"
				value={goal}
				maxLength={COURSE_GOAL_MAX}
				onChange={(e) => onGoal(e.target.value)}
				disabled={busy}
				placeholder="What do you want to be able to do by the end?"
				className="mt-1 max-h-48"
			/>
			<p className="mt-1.5 text-xs text-muted-foreground">The tutor is told the title and goal in every session of this course.</p>
			{error && (
				<p role="alert" data-testid="course-form-error" className="mt-3 text-xs text-destructive">
					{error}
				</p>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="course-form-cancel" onClick={onClose} disabled={busy} className={QUIET_BUTTON}>
					Cancel
				</button>
				<button
					type="submit"
					data-testid="course-form-submit"
					disabled={busy || title.trim() === ""}
					className="rounded-sm border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
				>
					{editing ? (busy ? "Saving…" : "Save") : busy ? "Creating…" : "Create course"}
				</button>
			</div>
		</form>
	);
}

/** Create (no `course`) or edit a course. `onSaved` receives the stored record. */
export function CourseFormDialog({
	open,
	course,
	onClose,
	onSaved,
}: {
	open: boolean;
	course?: Pick<CourseRecord, "id" | "title" | "goal">;
	onClose: () => void;
	onSaved: (course: CourseRecord) => void;
}) {
	const [title, setTitle] = useState("");
	const [goal, setGoal] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const titleRef = useRef<HTMLInputElement | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useEscape(open, onClose);

	// Fresh state per opening, seeded from the course being edited.
	useEffect(() => {
		if (!open) return;
		setTitle(course?.title ?? "");
		setGoal(course?.goal ?? "");
		setBusy(false);
		setError(null);
		requestAnimationFrame(() => titleRef.current?.focus());
	}, [open, course?.id, course?.title, course?.goal]);

	const submit = async () => {
		if (busy || title.trim() === "") return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(course ? `/api/courses/${course.id}` : "/api/courses", {
				method: course ? "PUT" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title, goal }),
			});
			const body = (await res.json()) as { course?: CourseRecord; error?: string };
			if (!res.ok || !body.course) {
				setError(body.error ?? `Could not save the course (${res.status})`);
				setBusy(false);
				return;
			}
			onSaved(body.course);
		} catch {
			setError("Could not save the course — network error. Try again.");
			setBusy(false);
		}
	};

	if (!open) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<CourseFormBody
				editing={course !== undefined}
				title={title}
				goal={goal}
				busy={busy}
				error={error}
				onTitle={setTitle}
				onGoal={setGoal}
				onClose={onClose}
				onSubmit={() => void submit()}
				titleRef={titleRef}
			/>
		</div>,
		document.body,
	);
}

/** The delete confirmation's pure body. */
export function DeleteCourseBody({
	title,
	busy,
	error,
	onClose,
	onRun,
}: {
	title: string;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete course"
			data-testid="delete-course-dialog"
			onClick={(e) => e.stopPropagation()}
			className={DIALOG}
		>
			<h2 className="text-sm font-semibold text-destructive">Delete course?</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{title}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				This removes the course and its goal. Its sessions are kept and stay in your session list. This cannot be undone.
			</p>
			{error && (
				<p role="alert" className="mt-3 text-xs text-destructive">
					{error}
				</p>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="delete-course-cancel" onClick={onClose} disabled={busy} className={QUIET_BUTTON}>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-course-confirm"
					onClick={onRun}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
}

export function DeleteCourseDialog({
	course,
	onClose,
	onDeleted,
}: {
	/** The course up for deletion; null = closed. */
	course: Pick<CourseRecord, "id" | "title"> | null;
	onClose: () => void;
	onDeleted: (id: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useEscape(course !== null, onClose);
	useEffect(() => {
		if (!course) {
			setBusy(false);
			setError(null);
		}
	}, [course]);

	const run = async () => {
		if (!course || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/courses/${course.id}`, { method: "DELETE" });
			// Already gone counts as deleted — the outcome the learner asked for.
			if (!res.ok && res.status !== 404) {
				setError(`Delete failed (${res.status}). Try again.`);
				setBusy(false);
				return;
			}
			onDeleted(course.id);
		} catch {
			setError("Delete failed — network error. Try again.");
			setBusy(false);
		}
	};

	if (!course) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<DeleteCourseBody title={course.title} busy={busy} error={error} onClose={onClose} onRun={() => void run()} />
		</div>,
		document.body,
	);
}

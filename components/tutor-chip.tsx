"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GraduationCapIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { DEFAULT_PERSONA_ID, type PersonaView, type SessionPersona } from "@/src/core";

/**
 * Who is teaching (fork, phase 6b — see FORK.md): a chip in a session's
 * header and a menu for a course. Both choose among the tutors made on the
 * Tutors page. A session's choice applies from the learner's next message;
 * the saved conversation is what the new tutor reads.
 */

const ITEM = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent";

/** The session menu's contents. Pure — exported for render tests. */
export function TutorMenuBody({
	current,
	personas,
	onPick,
}: {
	current: SessionPersona;
	personas: readonly PersonaView[];
	/** A tutor id, or null to follow the course again. */
	onPick: (personaId: string | null) => void;
}) {
	return (
		<div role="menu" aria-label="Tutor for this session" data-testid="tutor-menu" className="w-64 overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg">
			<p className="px-3 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-muted-foreground/70">Tutor for this session</p>
			{personas.map((persona) => {
				const selected = persona.id === current.persona.id;
				return (
					<button key={persona.id} type="button" role="menuitemradio" aria-checked={selected} data-testid="tutor-option" data-tutor={persona.id} onClick={() => onPick(persona.id)} className={cn(ITEM, selected && "bg-accent-soft text-primary")}>
						<span className="min-w-0 flex-1 truncate">{persona.name}</span>
						{!persona.usable && <span className="shrink-0 text-bad">unavailable</span>}
						{selected && <span className="shrink-0 text-muted-foreground">teaching</span>}
					</button>
				);
			})}
			{current.source === "session" && (
				<button type="button" role="menuitem" data-testid="tutor-follow-course" onClick={() => onPick(null)} className={cn(ITEM, "border-t border-border text-muted-foreground")}>
					Use the course’s tutor, or the default
				</button>
			)}
			<a href="/tutors" data-testid="tutor-manage" className={cn(ITEM, "border-t border-border text-muted-foreground")}>
				Edit tutors…
			</a>
		</div>
	);
}

/** The chip in a session's header. */
export function TutorChip({ chatId }: { chatId: string }) {
	const [current, setCurrent] = useState<SessionPersona | null>(null);
	const [personas, setPersonas] = useState<PersonaView[]>([]);
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	const refresh = useCallback(async () => {
		try {
			const [mine, all] = await Promise.all([fetch(`/api/chats/${chatId}/persona`), fetch("/api/personas")]);
			if (mine.ok) setCurrent((await mine.json()) as SessionPersona);
			if (all.ok) setPersonas(((await all.json()) as { personas: PersonaView[] }).personas);
		} catch {
			// a transient failure keeps what is shown
		}
	}, [chatId]);
	useEffect(() => void refresh(), [refresh]);
	useServerEvent("personas-changed", () => void refresh());
	useServerEvent("courses-changed", () => void refresh());
	useServerResync(() => void refresh());

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// The one-Esc law: claimed here so it never also aborts a turn.
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	const pick = async (personaId: string | null) => {
		setOpen(false);
		try {
			const res = await fetch(`/api/chats/${chatId}/persona`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId }) });
			if (res.ok) setCurrent((await res.json()) as SessionPersona);
		} catch {
			// the chip keeps showing the tutor that is in force
		}
	};

	if (!current) return null;
	return (
		<div ref={wrapRef} className="lh-no-drag relative shrink-0">
			<button
				type="button"
				data-testid="tutor-chip"
				aria-haspopup="menu"
				aria-expanded={open}
				title={`${current.persona.name} is teaching this session${current.source === "course" ? " (the course’s tutor)" : ""}. Click to change.`}
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"flex max-w-44 items-center gap-1.5 rounded-md border border-transparent bg-accent-soft px-2 py-1 text-xs text-primary transition-colors hover:border-primary/50",
					!current.persona.usable && "border-bad/50 bg-bad-soft text-bad",
				)}
			>
				<GraduationCapIcon className="size-3.5 shrink-0" />
				<span className="truncate">{current.persona.name}</span>
			</button>
			{open && (
				<div className="absolute right-0 top-full z-50 mt-1">
					<TutorMenuBody current={current} personas={personas} onPick={(id) => void pick(id)} />
				</div>
			)}
		</div>
	);
}

/** A course's tutor, as a plain menu on the course page. */
export function CourseTutorSelect({ courseId, personaId }: { courseId: string; personaId: string | undefined }) {
	const [personas, setPersonas] = useState<PersonaView[] | null>(null);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/personas");
			if (res.ok) setPersonas(((await res.json()) as { personas: PersonaView[] }).personas);
		} catch {
			// keeps the last list
		}
	}, []);
	useEffect(() => void refresh(), [refresh]);
	useServerEvent("personas-changed", () => void refresh());
	if (!personas) return null;
	// A tutor since deleted reads as the default, as it teaches.
	const value = personas.some((persona) => persona.id === personaId) ? personaId! : DEFAULT_PERSONA_ID;
	return (
		<label className="lh-no-drag flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
			<GraduationCapIcon className="size-3.5" />
			<span className="sr-only">Tutor for this course</span>
			<select
				data-testid="course-tutor"
				value={value}
				title="The tutor for this course’s sessions. A session can choose its own from its header."
				onChange={(event) => void fetch(`/api/courses/${courseId}/persona`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId: event.target.value }) }).catch(() => undefined)}
				className="max-w-44 rounded-sm border border-input bg-background px-1.5 py-1 text-xs"
			>
				{personas.map((persona) => (
					<option key={persona.id} value={persona.id}>
						{persona.name}
						{persona.usable ? "" : " (unavailable now)"}
					</option>
				))}
			</select>
		</label>
	);
}

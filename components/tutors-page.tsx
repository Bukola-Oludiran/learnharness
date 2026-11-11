"use client";

import { useCallback, useEffect, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { TopBar } from "@/components/top-bar";
import { cn } from "@/lib/utils";
import { MAX_PERSONA_NAME, MAX_PERSONA_OVERLAY, MAX_PERSONAS, type ModelCatalogEntry, type PersonaView } from "@/src/core";

/**
 * The Tutors page (fork, phase 6b — see FORK.md): /tutors. A tutor is a
 * name, a model and an overlay of the learner's own instructions on how to
 * teach. Courses and sessions choose among them; the page only edits the
 * list. The default tutor is the model chosen in Settings and is not
 * edited here.
 */

const QUIET = "rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const ACTION = "rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";
const FIELD = "w-full rounded-sm border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring";

export interface TutorDraft {
	/** Absent for a tutor not yet created. */
	id?: string;
	name: string;
	provider: string;
	model: string;
	promptOverlay: string;
}

/** The models as menu groups, one per provider, in catalog order. Pure. */
export function modelGroups(models: readonly Pick<ModelCatalogEntry, "provider" | "id" | "name">[]): { provider: string; models: { id: string; name: string }[] }[] {
	const groups = new Map<string, { id: string; name: string }[]>();
	for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), { id: model.id, name: model.name }]);
	return [...groups].map(([provider, entries]) => ({ provider, models: entries }));
}

const pin = (provider: string, model: string) => `${provider}\n${model}`;

/** The form for one tutor. Pure — exported for render tests. */
export function TutorForm({
	draft,
	models,
	error,
	busy,
	onChange,
	onSave,
	onCancel,
}: {
	draft: TutorDraft;
	/** The catalog — undefined while it loads. */
	models: readonly Pick<ModelCatalogEntry, "provider" | "id" | "name">[] | undefined;
	error: string | null;
	busy: boolean;
	onChange: (draft: TutorDraft) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	const groups = modelGroups(models ?? []);
	const known = (models ?? []).some((model) => model.provider === draft.provider && model.id === draft.model);
	return (
		<form
			data-testid="tutor-form"
			className="rounded-lg border border-border bg-card p-4"
			onSubmit={(event) => {
				event.preventDefault();
				onSave();
			}}
		>
			<label className="block text-xs uppercase tracking-wider text-muted-foreground" htmlFor="tutor-name">
				Name
			</label>
			<input
				id="tutor-name"
				data-testid="tutor-name"
				value={draft.name}
				maxLength={MAX_PERSONA_NAME}
				autoFocus
				onChange={(event) => onChange({ ...draft, name: event.target.value })}
				className={cn(FIELD, "mt-1")}
			/>
			<p className="mt-1 text-xs text-muted-foreground">The tutor is told this name and answers to it.</p>

			<label className="mt-3 block text-xs uppercase tracking-wider text-muted-foreground" htmlFor="tutor-model">
				Model
			</label>
			<select
				id="tutor-model"
				data-testid="tutor-model"
				value={draft.model ? pin(draft.provider, draft.model) : ""}
				disabled={models === undefined}
				onChange={(event) => {
					const [provider = "", model = ""] = event.target.value.split("\n");
					onChange({ ...draft, provider, model });
				}}
				className={cn(FIELD, "mt-1")}
			>
				{!draft.model && <option value="">{models === undefined ? "Loading models…" : "Choose a model"}</option>}
				{/* A model the catalog does not list today (its agent is signed out, say) stays selectable. */}
				{draft.model && !known && <option value={pin(draft.provider, draft.model)}>{`${draft.provider} · ${draft.model} (unavailable now)`}</option>}
				{groups.map((group) => (
					<optgroup key={group.provider} label={group.provider}>
						{group.models.map((model) => (
							<option key={model.id} value={pin(group.provider, model.id)}>
								{model.name === model.id ? model.id : `${model.name} · ${model.id}`}
							</option>
						))}
					</optgroup>
				))}
			</select>

			<label className="mt-3 block text-xs uppercase tracking-wider text-muted-foreground" htmlFor="tutor-overlay">
				How it should teach (optional)
			</label>
			<textarea
				id="tutor-overlay"
				data-testid="tutor-overlay"
				value={draft.promptOverlay}
				maxLength={MAX_PERSONA_OVERLAY}
				rows={6}
				placeholder="For example: ask me a question before explaining anything; keep explanations short; use examples from physics."
				onChange={(event) => onChange({ ...draft, promptOverlay: event.target.value })}
				className={cn(FIELD, "mt-1 resize-y leading-relaxed")}
			/>
			<p className="mt-1 text-xs text-muted-foreground">
				Added to the end of the tutor’s instructions for tone, pacing and style. It cannot change the app’s rules or what the tutor’s tools do.{" "}
				<span className="tabular-nums">
					{draft.promptOverlay.length.toLocaleString("en-US")} / {MAX_PERSONA_OVERLAY.toLocaleString("en-US")}
				</span>
			</p>

			{error && (
				<p data-testid="tutor-error" role="alert" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
			<div className="mt-3 flex justify-end gap-2">
				<button type="button" data-testid="tutor-cancel" onClick={onCancel} disabled={busy} className={QUIET}>
					Cancel
				</button>
				<button type="submit" data-testid="tutor-save" disabled={busy || !draft.name.trim() || !draft.model} className={ACTION}>
					{busy ? "Saving…" : draft.id ? "Save" : "Add tutor"}
				</button>
			</div>
		</form>
	);
}

/** One tutor in the list. Pure — exported for render tests. */
export function TutorCard({ persona, modelName, onEdit, onDelete }: { persona: PersonaView; modelName?: string; onEdit: () => void; onDelete: () => void }) {
	return (
		<div data-testid="tutor-card" data-tutor={persona.id} className="rounded-lg border border-border px-4 py-3">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-semibold">{persona.name}</p>
					<p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
						{persona.engine ? `${persona.engine.provider} · ${modelName && modelName !== persona.engine.model ? `${modelName} · ` : ""}${persona.engine.model}` : "The model chosen in Settings"}
						{!persona.usable && (
							<span data-testid="tutor-unavailable" className="ml-2 rounded-sm border border-destructive/50 px-1 font-sans text-destructive">
								unavailable now
							</span>
						)}
					</p>
				</div>
				{!persona.builtIn && (
					<>
						<button type="button" data-testid="tutor-edit" aria-label={`Edit ${persona.name}`} onClick={onEdit} className={QUIET}>
							<PencilIcon className="size-3.5" />
						</button>
						<button type="button" data-testid="tutor-delete" aria-label={`Delete ${persona.name}`} onClick={onDelete} className={QUIET}>
							<Trash2Icon className="size-3.5" />
						</button>
					</>
				)}
			</div>
			<p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
				{persona.builtIn
					? "Teaches every session that has no tutor of its own. Change its model in Settings."
					: persona.promptOverlay
						? persona.promptOverlay.length > 280
							? `${persona.promptOverlay.slice(0, 280)}…`
							: persona.promptOverlay
						: "No teaching instructions of its own."}
			</p>
		</div>
	);
}

const blank = (): TutorDraft => ({ name: "", provider: "", model: "", promptOverlay: "" });

export function TutorsPage() {
	const [personas, setPersonas] = useState<PersonaView[] | null>(null);
	const [models, setModels] = useState<ModelCatalogEntry[] | undefined>(undefined);
	const [draft, setDraft] = useState<TutorDraft | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/personas");
			if (res.ok) setPersonas(((await res.json()) as { personas: PersonaView[] }).personas);
		} catch {
			setPersonas((prev) => prev ?? []); // a transient failure keeps the last list
		}
	}, []);
	useEffect(() => {
		void refresh();
		fetch("/api/models")
			.then(async (res) => setModels(res.ok ? ((await res.json()) as { models: ModelCatalogEntry[] }).models : []))
			.catch(() => setModels([]));
	}, [refresh]);
	useServerEvent("personas-changed", () => void refresh());
	useServerResync(() => void refresh());

	const save = async () => {
		if (!draft || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(draft.id ? `/api/personas/${draft.id}` : "/api/personas", {
				method: draft.id ? "PUT" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: draft.name, engine: { provider: draft.provider, model: draft.model }, promptOverlay: draft.promptOverlay }),
			});
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "The tutor could not be saved.");
				return;
			}
			setDraft(null);
			await refresh();
		} catch {
			setError("The tutor could not be saved: network error.");
		} finally {
			setBusy(false);
		}
	};
	const remove = async (id: string) => {
		setConfirming(null);
		await fetch(`/api/personas/${id}`, { method: "DELETE" }).catch(() => undefined);
		await refresh();
	};
	const nameOf = (persona: PersonaView) => models?.find((model) => model.provider === persona.engine?.provider && model.id === persona.engine?.model)?.name;
	const custom = (personas ?? []).filter((persona) => !persona.builtIn).length;

	return (
		<div className="flex h-dvh min-w-0 flex-col" data-testid="tutors-page">
			<TopBar>
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Tutors</span>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[46rem] space-y-3 px-4 py-6">
					<p className="text-sm text-muted-foreground">
						A tutor is a name, a model and your own instructions on how to teach. Choose one for a course on the course’s page, or for one session from the chip in its header.
					</p>
					{personas?.map((persona) =>
						draft?.id === persona.id ? (
							<TutorForm key={persona.id} draft={draft} models={models} error={error} busy={busy} onChange={setDraft} onSave={() => void save()} onCancel={() => setDraft(null)} />
						) : (
							<div key={persona.id}>
								<TutorCard
									persona={persona}
									modelName={nameOf(persona)}
									onEdit={() => {
										setError(null);
										setDraft({ id: persona.id, name: persona.name, provider: persona.engine?.provider ?? "", model: persona.engine?.model ?? "", promptOverlay: persona.promptOverlay });
									}}
									onDelete={() => setConfirming(persona.id)}
								/>
								{confirming === persona.id && (
									<div data-testid="tutor-confirm-delete" className="mt-1 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
										<span className="flex-1 text-muted-foreground">Delete {persona.name}? Its courses and sessions go back to their course’s tutor or the default. No session is deleted.</span>
										<button type="button" onClick={() => setConfirming(null)} className={QUIET}>
											Keep
										</button>
										<button type="button" data-testid="tutor-confirm-delete-yes" onClick={() => void remove(persona.id)} className={ACTION}>
											Delete
										</button>
									</div>
								)}
							</div>
						),
					)}
					{draft && !draft.id ? (
						<TutorForm draft={draft} models={models} error={error} busy={busy} onChange={setDraft} onSave={() => void save()} onCancel={() => setDraft(null)} />
					) : (
						<button
							type="button"
							data-testid="tutor-add"
							disabled={personas === null || custom >= MAX_PERSONAS}
							onClick={() => {
								setError(null);
								setDraft(blank());
							}}
							className={cn(ACTION, "flex items-center gap-1.5")}
						>
							<PlusIcon className="size-3" />
							Add tutor
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

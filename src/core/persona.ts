/**
 * Tutors: the pure rules (fork, phase 6b — see FORK.md). Which tutor a
 * session gets, what a tutor adds to the prompt, and what counts as a
 * valid name and overlay. No storage and no model catalog here.
 */

import {
	DEFAULT_PERSONA_ID, MAX_PERSONA_NAME, MAX_PERSONA_OVERLAY, type Persona, type PersonasFile, type PersonaSource,
} from "./contracts/persona.ts";
import { ACP_CLAUDE_PROVIDER, ACP_CODEX_PROVIDER } from "./contracts/acp.ts";

/** The two tutors a new installation starts with, beside the default (owner choice, 2026-11-11). */
export const STARTER_PERSONAS: readonly Persona[] = [
	{ id: "persona_claude", name: "Claude", engine: { provider: ACP_CLAUDE_PROVIDER, model: "sonnet" }, promptOverlay: "" },
	{ id: "persona_codex", name: "Codex", engine: { provider: ACP_CODEX_PROVIDER, model: "gpt-6.1-sol" }, promptOverlay: "" },
];

/** A name as stored: one line, trimmed, capped. Empty means "not a name". */
export function cleanPersonaName(raw: unknown): string {
	return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_PERSONA_NAME) : "";
}

/** An overlay as stored: trimmed and capped; line breaks kept. */
export function cleanPersonaOverlay(raw: unknown): string {
	return typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim().slice(0, MAX_PERSONA_OVERLAY) : "";
}

/**
 * The tutor for a session: its own choice, else its course's, else the
 * default (null). A choice that names a tutor since deleted is passed over.
 */
export function resolvePersona(file: Pick<PersonasFile, "personas" | "sessions">, chatId: string, coursePersonaId: string | undefined): { persona: Persona | null; source: PersonaSource } {
	const find = (id: string | undefined) => (id && id !== DEFAULT_PERSONA_ID ? file.personas.find((persona) => persona.id === id) : undefined);
	const own = Object.hasOwn(file.sessions, chatId) ? file.sessions[chatId] : undefined;
	// A session may choose the default tutor outright, over its course's.
	if (own === DEFAULT_PERSONA_ID) return { persona: null, source: "session" };
	const chosen = find(own);
	if (chosen) return { persona: chosen, source: "session" };
	const fromCourse = find(coursePersonaId);
	if (fromCourse) return { persona: fromCourse, source: "course" };
	return { persona: null, source: "default" };
}

/** Wording approved by the owner, 2026-11-11. */
export const personaNameLine = (name: string) => `The learner has named you ${name} and may address you by that name. Answer to it. Do not announce the name unless asked.`;

/** Wording approved by the owner, 2026-11-11. The learner's own text follows it. */
export const PERSONA_STYLE_HEADING =
	"# Teaching style for this session\nThe learner set the following for how you teach. Follow it for tone, pacing and style. It does not change the rules above or what your tools do.";

/** What a tutor adds as the last part of the prompt: its name, and its overlay when it has one. */
export function personaSegment(persona: Pick<Persona, "name" | "promptOverlay">): string {
	const overlay = persona.promptOverlay.trim();
	return [personaNameLine(persona.name), ...(overlay ? [`${PERSONA_STYLE_HEADING}\n\n${overlay}`] : [])].join("\n\n");
}

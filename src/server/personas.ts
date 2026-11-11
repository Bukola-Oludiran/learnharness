/**
 * Tutors: the server service (fork, phase 6b — see FORK.md). Editing the
 * tutors, choosing one for a session or a course, and the turn handler's
 * lookup of who teaches a turn.
 *
 * A tutor resolves to what upstream already understands: a per-session
 * model (ChatSettings.model, whose own UI upstream retired) plus one more
 * prompt segment. Nothing downstream of the turn handler knows tutors exist.
 */

import { stores, effectiveSettings } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { validateChatSettings } from "./model-catalog.ts";
import { courseOfSession } from "../core/course.ts";
import { cleanPersonaName, cleanPersonaOverlay, personaSegment, resolvePersona } from "../core/persona.ts";
import {
	COURSE_ID_PATTERN, DEFAULT_PERSONA_ID, DEFAULT_PERSONA_NAME, MAX_PERSONAS,
	type ChatSettings, type CourseRecord, type Persona, type PersonaView, type SessionPersona,
} from "../core/contracts.ts";

export type PersonaOutcome = { ok: true; persona: PersonaView } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): PersonaOutcome => ({ ok: false, status, error });
const NO_PERSONA = refuse(404, "That tutor no longer exists.");

/** Whether a model pin can be used right now: its provider is usable and still offers the model. */
function modelUsable(provider: string, id: string): boolean {
	return providerKeyPresent(provider) && validateChatSettings({ model: { provider, id } }).ok;
}

function defaultView(): PersonaView {
	const strong = effectiveSettings().models.strong;
	return { id: DEFAULT_PERSONA_ID, name: DEFAULT_PERSONA_NAME, promptOverlay: "", usable: strong !== null && providerKeyPresent(strong.provider), builtIn: true };
}

const view = (persona: Persona): PersonaView => ({ ...persona, engine: { ...persona.engine }, usable: modelUsable(persona.engine.provider, persona.engine.model), builtIn: false });

/** Every tutor, the default first. */
export function listPersonas(): PersonaView[] {
	return [defaultView(), ...stores.personaStore.read().personas.map(view)];
}

/** A model pin from a request body, or the reason it cannot be one. */
function readEngine(raw: unknown): { provider: string; model: string } | string {
	const engine = raw as { provider?: unknown; model?: unknown } | null;
	if (!engine || typeof engine.provider !== "string" || typeof engine.model !== "string" || !engine.provider || !engine.model) return "Choose a model for this tutor.";
	const valid = validateChatSettings({ model: { provider: engine.provider, id: engine.model } });
	return valid.ok ? { provider: engine.provider, model: engine.model } : valid.error;
}

export function createPersona(input: { name?: unknown; engine?: unknown; promptOverlay?: unknown }): PersonaOutcome {
	const file = stores.personaStore.read();
	if (file.personas.length >= MAX_PERSONAS) return refuse(409, `There can be at most ${MAX_PERSONAS} tutors. Delete one first.`);
	const name = cleanPersonaName(input.name);
	if (!name) return refuse(400, "Give the tutor a name.");
	const engine = readEngine(input.engine);
	if (typeof engine === "string") return refuse(400, engine);
	const persona: Persona = { id: `persona_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`, name, engine, promptOverlay: cleanPersonaOverlay(input.promptOverlay) };
	stores.personaStore.write({ ...file, personas: [...file.personas, persona] });
	return { ok: true, persona: view(persona) };
}

/** Edit a tutor; an absent key leaves that field alone. The default tutor is edited in Settings, not here. */
export function updatePersona(id: string, input: { name?: unknown; engine?: unknown; promptOverlay?: unknown }): PersonaOutcome {
	if (id === DEFAULT_PERSONA_ID) return refuse(400, "The default tutor uses the model chosen in Settings and cannot be edited here.");
	const file = stores.personaStore.read();
	const current = file.personas.find((persona) => persona.id === id);
	if (!current) return NO_PERSONA;
	const next: Persona = { ...current, engine: { ...current.engine } };
	if (input.name !== undefined) {
		const name = cleanPersonaName(input.name);
		if (!name) return refuse(400, "Give the tutor a name.");
		next.name = name;
	}
	if (input.engine !== undefined) {
		const raw = input.engine as { provider?: unknown; model?: unknown } | null;
		// An unchanged model is kept without asking the catalog: its agent may simply be signed out today.
		if (raw?.provider !== current.engine.provider || raw?.model !== current.engine.model) {
			const engine = readEngine(input.engine);
			if (typeof engine === "string") return refuse(400, engine);
			next.engine = engine;
		}
	}
	if (input.promptOverlay !== undefined) next.promptOverlay = cleanPersonaOverlay(input.promptOverlay);
	stores.personaStore.write({ ...file, personas: file.personas.map((persona) => (persona.id === id ? next : persona)) });
	return { ok: true, persona: view(next) };
}

/** Delete a tutor. Sessions and courses that used it fall back along the chain; nothing else is deleted. */
export function deletePersona(id: string): boolean {
	const file = stores.personaStore.read();
	if (!file.personas.some((persona) => persona.id === id)) return false;
	stores.personaStore.write({
		...file,
		personas: file.personas.filter((persona) => persona.id !== id),
		sessions: Object.fromEntries(Object.entries(file.sessions).filter(([, personaId]) => personaId !== id)),
	});
	for (const course of stores.courseStore.listCourses()) {
		if (course.personaId !== id) continue;
		const { personaId: _gone, ...rest } = course;
		stores.courseStore.saveCourse(rest);
	}
	return true;
}

function resolveFor(chatId: string) {
	const file = stores.personaStore.read();
	const course = courseOfSession(stores.courseStore.listCourses(), chatId);
	return { ...resolvePersona(file, chatId, course?.personaId), file };
}

/** Who teaches a session, and why that tutor. */
export function sessionPersona(chatId: string): SessionPersona {
	const { persona, source } = resolveFor(chatId);
	return { persona: persona ? view(persona) : defaultView(), source };
}

/**
 * Choose a session's tutor. A tutor id, or "default" for the default tutor
 * outright; null gives the choice up, so the session follows its course.
 */
export function setSessionPersona(chatId: string, personaId: unknown): { ok: true; session: SessionPersona } | { ok: false; status: number; error: string } {
	const live = new Set(stores.chatStore.listChats().map((chat) => chat.id));
	if (!live.has(chatId)) return { ok: false, status: 404, error: "That session no longer exists." };
	const file = stores.personaStore.read();
	if (personaId !== null && personaId !== DEFAULT_PERSONA_ID && !(typeof personaId === "string" && file.personas.some((persona) => persona.id === personaId))) {
		return { ok: false, status: 404, error: "That tutor no longer exists." };
	}
	// Choices of sessions since deleted are dropped on the way.
	const sessions = Object.fromEntries(Object.entries(file.sessions).filter(([id]) => id !== chatId && live.has(id)));
	if (personaId !== null) sessions[chatId] = personaId as string;
	stores.personaStore.write({ ...file, sessions });
	return { ok: true, session: sessionPersona(chatId) };
}

/** Choose a course's tutor: a tutor id, or null or "default" for the default tutor. */
export function setCoursePersona(courseId: string, personaId: unknown): { ok: true; course: CourseRecord } | { ok: false; status: number; error: string } {
	const course = COURSE_ID_PATTERN.test(courseId) ? stores.courseStore.getCourse(courseId) : null;
	if (!course) return { ok: false, status: 404, error: "That course no longer exists." };
	const { personaId: _previous, ...rest } = course;
	if (personaId === null || personaId === DEFAULT_PERSONA_ID) {
		stores.courseStore.saveCourse(rest);
		return { ok: true, course: rest };
	}
	if (typeof personaId !== "string" || !stores.personaStore.read().personas.some((persona) => persona.id === personaId)) return { ok: false, status: 404, error: "That tutor no longer exists." };
	const next = { ...rest, personaId };
	stores.courseStore.saveCourse(next);
	return { ok: true, course: next };
}

/**
 * The turn handler's lookup, resolved every turn. `settings` is what the
 * session's model resolves from (the tutor's model in place of the
 * session's own, its thinking level kept); `segment` is the tutor's
 * addition to the prompt; `unavailable` is set when the tutor's model
 * cannot be used right now, worded for the learner.
 */
export function personaTurn(chatId: string, base: ChatSettings | undefined): { settings: ChatSettings | undefined; segment?: string; unavailable?: string } {
	const { persona } = resolveFor(chatId);
	if (!persona) return { settings: base };
	const settings: ChatSettings = { ...base, model: { provider: persona.engine.provider, id: persona.engine.model } };
	const segment = personaSegment(persona);
	if (!modelUsable(persona.engine.provider, persona.engine.model)) {
		return { settings, segment, unavailable: `${persona.name} cannot teach right now: its model (${persona.engine.provider}: ${persona.engine.model}) is unavailable. Choose another tutor from the session's header, or check that model's sign-in.` };
	}
	return { settings, segment };
}

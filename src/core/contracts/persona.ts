/**
 * Tutors (fork, phase 6b — see FORK.md). The architecture doc calls the
 * record a persona; the app calls it a tutor. One is small: a name, a
 * model, and an overlay of the learner's own instructions on how to teach.
 *
 * The tutor for a turn is chosen fresh each time, in order: the session's
 * own choice, then its course's tutor (CourseRecord.personaId), then the
 * default tutor. The default tutor is not a record: it is the model chosen
 * in Settings with no overlay, as every session ran before tutors existed.
 */

export interface Persona {
	id: string;
	name: string;
	/** A model pin from the app's catalog; often an ACP agent. */
	engine: { provider: string; model: string };
	/** Added as the last part of the tutor's prompt. May be empty. */
	promptOverlay: string;
}

/** personas.json: every tutor, and each session's own choice of one. */
export interface PersonasFile {
	version: number;
	personas: Persona[];
	/** Session (chat) id → tutor id. A session absent here follows its course, then the default. */
	sessions: Record<string, string>;
}

export const CURRENT_PERSONAS_VERSION = 1;
/** The id that means "the default tutor" wherever a tutor id is accepted. */
export const DEFAULT_PERSONA_ID = "default";
export const DEFAULT_PERSONA_NAME = "Default tutor";
export const PERSONA_ID_PATTERN = /^persona_[a-z0-9_]{1,40}$/;
export const MAX_PERSONA_NAME = 40;
export const MAX_PERSONA_OVERLAY = 4000;
export const MAX_PERSONAS = 30;

/** Where a session's tutor came from. */
export type PersonaSource = "session" | "course" | "default";

/** A tutor as the pages show it. */
export interface PersonaView {
	id: string;
	name: string;
	/** Absent for the default tutor, whose model is the one set in Settings. */
	engine?: { provider: string; model: string };
	promptOverlay: string;
	/** Its model can be used right now. */
	usable: boolean;
	builtIn: boolean;
}

/** The tutor teaching one session. */
export interface SessionPersona {
	persona: PersonaView;
	source: PersonaSource;
}

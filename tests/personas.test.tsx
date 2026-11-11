/**
 * Tutors (fork, phase 6b — FORK.md): the rules for who teaches a session,
 * what a tutor adds to the prompt, the file store, the service and its
 * routes, and the page, chip and menu as rendered. Driven framework-free
 * under an isolated data folder, with one keyed provider so models validate.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-personas-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
process.env.OPENROUTER_API_KEY = "test-key";
process.env.LH_ACP_AGENTS_DIR = path.join(root, "no-agents");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const personasRoute = await import("../app/api/personas/route.ts");
const personaRoute = await import("../app/api/personas/[id]/route.ts");
const sessionRoute = await import("../app/api/chats/[id]/persona/route.ts");
const courseRoute = await import("../app/api/courses/[id]/persona/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { personaTurn, sessionPersona, listPersonas } = await import("../src/server/personas.ts");
const { addSessionToCourse } = await import("../src/server/courses.ts");
const { piModels } = await import("../src/agent/models.ts");
const { subscribe } = await import("../src/core/events.ts");
const { PERSONAS_FILE } = await import("../config.ts");
const { cleanPersonaName, cleanPersonaOverlay, personaNameLine, personaSegment, PERSONA_STYLE_HEADING, resolvePersona, STARTER_PERSONAS } = await import("../src/core/persona.ts");
const { TutorCard, TutorForm, modelGroups } = await import("../components/tutors-page.tsx");
const { TutorMenuBody } = await import("../components/tutor-chip.tsx");
import type { Persona, PersonaView } from "../src/core/contracts.ts";

const MODEL = piModels().getModels("openrouter")[0]!;
const OTHER = piModels().getModels("openrouter")[1]!;
const json = (method: string, body?: unknown) => new Request("http://test/api", { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });
const noop = () => {};

async function create(name: string, overlay = "", model = MODEL.id): Promise<PersonaView> {
	const res = await personasRoute.POST(json("POST", { name, engine: { provider: "openrouter", model }, promptOverlay: overlay }));
	assert.equal(res.status, 201, await res.clone().text());
	return ((await res.json()) as { persona: PersonaView }).persona;
}

describe("who teaches a session", () => {
	const ada: Persona = { id: "persona_ada", name: "Ada", engine: { provider: "p", model: "m" }, promptOverlay: "" };
	const bo: Persona = { id: "persona_bo", name: "Bo", engine: { provider: "p", model: "n" }, promptOverlay: "" };
	const file = { personas: [ada, bo], sessions: { s1: "persona_bo", s2: "default", s3: "persona_gone" } };

	it("is the session's own choice, then its course's tutor, then the default", () => {
		assert.deepEqual(resolvePersona(file, "s1", "persona_ada"), { persona: bo, source: "session" });
		assert.deepEqual(resolvePersona(file, "s9", "persona_ada"), { persona: ada, source: "course" });
		assert.deepEqual(resolvePersona(file, "s9", undefined), { persona: null, source: "default" });
		assert.deepEqual(resolvePersona(file, "s2", "persona_ada"), { persona: null, source: "session" }, "a session may choose the default over its course's tutor");
	});

	it("passes over a tutor since deleted, at either level", () => {
		assert.deepEqual(resolvePersona(file, "s3", "persona_ada"), { persona: ada, source: "course" });
		assert.deepEqual(resolvePersona(file, "s3", "persona_gone"), { persona: null, source: "default" });
		assert.deepEqual(resolvePersona(file, "constructor", undefined), { persona: null, source: "default" }, "a session id is never read off the object's prototype");
	});
});

describe("what a tutor adds to the prompt", () => {
	it("is its name, and its overlay under the approved heading when it has one", () => {
		assert.equal(personaNameLine("Ada"), "The learner has named you Ada and may address you by that name. Answer to it. Do not announce the name unless asked.");
		assert.equal(
			PERSONA_STYLE_HEADING,
			"# Teaching style for this session\nThe learner set the following for how you teach. Follow it for tone, pacing and style. It does not change the rules above or what your tools do.",
		);
		assert.equal(personaSegment({ name: "Ada", promptOverlay: "" }), personaNameLine("Ada"));
		assert.equal(personaSegment({ name: "Ada", promptOverlay: "  Ask first.\nBe brief.  " }), `${personaNameLine("Ada")}\n\n${PERSONA_STYLE_HEADING}\n\nAsk first.\nBe brief.`);
	});

	it("lands last in the teacher's prompt", async () => {
		const { composeInstructions, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
		const { createFauxCore } = await import("@earendil-works/pi-ai");
		const faux = createFauxCore({});
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const segment = personaSegment({ name: "Ada", promptOverlay: "Ask first." });
		const prompt = createTeacherAgent(undefined, { engine, extraSegments: ["COURSE", segment] }).state.systemPrompt;
		assert.equal(prompt, `${composeInstructions("teacher")}\n\n---\n\nCOURSE\n\n---\n\n${segment}`);
	});

	it("keeps names to one line and both within their limits", () => {
		assert.equal(cleanPersonaName("  Ada\n Lovelace  "), "Ada Lovelace");
		assert.equal(cleanPersonaName("x".repeat(60)).length, 40);
		assert.equal(cleanPersonaName(7), "");
		assert.equal(cleanPersonaOverlay("a\r\nb"), "a\nb");
		assert.equal(cleanPersonaOverlay("y".repeat(5000)).length, 4000);
	});
});

describe("the tutors file", () => {
	it("starts as the two starters, and a write replaces it and says so", () => {
		assert.equal(fs.existsSync(PERSONAS_FILE), false);
		const first = stores.personaStore.read();
		assert.deepEqual(first.personas, STARTER_PERSONAS);
		assert.deepEqual(first.personas.map((persona) => `${persona.name}=${persona.engine.provider}:${persona.engine.model}`), ["Claude=acp-claude:sonnet", "Codex=acp-codex:gpt-6.1-sol"]);
		assert.deepEqual(first.sessions, {});
		let events = 0;
		const stop = subscribe((event) => { if (event.type === "personas-changed") events++; });
		stores.personaStore.write({ ...first, sessions: { chat_x: "persona_claude" } });
		stop();
		assert.equal(events, 1);
		assert.deepEqual(stores.personaStore.read().sessions, { chat_x: "persona_claude" });
		assert.equal(JSON.parse(fs.readFileSync(PERSONAS_FILE, "utf8")).version, 1);
	});

	it("drops entries it cannot trust, and never overwrites a file from a newer build", () => {
		fs.writeFileSync(PERSONAS_FILE, JSON.stringify({ version: 1, personas: [{ id: "persona_ok", name: " Ok ", engine: { provider: "p", model: "m" }, promptOverlay: 5 }, { id: "bad id", name: "x", engine: { provider: "p", model: "m" } }, { id: "persona_ok", name: "dup", engine: { provider: "p", model: "m" } }, { id: "persona_noengine", name: "y" }], sessions: { a: "persona_ok", b: 3 } }));
		assert.deepEqual(stores.personaStore.read(), { version: 1, personas: [{ id: "persona_ok", name: "Ok", engine: { provider: "p", model: "m" }, promptOverlay: "" }], sessions: { a: "persona_ok" } });
		fs.writeFileSync(PERSONAS_FILE, "{ not json");
		assert.deepEqual(stores.personaStore.read().personas, [], "an unreadable file is not replaced by the starters");
		fs.writeFileSync(PERSONAS_FILE, JSON.stringify({ version: 99, personas: [], sessions: {} }));
		const newer = stores.personaStore.read();
		assert.equal(newer.version, 99);
		assert.throws(() => stores.personaStore.write(newer), /newer version/);
		fs.rmSync(PERSONAS_FILE);
	});
});

describe("the tutors service and routes", () => {
	it("lists the default first, creates, edits and refuses what is not a tutor", async () => {
		const listed = ((await (await personasRoute.GET()).json()) as { personas: PersonaView[] }).personas;
		assert.deepEqual(listed.map((persona) => [persona.id, persona.builtIn]), [["default", true], ["persona_claude", false], ["persona_codex", false]]);
		assert.equal(listed[1]!.usable, false, "an ACP agent that is not installed is shown as unavailable");
		assert.equal(listed[0]!.engine, undefined);

		const ada = await create("  Ada  ", "Ask first.");
		assert.match(ada.id, /^persona_[a-z0-9_]+$/);
		assert.deepEqual({ name: ada.name, engine: ada.engine, promptOverlay: ada.promptOverlay, usable: ada.usable, builtIn: ada.builtIn }, { name: "Ada", engine: { provider: "openrouter", model: MODEL.id }, promptOverlay: "Ask first.", usable: true, builtIn: false });

		const bad = async (body: unknown, status: number, error: RegExp) => {
			const res = await personasRoute.POST(json("POST", body));
			assert.equal(res.status, status);
			assert.match(((await res.json()) as { error: string }).error, error);
		};
		await bad({ name: " ", engine: { provider: "openrouter", model: MODEL.id } }, 400, /Give the tutor a name/);
		await bad({ name: "X" }, 400, /Choose a model/);
		await bad({ name: "X", engine: { provider: "openrouter", model: "no-such-model" } }, 400, /No model "no-such-model"/);
		await bad({ name: "X", engine: { provider: "nowhere", model: "m" } }, 400, /Unknown provider/);

		const renamed = await personaRoute.PUT(json("PUT", { name: "Ada L." }), at(ada.id));
		assert.equal(((await renamed.json()) as { persona: PersonaView }).persona.name, "Ada L.");
		const edited = ((await (await personaRoute.PUT(json("PUT", { engine: { provider: "openrouter", model: OTHER.id }, promptOverlay: "" }), at(ada.id))).json()) as { persona: PersonaView }).persona;
		assert.deepEqual([edited.name, edited.engine!.model, edited.promptOverlay], ["Ada L.", OTHER.id, ""], "absent keys are left alone");
		// A starter whose agent is not installed can still be renamed: its unchanged model is not re-checked.
		assert.equal((await personaRoute.PUT(json("PUT", { name: "Claude S", engine: { provider: "acp-claude", model: "sonnet" } }), at("persona_claude"))).status, 200);
		assert.equal((await personaRoute.PUT(json("PUT", { name: "x" }), at("default"))).status, 400);
		assert.equal((await personaRoute.PUT(json("PUT", { name: "x" }), at("persona_missing"))).status, 404);
		assert.equal((await personaRoute.DELETE(json("DELETE"), at("persona_missing"))).status, 404);
	});

	it("a course's tutor teaches its sessions, a session's own choice wins, and both fall back when the tutor is deleted", async () => {
		const ada = await create("Ada", "Ask first.");
		const bo = await create("Bo");
		const course = stores.courseStore.createCourse("Stats", "");
		const inCourse = stores.chatStore.createChat("in course");
		const loose = stores.chatStore.createChat("loose");
		assert.equal(addSessionToCourse(course.id, inCourse.id).ok, true);

		assert.deepEqual([sessionPersona(inCourse.id).persona.id, sessionPersona(inCourse.id).source], ["default", "default"]);
		assert.equal((await courseRoute.PUT(json("PUT", { personaId: ada.id }), at(course.id))).status, 200);
		assert.equal(stores.courseStore.getCourse(course.id)!.personaId, ada.id);
		assert.deepEqual([sessionPersona(inCourse.id).persona.name, sessionPersona(inCourse.id).source], ["Ada", "course"]);
		assert.equal(sessionPersona(loose.id).source, "default", "a session outside the course is not affected");

		const chosen = (await (await sessionRoute.PUT(json("PUT", { personaId: bo.id }), at(inCourse.id))).json()) as { persona: PersonaView; source: string };
		assert.deepEqual([chosen.persona.name, chosen.source], ["Bo", "session"]);
		assert.deepEqual(await (await sessionRoute.GET(json("GET"), at(inCourse.id))).json(), chosen);
		assert.equal(((await (await sessionRoute.PUT(json("PUT", { personaId: "default" }), at(inCourse.id))).json()) as { source: string }).source, "session");
		assert.equal(sessionPersona(inCourse.id).persona.id, "default");
		// Giving the choice up follows the course again.
		assert.equal(((await (await sessionRoute.PUT(json("PUT", { personaId: null }), at(inCourse.id))).json()) as { persona: PersonaView }).persona.name, "Ada");

		assert.equal((await sessionRoute.PUT(json("PUT", { personaId: "persona_missing" }), at(inCourse.id))).status, 404);
		assert.equal((await sessionRoute.PUT(json("PUT", { personaId: bo.id }), at("chat_missing"))).status, 404);
		assert.equal((await sessionRoute.PUT(json("PUT", {}), at(inCourse.id))).status, 400);
		assert.equal((await courseRoute.PUT(json("PUT", { personaId: "persona_missing" }), at(course.id))).status, 404);
		assert.equal((await courseRoute.PUT(json("PUT", { personaId: ada.id }), at("course_missing"))).status, 404);

		await sessionRoute.PUT(json("PUT", { personaId: bo.id }), at(loose.id));
		assert.equal((await personaRoute.DELETE(json("DELETE"), at(bo.id))).status, 200);
		assert.equal(sessionPersona(loose.id).source, "default");
		assert.equal(Object.hasOwn(stores.personaStore.read().sessions, loose.id), false, "the deleted tutor's session choices are removed");
		assert.equal((await personaRoute.DELETE(json("DELETE"), at(ada.id))).status, 200);
		assert.equal(stores.courseStore.getCourse(course.id)!.personaId, undefined);
		assert.equal(sessionPersona(inCourse.id).source, "default");
		assert.ok(stores.chatStore.getChat(inCourse.id), "no session is deleted with a tutor");
		// "default" clears a course's tutor too.
		const cy = await create("Cy");
		await courseRoute.PUT(json("PUT", { personaId: cy.id }), at(course.id));
		await courseRoute.PUT(json("PUT", { personaId: "default" }), at(course.id));
		assert.equal(stores.courseStore.getCourse(course.id)!.personaId, undefined);
	});

	it("gives the turn the tutor's model and prompt addition, and a named refusal when its model cannot be used", async () => {
		const chat = stores.chatStore.createChat("turn");
		assert.deepEqual(personaTurn(chat.id, { thinkingLevel: "high" }), { settings: { thinkingLevel: "high" } }, "the default tutor changes nothing");
		assert.deepEqual(personaTurn(chat.id, undefined), { settings: undefined });

		const dee = await create("Dee", "Be brief.");
		await sessionRoute.PUT(json("PUT", { personaId: dee.id }), at(chat.id));
		const turn = personaTurn(chat.id, { model: { provider: "old", id: "old" }, thinkingLevel: "high" });
		assert.deepEqual(turn.settings, { model: { provider: "openrouter", id: MODEL.id }, thinkingLevel: "high" }, "the tutor's model, the session's own thinking level");
		assert.equal(turn.segment, personaSegment({ name: "Dee", promptOverlay: "Be brief." }));
		assert.equal(turn.unavailable, undefined);

		await sessionRoute.PUT(json("PUT", { personaId: "persona_codex" }), at(chat.id));
		const refused = personaTurn(chat.id, undefined);
		assert.equal(refused.unavailable, "Codex cannot teach right now: its model (acp-codex: gpt-6.1-sol) is unavailable. Choose another tutor from the session's header, or check that model's sign-in.");
		assert.deepEqual(refused.settings, { model: { provider: "acp-codex", id: "gpt-6.1-sol" } }, "no other tutor is substituted");
		assert.equal(listPersonas().find((persona) => persona.id === "persona_codex")!.usable, false);
	});
});

describe("the tutors page, chip and menus as rendered", () => {
	const tutor = (over: Partial<PersonaView> = {}): PersonaView => ({ id: "persona_ada", name: "Ada", engine: { provider: "acp-claude", model: "sonnet" }, promptOverlay: "Ask first.", usable: true, builtIn: false, ...over });
	const builtIn = tutor({ id: "default", name: "Default tutor", engine: undefined, promptOverlay: "", builtIn: true });

	it("shows a tutor's model and instructions; the default has no edit or delete", () => {
		const card = renderToStaticMarkup(<TutorCard persona={tutor()} modelName="Sonnet 5.5" onEdit={noop} onDelete={noop} />);
		assert.match(card, /data-tutor="persona_ada"[\s\S]*>Ada<[\s\S]*acp-claude · Sonnet 5\.5 · sonnet[\s\S]*aria-label="Edit Ada"[\s\S]*aria-label="Delete Ada"[\s\S]*Ask first\./);
		assert.doesNotMatch(card, /tutor-unavailable/);
		assert.match(renderToStaticMarkup(<TutorCard persona={tutor({ usable: false, promptOverlay: "" })} onEdit={noop} onDelete={noop} />), /acp-claude · sonnet[\s\S]*data-testid="tutor-unavailable"[\s\S]*No teaching instructions of its own\./);
		const fixed = renderToStaticMarkup(<TutorCard persona={builtIn} onEdit={noop} onDelete={noop} />);
		assert.match(fixed, /Default tutor[\s\S]*The model chosen in Settings[\s\S]*Change its model in Settings\./);
		assert.doesNotMatch(fixed, /tutor-edit|tutor-delete/);
	});

	it("the form groups models by provider and keeps a model the catalog lacks today", () => {
		const models = [{ provider: "acp-claude", id: "sonnet", name: "Sonnet 5.5" }, { provider: "acp-codex", id: "gpt-6.1-sol", name: "gpt-6.1-sol" }, { provider: "acp-claude", id: "opus", name: "Opus 5.5" }];
		assert.deepEqual(modelGroups(models), [{ provider: "acp-claude", models: [{ id: "sonnet", name: "Sonnet 5.5" }, { id: "opus", name: "Opus 5.5" }] }, { provider: "acp-codex", models: [{ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }] }]);
		const form = renderToStaticMarkup(<TutorForm draft={{ id: "persona_ada", name: "Ada", provider: "acp-claude", model: "sonnet", promptOverlay: "Ask first." }} models={models} error="Nope." busy={false} onChange={noop} onSave={noop} onCancel={noop} />);
		assert.match(form, /data-testid="tutor-name"[^>]*value="Ada"/);
		assert.match(form, /<optgroup label="acp-claude"><option value="acp-claude\nsonnet" selected="">Sonnet 5\.5 · sonnet<\/option><option value="acp-claude\nopus">Opus 5\.5 · opus<\/option><\/optgroup><optgroup label="acp-codex"><option value="acp-codex\ngpt-6\.1-sol">gpt-6\.1-sol<\/option>/);
		assert.match(form, /data-testid="tutor-error" role="alert"[^>]*>Nope\.</);
		assert.match(form, /10 \/ 4,000[\s\S]*data-testid="tutor-save"[^>]*>Save</);
		const gone = renderToStaticMarkup(<TutorForm draft={{ id: "persona_x", name: "X", provider: "acp-codex", model: "retired", promptOverlay: "" }} models={models} error={null} busy={false} onChange={noop} onSave={noop} onCancel={noop} />);
		assert.match(gone, /<option value="acp-codex\nretired" selected="">acp-codex · retired \(unavailable now\)<\/option>/);
		const fresh = renderToStaticMarkup(<TutorForm draft={{ name: "", provider: "", model: "", promptOverlay: "" }} models={undefined} error={null} busy={false} onChange={noop} onSave={noop} onCancel={noop} />);
		assert.match(fresh, /Loading models…[\s\S]*data-testid="tutor-save" disabled=""[^>]*>Add tutor</);
	});

	it("the session menu marks who is teaching and offers the course's tutor back only after an own choice", () => {
		const personas = [builtIn, tutor(), tutor({ id: "persona_bo", name: "Bo", usable: false })];
		const own = renderToStaticMarkup(<TutorMenuBody current={{ persona: tutor(), source: "session" }} personas={personas} onPick={noop} />);
		assert.match(own, /data-tutor="default"[\s\S]*aria-checked="true"[^>]*data-testid="tutor-option" data-tutor="persona_ada"[\s\S]*teaching[\s\S]*data-tutor="persona_bo"[\s\S]*unavailable[\s\S]*data-testid="tutor-follow-course"[\s\S]*href="\/tutors"/);
		const followed = renderToStaticMarkup(<TutorMenuBody current={{ persona: tutor(), source: "course" }} personas={personas} onPick={noop} />);
		assert.doesNotMatch(followed, /tutor-follow-course/);
	});
});

# Fork ledger

This repository is a hard fork of [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness). New features go in new files. Upstream files are edited only at narrow points, and every such edit is recorded here so a conflicting upstream change is easy to spot.

## Base

| | |
| --- | --- |
| Upstream commit | `da08cb5` (8 November 2026, v0.5.0) |
| Last synced | 9 November 2026 |

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Mirrors upstream's `main`. No fork work is committed or merged here. |
| `buildout` | The fork's trunk. Every phase merges here by pull request. |
| `phase/<n>-<name>` | One branch per build phase, cut from `buildout`. |

Pull requests must target `buildout`. GitHub defaults the base to `main`, so set it explicitly.

## Taking upstream fixes

The `upstream` remote is fetch-only. Run the cherry-pick on `buildout` or a branch cut from it.

```sh
git remote add upstream https://github.com/amosblomqvist/learnharness.git
git remote set-url --push upstream DISABLED
git fetch upstream
git cherry-pick <commit>
```

After a cherry-pick, check the picked commit against the table below. If it touches a listed file, re-apply the fork's edit by hand and rerun `npm run typecheck`, `npm test` and `npm run lint`. Then update the base commit above if the fork has caught up to a new upstream point.

## Edits to upstream files

Add one row per edit, in the same pull request that makes it.

| Upstream file | Change | For | Phase |
| --- | --- | --- | --- |
| `config.ts` | `PATHS.courses`, `PATHS.materials`, `PATHS.canvases` and `EVIDENCE_FILE`. | Courses, materials, evidence, canvas | 1, 3a, 3b, 5a |
| `package.json`, `package-lock.json` | Dependency `@excalidraw/excalidraw`; `predev` and `prebuild` run `scripts/copy-excalidraw-assets.mjs`. | Canvas | 5a |
| `package.json`, `package-lock.json` | Dependency `three` and dev dependency `@types/three`. | 3D grapher | 5c |
| `package.json`, `package-lock.json`, `.gitignore` | Dependency `mathlive`; `public/mathlive/` (its copied fonts) ignored. | Maths editor | 5c3 |
| `.gitignore` | Ignores `public/excalidraw/` (the copied fonts). | Canvas | 5a |
| `config.ts` | `ACP_MODELS_FILE`. | ACP agents | 6a |
| `config.ts` | `PERSONAS_FILE`. | Tutors | 6b |
| `src/core/ports.ts` | `PersonaStore`. | Tutors | 6b |
| `src/core/contracts.ts`, `src/core/index.ts` | Re-export `contracts/persona.ts` and `persona.ts`. | Tutors | 6b |
| `src/core/events.ts` | `personas-changed` in `ServerEvents` and `SERVER_EVENT_TYPES`. | Tutors | 6b |
| `src/server/stores.ts`, `src/server/index.ts` | Wire `personaStore`; re-export `personas.ts`. | Tutors | 6b |
| `src/server/chat-handler.ts` | `personaTurn` supplies the session's model in place of `record.settings` at both places it is resolved (the turn, and the settle-time compaction kick), refuses the turn by name when the tutor's model is unusable, and adds the tutor's segment to `extraSegments`. | Tutors | 6b |
| `components/chat.tsx` | `TutorChip` in the session header. | Tutors | 6b |
| `src/agent/models.ts` | Imports `syncAcpProviders` and calls it in `piModels()`, which registers the two ACP providers and keeps their model lists current. | ACP agents | 6a |
| `src/server/model-catalog.ts` | ACP providers: listed in `catalogProviders()` (usable or not), refused by `connectionModel` when unusable, unpriced and without context limits in `toModelDto` and `catalogContextLimits`. | ACP agents | 6a |
| `src/server/keys.ts` | `providerKeyPresent` answers for ACP providers from `acpAvailable`. | ACP agents | 6a |
| `src/server/pricing.ts` | `catalogModel` returns nothing for an ACP model, so no dollar estimate is made. | ACP agents | 6a |
| `tests/pricing-native-parity.test.ts` | The every-model pricing check expects no price for `acp-*` providers, as it does for `claude-code`. | ACP agents | 6a |
| `src/agent/tools/send-to-user.ts` | `sendToUserApplies` also holds for the `acp-claude` provider (its model ids do not contain "claude"). | ACP agents | 6a |
| `src/core/index.ts` | Re-exports `contracts/acp.ts`. | ACP agents | 6a |
| `components/settings/model-menu.tsx` | An ACP model's price reads "Plan billing". | ACP agents | 6a |
| `src/core/contracts.ts` | Re-exports `contracts/course.ts`, `contracts/material.ts` and `contracts/evidence.ts`. | Courses, materials, evidence | 1, 3a, 3b |
| `src/core/ports.ts` | `CourseStore`, `MaterialStore`, `EvidenceStore` and `CanvasStore` interfaces and their record imports. | Courses, materials, evidence, canvas | 1, 3a, 3b, 5a |
| `src/core/events.ts` | `courses-changed`, `materials-changed` and `evidence-changed` in `ServerEvents` and `SERVER_EVENT_TYPES`. | Courses, materials, evidence | 1, 3a, 3b |
| `src/server/stores.ts` | Wires `courseStore`, `materialStore`, `evidenceStore` and `canvasStore` into `stores`. | Courses, materials, evidence, canvas | 1, 3a, 3b, 5a |
| `src/server/index.ts` | Re-exports `courses.ts`, `attachments.ts`, `materials.ts` and `evidence.ts`. | Courses, photo answers, materials, evidence | 1, 2, 3a, 3b |
| `src/core/index.ts` | Re-exports `attachments.ts`, `material.ts` and `evidence.ts`. | Photo answers, materials, evidence | 2, 3a, 3b |
| `components/graph-canvas.ts` | `CanvasNode.tint`; tinted nodes are built into one cached path per colour and filled after the default nodes. | Evidence states | 3b |
| `components/graph-view.tsx` | Imports `idea-evidence`; calls `useEvidenceView`; passes `tint` per node and re-feeds the canvas when evidence changes; renders `IdeaEvidence` in the detail card. | Evidence states | 3b |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.extraSegments`, appended in order after the composed prompt in `baseAgentOptions`. | Course context, photo rule | 1, 2 |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.imageSnapshots`, passed to `toLlmMessages` in `convertToLlm`. | Photo answers | 2 |
| `src/server/chat-handler.ts` | Passes `extraSegments` (course context, photo rule) and `imageSnapshots` in `agentOpts`. | Course context, photo answers | 1, 2 |
| `src/server/chat-handler.ts` | Calls `assertAttachmentsUploaded` before `inputAppends`. | Photo answers | 2 |
| `src/server/chat-handler.ts` | `imageSnapshots` is passed through `answerImagePool`, which joins canvas outlines onto the session's images. | Canvas | 5a |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.extraTools`, healed and appended to the teacher's registry in `createTeacherAgent` (ignored when `tools` is given). | Tutor material tools | 3c |
| `src/server/chat-handler.ts` | Imports `material-tools.ts`; passes `extraTools: materialToolsFor(chatId)` in `agentOpts`. | Tutor material tools | 3c |
| `components/artifacts/index.ts` | Registers `ToolCallCard` for `ingest_material`, `material_status`, `read_material` and `mark_unit_covered`; registers `GraphCard` for `graph`. | Tutor tools, grapher | 3c, 4a, 4c, 5b |
| `components/artifacts/tool-call-card.tsx` | `headlineArg` shows `ingest_material`'s first path and how many more, and `read_material`'s book and section. | Tutor material tools | 3c, 4a |
| `next.config.ts` | `proxyClientMaxBodySize` raised to the book cap (200 MiB plus headroom); imports `MAX_BOOK_BYTES`. | Books | 4a |
| `app/api/chats/route.ts` | `POST` accepts `courseId`: 404 before the create when unknown, then adds the new session to the course. With `unitId` the session is scoped to that syllabus unit. | Courses, unit sessions | 1, 4c |
| `components/start-session.ts` | `SessionCreation.courseId` and `unitId`; the interface is exported. | Courses, unit sessions | 1, 4c |
| `components/new-session.tsx` | `courseId` parameter on `startDraftSession` and prop on `NewSession`. | Courses | 1 |
| `app/chat/new/page.tsx` | Reads `?course=<id>` and passes it to `NewSession`. | Courses | 1 |
| `components/sidebar.tsx` | Imports and renders `CoursesSection` above the session search row. | Courses | 1 |
| `src/agent/tools/learner-image.ts` | `snapshotImageBytes` split out of `loadLearnerImage`, so uploaded bytes get the same processing as a file path. | Photo answers | 2 |
| `src/core/question-core.ts` | `attachments` on `QuestionAnswerData` and `AnswerRequest`; `buildAnswer` copies it; `compactAnswerForModel` adds a `photos` count. | Photo answers | 2 |
| `src/core/input-events.ts` | `attachments` on the `thinking` event (text may then be empty); answers' lists validated; `assertAttachmentsUploaded`. | Photo answers | 2 |
| `src/core/native-messages.ts` | `newThinkingMessage` takes attachments; `toLlmMessages` takes an image pool and appends image blocks to markers and tool results. | Photo answers | 2 |
| `components/session-core.ts` | The optimistic thinking marker carries the event's attachments. | Photo answers | 2 |
| `components/question-dock.tsx` | `chatId` prop; attach button, tray and paste on written (text-mode) answers. | Photo answers | 2 |
| `components/practice-dock.tsx` | `chatId` prop; attach button, tray and paste; `onSubmit` also passes attachment ids. | Photo answers | 2 |
| `components/chat.tsx` | `DockOverlay` reads the chat id from context and passes it to both docks; `submitThinking` forwards attachment ids. | Photo answers | 2 |
| `components/answered-card.tsx`, `components/practice-cards.tsx` | Render `AttachmentThumbs`; a photo-only thinking card drops its empty text block. | Photo answers | 2 |

## Known gaps

- The compaction threshold estimates the system prompt from `composeInstructions` alone (`src/server/chat-handler.ts`), so it does not count the course-context segment or the photo rule. Together they are at most a few hundred tokens.
- Answer photos are resolved from the image pool as it stood when the turn started.
- Dropping a file on a dock keeps upstream's behavior (it inserts the file's path); photos are attached with the button or by pasting.
- HEIC photos are converted with macOS `sips`; on other systems the upload is refused with a message.
- Materials carry no slide or page anchors into the graph: a material is one notes source, as upstream imports are.
- Upstream's graph read model (`src/core/graph.ts`) and `/api/graph` are not edited for evidence. The fork's `/api/graph/evidence` is joined to the snapshot in the view.
- Practice evidence is folded from the saved session record on `turn-settled` (a bus subscription in `src/server/evidence.ts`), not recorded by the practice tools. Only problems that named `target` ideas count; "moved on" and dismissed problems record nothing.
- A test's results are dated by its upload time. A question that matches no idea is kept on the test as unplaced; there is no manual placement yet.
- Evidence pointing at an idea upstream has since deleted is ignored on read and left in the ledger.
- In-lesson quiz answers are not recorded as evidence yet, and idea states do not yet steer probing or practice.
- Deleting a material removes its stored file and record only. Ideas it added stay in the graph; upstream's source deletion removes those.
- Material conversion runs in the server process. A restart mid-run leaves the record `processing` with no worker; it reads as interrupted and Retry starts over from the stored original.
- The library (`/library`) lists every material; a material uploaded there belongs to no course and cannot yet be attached to one. Its sidebar link lives in the fork's own `components/courses-section.tsx`, so `components/sidebar.tsx` gains no further edit.
- A folder upload makes one material per file. A marked test photographed as several images must go through "Upload marked test" so its pages stay together. The checklist's pre-selection reads the file name only; the server still checks the bytes.
- Two library uploads with the same folder path and file name share one graph source (the source id is a hash of the path), as a re-import does upstream.
- At most two materials convert or extract at once; the rest wait as `queued`. The queue lives in the server process, so a restart leaves waiting materials interrupted; "Retry all failed" restarts them.
- Word (.docx) reading takes body paragraphs, headings and tables. Headers, footers, footnotes, comments and text boxes are not read; pictures are transcribed after the text, not at their place in it.
- The tutor's material tools (`ingest_material`, `material_status`) exist in teaching sessions only, are not in `TOGGLEABLE_TOOLS` (no Settings switch) and are not described in the prompt fragments; their descriptions carry the rules. The tutor is not woken when a material finishes.
- The compaction threshold estimate does not count the two material tools' schemas.
- A book is stored and sectioned, never extracted. Its scanned pages are read by the vision model the first time their section is read, with no review step; the tutor is told the text is AI-read. A read waits up to 20 s (tools time out at 30 s) and otherwise reports which pages are still being read.
- A book belongs to no course until the syllabus (phase 4b) attaches it, including one the tutor adds from a course session.
- Sections are two levels deep and read-only. EPUB sections follow chapter files: several contents entries into one file collapse into the first. EPUB pictures are dropped; DRM-protected EPUBs are refused.
- A PDF with no bookmarks is sectioned by the cheap model from each page's opening lines, then by equal 20-page runs if that fails. A mostly scanned PDF with no bookmarks goes straight to equal runs.
- The folder checklist's book pre-selection reads a PDF's page count from its bytes, which works only when the page tree is uncompressed. The server-side pause for notes PDFs over 80 pages covers the rest.
- Before 4a the proxy body limit was 26 MiB, so a marked test over that size was refused despite its 50 MB limit.
- A course lists library books in `bookIds`; a book carries no course. A book deleted from the library leaves a stale id that reads as absent.
- The syllabus is built only on request, by one strong-slot call that sees the books' contents lists (chapters only past 250 sections), never their text. A build runs in the server process; a restart mid-build leaves the syllabus as it was.
- A rebuild replaces every unit that is not covered, including skipped ones and hand edits. Units cannot be added by hand, and a unit's sections and prerequisites cannot be edited; reordering does not check prerequisites.
- A unit session is one teaching session started from a unit (`unitIds` holds one id). Its first message is sent for the learner ("Start the unit: <title>"). The tutor is told that unit, not the whole syllabus. Practice sessions are not scoped to units.
- "Covered" is the tutor's `mark_unit_covered` call or the learner's toggle; nothing infers it from the transcript. Deleting a unit's session leaves the unit in progress.
- Quiz evidence counts teach-phase multiple-choice answers only: not predictions, free-recall answers (no stored verdict) or the opening probe. An answer is recorded only once it matches an idea the session has put in the graph; until then it is retried after later turns. The match is one cheap-model call per settled turn that has something new to match, and is skipped (and retried) when no background model is set.
- Idea states still do not steer probing or practice targets; the unit block only lists the course's recently missed or shaky ideas.
- A canvas drawing is an ordinary answer attachment (its PNG in the session image pool) plus a scene and an outline in `canvases/<chatId>/`, keyed by the PNG's snapshot id. Deleting a session leaves that folder on disk.
- The docks gained no edit for the canvas: the Draw button is rendered by the fork's `AttachPhotoButton`. The editor is loaded lazily and is not covered by the node tests; it was smoke-tested in headless Chrome.
- The canvas claims every keydown at the document while open, so app shortcuts do not fire under it. Its fonts are copied to `public/excalidraw/fonts` before dev and build; the CJK face (Xiaolai) is left out. Excalidraw's own "Library" button still fetches from the web.
- The tutor cannot ask for a drawing through the question tools (no answer-form hint); it asks in prose.
- The grapher (`src/core/plot`, `components/plot`) is the fork's own code with no dependency: one expression parser shared by the tutor's `graph` tool, the learner's grapher and the outline sent back. 2D: functions of x or y, implicit, parametric and polar curves, points, definitions and sliders. 3D (phase 5c): surfaces giving one coordinate from the other two, implicit surfaces, space curves, parametric surfaces and points. Not yet: inequalities, function definitions (`f(x) = …`), tables, regressions, derivative notation, lists, vectors and matrices (the parser accepts matrix literals and says they arrive later).
- Each grapher line is a MathLive maths field (`components/plot/math-line.tsx`, phase 5c3), loaded lazily, with its fonts copied to `public/mathlive/fonts` before dev and build. Plain text stays the truth: `PlotLine.text` is what is parsed, saved and sent to the tutor; `PlotLine.latex` only keeps the field showing what was typed, and `core/plot/latex.ts` converts both ways. Only the LaTeX the editor produces is understood. Until the editor loads, in server rendering and in the node tests, a line is a plain text box.
- Calculus is numeric: `int` by adaptive Simpson (finite limits only), `deriv` and `f'` by a Richardson-extrapolated central difference (about 8 digits; less for second derivatives), `sum` and `prod` over whole numbers up to 10,000 terms. There are no symbolic antiderivatives, differential equations or slope fields. A curve containing an integral is sampled at 160 points.
- A sum's or product's body is the product that follows it (up to the next + or −); an integral's runs to its differential. When the editor closes a bracket around the differential (∫ sin(x² dx)), the conversion puts the bracket back in front of it.
- Functions are single letters (`f(x) = …`, `g(x, y) = …`), not x, y, z, t, r, u, v or e. A one-variable function is drawn on a 2D graph and a two-variable one on a 3D graph. Primes need a one-variable function.
- The scientific keypad (`components/plot/keypad.tsx`, phases 5c2–5d; its fifth tab holds vector and matrix keys, with grids up to 4 × 4) has no input logic of its own: in the maths editor a key inserts a structure, in a plain text box text. Its shown/hidden state is kept in local storage. It has no statistics keys: the grapher has no lists.
- A line with no variables is a calculation: it shows its value and draws nothing (before 5c2 a bare `5` drew the line y = 5; write `y = 5`). Degrees is a property of the whole graph (`angles: "degrees"`): trig functions take degrees, inverse trig returns them, and default parameter ranges become 0 to 360.
- `x!` is the gamma function between whole numbers; `nCr`, `nPr`, `gcd` and `lcm` are undefined off the whole numbers. `log(x, b)` is log base b; `root(x, n)` is the nth root. Greek letters are variables, except π and θ.
- Linear algebra (phase 5d-1, `src/core/plot/linalg.ts`): `v = (2, 1)` names a vector, drawn as an arrow from the origin (an unnamed tuple stays a point); `A = [[1, 2], [3, 4]]` names a matrix. A line built from them is evaluated to a number, a vector or a matrix by a second evaluator over the same expression tree; the number compiler is untouched and hands such expressions over. A vector result is drawn, a number or matrix is shown as its value, and `span(…)` draws a line or (in 3D) a plane. Arrows start at the origin only; a sum also shows its second vector dashed from the first one's tip. An equation between vectors (`A v = b`) draws nothing; write `solve(A, b)`.
- The visual tools (phase 5d-2) are lines as well. `transform(A)` draws the grid, the unit square (the unit cube in 3D, with no grid) and the basis arrows where the matrix sends them, and carries the named vectors and the points along, leaving a faint copy behind; curves and unnamed results stay put. Its before/after slider is kept on the line (`PlotLine.at`, absent meaning "after"), so it travels with a graph sent to the tutor; the in-between is the straight blend (1 − t)·I + t·A, so a rotation shrinks on the way. With several transform lines, the vectors follow the first one showing. The tutor cannot set the slider.
- `eigen(A)` handles 2 × 2 and 3 × 3 matrices by solving the characteristic quadratic or cubic directly; real eigenvalues only. A repeated eigenvalue is known to about half the digits, so its eigenvectors are found with a loose tolerance (1e-6). Eigenvectors are scaled so their largest entry is 1.
- Where the graph's straight lines meet (planes in 3D) is worked out for the whole graph (`ResolvedPlot.meet`): each unhidden equation is tested for straightness by sampling and becomes one row of a system. One common point is marked; two or more planes sharing a line have it drawn; anything else marks nothing and is reported to the tutor as "do not meet at one point". Crossings with curves are not found, and three lines forming a triangle have no marked points. `solve(A, b)` gives the unique solution as a vector, or says there is none or infinitely many.
- `×` is the cross product between vectors and plain multiplication between numbers; `·` and `*` between vectors are the dot product. `A^T` is the transpose unless the graph defines `T`. `[1, 2]` and a one-column matrix are read as vectors, so a 1 × n row matrix cannot be written. A vector's transpose is itself. A capital `E` is a name, not the constant e. Determinants and inverses use Gauss–Jordan elimination with partial pivoting; a pivot below 1e-12 of the largest entry counts as zero.
- Only a named vector written as plain numbers can be dragged, and only on a 2D graph; the drag rewrites the numbers in its line, rounded to about four pixels' worth. In 3D `u` and `v` may name vectors; while a parametric surface is sampled its own u and v take over.
- Definitions now settle in rounds, so one may use another written below it (before 5d-1 `b = a + 1` above `a = 2` was an error). The outline sent to the tutor gives the value of every worked-out definition, vector and matrix.
- 3D is drawn by three.js (`components/plot/plot-3d.tsx`, loaded lazily); the sampling in `core/plot/sample3.ts` is the fork's. Surfaces use a 64 × 64 grid; implicit surfaces use marching tetrahedra on a 36-cell grid, so they are slightly faceted and thin features can be missed. Pan is disabled in 3D; the box cannot be edited from the grapher's UI yet (the tutor sets it; the learner's is −5 to 5). The camera angle is in the exported picture, not in the outline.
- A graph inside the lesson (the tutor's card) zooms with a pinch or its buttons, never the plain scroll wheel, so it does not trap the lesson's scrolling. A 3D card has no zoom buttons.
- A graph sent as an answer is stored like a canvas drawing (`canvases/<chatId>/<snapshotId>.plot.json` plus its outline). The session image pool now carries each drawing's or graph's finished text block.
- The tutor's `graph` tool is teacher-only and always on. A tutor graph's card state (panning, slider drags) is the learner's exploration and is not saved; "Open in grapher" edits a copy that is sent nowhere.
- The tutor cannot choose a curve's colour; lines take the palette in order, so a tutor's "the grey curve" may not match.
- The `/grapher` scratchpad keeps one graph in the browser's local storage, outside any session.
- Drawing on the canvas element is not covered by the node tests; the grapher was smoke-tested in headless Chrome (every curve kind, pan, zoom, sliders, persistence, and the answer flow).
- A build can sweep the checkout's `.git` folder into `.next/standalone` (it did in 5b, and codesign failed on its read-only files). `scripts/install-local-app.sh` removes `.git` and `.github` from the standalone before packaging. Upstream pins `outputFileTracingExcludes` exactly in `tests/provider-tracing.test.ts`, so the exclusion is not made in `next.config.ts`.
- Vision transcription usage is not written to any usage log (upstream's notes pipeline logs its own extraction usage on the source record).

- ACP agents (phase 6a, `src/agent/acp/`, described in `docs/acp-agents.md`): Claude and Codex as two more model providers, each on its own subscription sign-in, started as child processes and given only LearnHarness's tool bridge. They are used as models (LearnHarness keeps its loop), on the pattern of upstream's Claude Code provider, three of whose modules they import unedited (`live-processes.ts`, `reuse-context.ts`, `transcript.ts`). The doc's stdio shim was not needed: both adapters accept the loopback HTTP bridge.
- Codex's isolation is softer than Claude's: its file-edit tool cannot be switched off, so it rests on read-only mode and the app refusing permission. Codex also keeps its own base instructions under the tutor's prompt. Each agent read one test image correctly through the provider; a full photo-answer lesson has not been run on either.
- There is no setting to switch an ACP agent off and no status display beyond the Tutors page's "unavailable now" mark. Background roles can be pointed at an ACP model in Settings like any other; nothing does so by default. Token counts come from the agent's own report and include its cached prompt; the context meter shows no limit for these models.
- Tutors (phase 6b; "persona" in the architecture doc and in the code): a name, a model pin and an overlay, kept with each session's own choice in `personas.json`; a course's tutor is `CourseRecord.personaId`. Chosen fresh each turn: the session's choice, then its course's tutor, then the default tutor, which is not a record but the Settings strong slot with no overlay. A tutor resolves to upstream's per-session model setting (`ChatSettings.model`, whose own UI upstream retired) plus one prompt segment, so nothing below the turn handler knows tutors exist. A session's own `settings.model` on an old record is overridden while a tutor applies.
- A tutor's name is put in its prompt (the learner may address it by name); the default tutor adds nothing. A tutor has no thinking level of its own: the session's, else the Settings one. Tutors affect teaching and practice turns and that session's own compaction; background roles are untouched. A new session cannot pick its tutor before its first message: it starts on its course's tutor or the default, and the header chip changes it from the next message. Switching leaves no note in the transcript.
- The default tutor's "usable" flag only says a strong model is set and its provider is present. Deleting a session leaves its entry in `personas.json` until the next time any session's tutor is chosen.
- The adapters are pinned in `acp-agents/package.json` and installed at build time with lifecycle scripts off; they are not in the app's own dependency tree, so `npm ci` and the test suite never fetch them. A checkout needs `npm ci` in `acp-agents/` (or `LH_ACP_AGENTS_DIR`) before `next dev` can use them.

## Local app

`scripts/install-local-app.sh` builds the fork as a macOS app and installs it at `/Applications/LearnHarness.app`. It layers `electron-builder.local.yml` over upstream's `electron-builder.yml`, which stays unedited.

- The build is ad-hoc signed and not notarized, so it runs only on the machine that built it.
- It carries no update feed. Upstream's feed would replace the fork with upstream's app. The in-app update check logs an error and does nothing.
- It shares upstream's app name and data folder (`~/Library/Application Support/LearnHarness`). Do not install upstream's app beside it.
- Run the script from a checkout outside iCloud Drive, and from a shell where `ELECTRON_RUN_AS_NODE` is unset when launching the app by hand (editor terminals set it, and the app then exits at once).

## Workflows

- `ci.yml` is unchanged. It runs on every pull request, whatever the base branch, which covers each phase's pull request into `buildout`. It does not run on direct pushes to `buildout`.
- `release.yml` is unchanged. It runs on `v*` tags and signs with upstream's credentials, so do not push version tags from the fork.
- `notify-website.yml` is unchanged. It only runs when the repository is `amosblomqvist/learnharness`.

## Known local test failures

Two tests in `tests/model-catalog.test.ts` fail on a machine with the Claude CLI in `/opt/homebrew/bin` or `/usr/local/bin`. They simulate a missing CLI by sandboxing `PATH` and `HOME`, but `src/agent/claude-code/binary.ts` also searches those two fixed directories. The failures are present at the base commit and are not caused by the fork.

- `catalogProviders() marks claude-code absent and modelCatalog() hides it when the CLI is missing`
- `providerKeyPresent("claude-code") requires both explicit opt-in and executable presence`

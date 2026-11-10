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
| `config.ts` | `PATHS.courses` and `PATHS.materials`. | Courses, materials | 1, 3a |
| `src/core/contracts.ts` | Re-exports `contracts/course.ts` and `contracts/material.ts`. | Courses, materials | 1, 3a |
| `src/core/ports.ts` | `CourseStore` and `MaterialStore` interfaces and their record imports. | Courses, materials | 1, 3a |
| `src/core/events.ts` | `courses-changed` and `materials-changed` in `ServerEvents` and `SERVER_EVENT_TYPES`. | Courses, materials | 1, 3a |
| `src/server/stores.ts` | Wires `courseStore` and `materialStore` into `stores`. | Courses, materials | 1, 3a |
| `src/server/index.ts` | Re-exports `courses.ts`, `attachments.ts` and `materials.ts`. | Courses, photo answers, materials | 1, 2, 3a |
| `src/core/index.ts` | Re-exports `attachments.ts` and `material.ts`. | Photo answers, materials | 2, 3a |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.extraSegments`, appended in order after the composed prompt in `baseAgentOptions`. | Course context, photo rule | 1, 2 |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.imageSnapshots`, passed to `toLlmMessages` in `convertToLlm`. | Photo answers | 2 |
| `src/server/chat-handler.ts` | Passes `extraSegments` (course context, photo rule) and `imageSnapshots` in `agentOpts`. | Course context, photo answers | 1, 2 |
| `src/server/chat-handler.ts` | Calls `assertAttachmentsUploaded` before `inputAppends`. | Photo answers | 2 |
| `app/api/chats/route.ts` | `POST` accepts `courseId`: 404 before the create when unknown, then adds the new session to the course. | Courses | 1 |
| `components/start-session.ts` | `SessionCreation.courseId`. | Courses | 1 |
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
- Materials carry no slide or page anchors into the graph yet: a material is one notes source, as upstream imports are. Anchors come with the evidence work (phase 3b).
- Deleting a material removes its stored file and record only. Ideas it added stay in the graph; upstream's source deletion removes those.
- Material conversion runs in the server process. A restart mid-run leaves the record `processing` with no worker; it reads as interrupted and Retry starts over from the stored original.
- Vision transcription usage is not written to any usage log (upstream's notes pipeline logs its own extraction usage on the source record).

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

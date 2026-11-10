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
| `config.ts` | `PATHS.courses`. | Courses | 1 |
| `src/core/contracts.ts` | Re-exports `contracts/course.ts`. | Courses | 1 |
| `src/core/ports.ts` | `CourseStore` interface and its `CourseRecord` import. | Courses | 1 |
| `src/core/events.ts` | `courses-changed` in `ServerEvents` and `SERVER_EVENT_TYPES`. | Courses | 1 |
| `src/server/stores.ts` | Wires `courseStore` into `stores`. | Courses | 1 |
| `src/server/index.ts` | Re-exports `courses.ts`. | Courses | 1 |
| `src/agent/teacher-agent.ts` | `AgentBuildOptions.courseContext`, appended after the composed prompt in `baseAgentOptions`. | Course context | 1 |
| `src/server/chat-handler.ts` | Imports `courseContextFor` and passes `courseContext` in `agentOpts`. | Course context | 1 |
| `app/api/chats/route.ts` | `POST` accepts `courseId`: 404 before the create when unknown, then adds the new session to the course. | Courses | 1 |
| `components/start-session.ts` | `SessionCreation.courseId`. | Courses | 1 |
| `components/new-session.tsx` | `courseId` parameter on `startDraftSession` and prop on `NewSession`. | Courses | 1 |
| `app/chat/new/page.tsx` | Reads `?course=<id>` and passes it to `NewSession`. | Courses | 1 |
| `components/sidebar.tsx` | Imports and renders `CoursesSection` above the session search row. | Courses | 1 |

## Known gaps

- The compaction threshold estimates the system prompt from `composeInstructions` alone (`src/server/chat-handler.ts`), so it does not count the course-context segment. The segment is at most a few hundred tokens.

## Workflows

- `ci.yml` is unchanged. It runs on every pull request, whatever the base branch, which covers each phase's pull request into `buildout`. It does not run on direct pushes to `buildout`.
- `release.yml` is unchanged. It runs on `v*` tags and signs with upstream's credentials, so do not push version tags from the fork.
- `notify-website.yml` is unchanged. It only runs when the repository is `amosblomqvist/learnharness`.

## Known local test failures

Two tests in `tests/model-catalog.test.ts` fail on a machine with the Claude CLI in `/opt/homebrew/bin` or `/usr/local/bin`. They simulate a missing CLI by sandboxing `PATH` and `HOME`, but `src/agent/claude-code/binary.ts` also searches those two fixed directories. The failures are present at the base commit and are not caused by the fork.

- `catalogProviders() marks claude-code absent and modelCatalog() hides it when the CLI is missing`
- `providerKeyPresent("claude-code") requires both explicit opt-in and executable presence`

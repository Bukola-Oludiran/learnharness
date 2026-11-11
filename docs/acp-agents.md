# ACP agents (fork)

LearnHarness can teach through an agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com/): **Claude** (`@agentclientprotocol/claude-agent-acp`) and **Codex** (`@agentclientprotocol/codex-acp`). Each uses its own subscription sign-in; LearnHarness holds no key for either and cannot see what a turn costs. They appear in the model menus as `acp-claude` and `acp-codex`, beside the existing providers. Upstream's Claude Code CLI provider is unchanged and remains the default.

## How a turn runs

The agent is used as a model, not as the one in charge: LearnHarness keeps its own agent loop, tools, questions and saved history (the same arrangement as upstream's [Claude Code provider](claude-code.md)).

1. The adapter is started as a child process in an empty temporary folder. LearnHarness declares no file or terminal capability.
2. `session/new` hands it one MCP server, LearnHarness's tool bridge (loopback HTTP behind a random bearer token), and the tutor's prompt.
3. `session/prompt` sends the saved transcript as labelled text and images. The transcript, not an agent session, is the source of truth, which is why a session can change agents between turns.
4. The agent's text and thinking stream out as one assistant message. When it calls a LearnHarness tool, the call waits at the bridge; the message ends with that tool call, the app runs the tool, and the result is handed to the same waiting agent. A question to the learner holds the agent open until they answer.
5. A permission request is allowed only for a bridge tool. Anything else is refused.

A waiting agent is kept for 10 minutes (upstream's limit for its CLI provider, shared here). After that, the result starts a fresh agent and the transcript is replayed.

Codex is told of the bridge through its own `config.toml`, not on `session/new`. Only there can the bridge's tool time limit be raised: by default Codex gives up on a tool call after five minutes (measured 2026-11-11: a call held 630 s failed at 300 s; with `tool_timeout_sec` set, one held 400 s completed). The bridge's token reaches Codex in an environment variable, not in the file. If an agent does give up on a call the app already holds, that agent is stopped and the result starts a fresh one.

## Isolation

Established by a spike on 2026-11-10 (claude-agent-acp 0.106.0, codex-acp 2.6.0). Both adapters load the user's personal tools and settings unless told not to.

| | Claude | Codex |
| --- | --- | --- |
| Own tools | Removed outright (`tools: []`). Asked, with the tutor rule taken away, to run a shell command, write a file and fetch a page, it reported having only the bridge tools. | Shell, web, plugins, apps, browser, computer use and image tools switched off by feature flags. A file-edit tool has no switch. |
| User's setup | `settingSources: []`: no settings, hooks, output style or MCP servers. | A private `CODEX_HOME` for each run holding a link to the sign-in file and LearnHarness's own `config.toml`; nothing else of the user's. |
| Writes | None possible. | Read-only session mode: an edit asks permission and is refused. Before that mode was set, and with the rule removed, it wrote a file into its empty temporary folder. |
| Tutor's prompt | Replaces the agent's own. | Appended to the agent's own, after a rule that names the bridge tools as the only ones to use. |

These are integration boundaries, not an operating-system sandbox. Codex's isolation in particular rests on its feature flags, its read-only mode and the app refusing permission; a Codex release that changes any of them changes this.

## Delivery

The adapters are not imported; they are installed beside the packaged server by `scripts/build-acp-payload.mjs` from the pinned list in `acp-agents/`. Claude's bundled CLI is removed from the payload: the Claude agent runs the Claude Code already installed (`CLAUDE_CODE_EXECUTABLE`). Codex's CLI ships in the payload.

In a checkout, `npm ci` inside `acp-agents/` makes them available to `next dev`; `LH_ACP_AGENTS_DIR` points somewhere else. An agent is listed as usable when its adapter is installed and, for Claude, a `claude` binary is found; for Codex, `auth.json` exists in the Codex home.

## Models

Which models exist depends on the account. Each session start reports them; the list is remembered in `acp-models.json` in the data folder and shown in the model menus. Until an agent has reported, a short built-in list stands in. A model the account does not offer fails the turn with a message naming it.

## Maintainer entry points

`src/agent/acp/`: `wire.ts` (JSON-RPC over stdio, protocol v1), `stream.ts` (the turn), `tool-bridge.ts`, `agents.ts` (what each agent needs), `model-list.ts`, `provider.ts`. `tests/acp-provider.test.ts` drives a scripted agent over real pipes and HTTP; it does not exercise the real adapters.

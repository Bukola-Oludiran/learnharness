/**
 * build-acp-payload.mjs — install the ACP adapters beside the packaged
 * server (fork, phase 6a — see FORK.md).
 *
 * The app starts each adapter as a child process and never imports it, so
 * Next's trace does not carry them: they are installed here, from the
 * pinned list in acp-agents/, into .next/standalone/acp-agents/, which
 * ships with the server (src/agent/acp/agents.ts looks there).
 *
 * Claude's own bundled CLI (about 350 MB) is removed: the Claude agent
 * runs the Claude Code already installed on the machine. Codex's CLI
 * stays; nothing else provides one.
 *
 * Run after scripts/build-server.mjs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "acp-agents");
const TARGET = path.join(ROOT, ".next", "standalone", "acp-agents");

if (!fs.existsSync(path.join(ROOT, ".next", "standalone", "server.js"))) {
	console.error("[build-acp-payload] .next/standalone/server.js missing — run the server build first.");
	process.exit(1);
}

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(SOURCE, file), path.join(TARGET, file));
// Exactly the locked versions; no lifecycle scripts from third-party packages.
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: TARGET, stdio: "inherit" });

const modules = path.join(TARGET, "node_modules");
for (const name of fs.readdirSync(path.join(modules, "@anthropic-ai"))) {
	// claude-agent-sdk-darwin-arm64 and its siblings: the bundled CLI, one package per platform.
	if (/^claude-agent-sdk-/.test(name)) {
		fs.rmSync(path.join(modules, "@anthropic-ai", name), { recursive: true, force: true });
		console.log(`[build-acp-payload] left out Claude's bundled CLI: ${name}`);
	}
}

for (const pkg of ["claude-agent-acp", "codex-acp"]) {
	if (!fs.existsSync(path.join(modules, "@agentclientprotocol", pkg, "dist", "index.js"))) {
		console.error(`[build-acp-payload] ${pkg} did not install: its entry script is missing.`);
		process.exit(1);
	}
}
const codexPlatform = fs.readdirSync(path.join(modules, "@openai")).filter((name) => /^codex-/.test(name));
if (codexPlatform.length === 0) {
	console.error("[build-acp-payload] Codex's CLI for this platform did not install.");
	process.exit(1);
}

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).reduce((total, entry) => (entry.isFile() ? total + fs.statSync(path.join(entry.parentPath, entry.name)).size : total), 0);
console.log(`[build-acp-payload] installed claude-agent-acp, codex-acp (${codexPlatform.join(", ")}): ${Math.round(size(TARGET) / 1024 / 1024)} MB`);

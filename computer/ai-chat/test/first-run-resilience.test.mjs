// First-run resilience pins (pre-launch UX audit, 2026-07-09):
//   1. EVERY adapter attaches a process "error" handler — codex/opencode had
//      none, so a missing binary was an UNCAUGHT EventEmitter error that
//      crashed the whole ai-chat server.
//   2. A spawn failure ENDS the turn (error + turn_done) — claude/gemini
//      emitted the error but left the UI in "Working…" forever (no `close`
//      event fires after a failed spawn).
//   3. ENOENT renders as plain English with an install hint, not a raw errno.
//   4. /api/box exposes enabled modules; the empty state never promises a
//      browser/apps capability the install doesn't have.
//   5. The cockpit page title is ShellTeam, not a single agent's name.
//
// Run: node --test 'computer/ai-chat/test/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CodingAgent } from "../lib/coding-agent.mjs";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const ADAPTERS = [
  "../lib/claude-cli-agent.mjs",
  "../lib/codex-agent.mjs",
  "../lib/gemini-cli-agent.mjs",
  "../lib/opencode-agent.mjs",
  "../lib/antigravity-agent.mjs",
];

test("every adapter attaches a process error handler after spawn", () => {
  for (const rel of ADAPTERS) {
    const src = read(rel);
    assert.match(src, /_process\.on\(\s*"error"/,
      `${rel} must handle spawn errors — an unhandled one crashes the server`);
  }
});

test("spawn failures end the turn instead of hanging in Working…", () => {
  // claude/codex/gemini/opencode route through the base _failTurn; antigravity
  // has its own equivalent (_finishError) and only borrows the message helper.
  for (const rel of ADAPTERS.filter(r => !r.includes("antigravity"))) {
    assert.match(read(rel), /_failTurn\(this\._processErrorMessage\(/,
      `${rel} must fail the turn via the shared base helpers`);
  }
  assert.match(read("../lib/antigravity-agent.mjs"),
    /_finishError\(this\._processErrorMessage\(/,
    "antigravity must humanize spawn errors via the shared message helper");
});

test("_failTurn emits error AND turn_done — even before the CLI ever streamed", () => {
  // The regression that bit: adapters set _isGenerating only once the CLI
  // starts streaming, which a failed spawn never reaches. The client is
  // waiting regardless — turn_done must fire unconditionally.
  const agent = new CodingAgent({ model: "m", cwd: process.cwd() });
  agent._isActive = true;
  agent._isGenerating = false; // spawn died before any stream event
  const events = [];
  agent.on("error", (d) => events.push(["error", d.message]));
  agent.on("turn_done", (d) => events.push(["turn_done", d.is_error]));
  agent._failTurn("boom");
  assert.deepEqual(events, [["error", "boom"], ["turn_done", true]]);
  assert.equal(agent.isGenerating, false, "turn must be over");
  // Inactive agents stay silent (stopped slots must not broadcast).
  agent._isActive = false;
  agent._failTurn("late");
  assert.equal(events.length, 2);
});

test("ENOENT becomes plain English with an install hint, not a raw errno", () => {
  const agent = new CodingAgent({ model: "m", cwd: process.cwd() });
  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const msg = agent._processErrorMessage("Claude Code", enoent, "npm install -g @anthropic-ai/claude-code");
  assert.match(msg, /isn't installed on this box/);
  assert.match(msg, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(msg, /switch to another agent/);
  assert.doesNotMatch(msg, /ENOENT/, "no raw errno in user-facing copy");
  // Non-ENOENT errors keep the real message.
  const other = new Error("EACCES: permission denied");
  assert.match(agent._processErrorMessage("Codex", other, null), /EACCES/);
});

test("/api/box exposes enabled modules and the empty state consumes them", () => {
  const serverSrc = read("../server.mjs");
  assert.match(serverSrc, /\/api\/box[\s\S]{0,400}modules: enabledModules\(\)/,
    "/api/box must report the enabled modules");
  const appSrc = read("../public/app.js");
  assert.match(appSrc, /BOX\.modules/,
    "empty-state copy must be driven by BOX.modules");
  assert.match(appSrc, /mods\.includes\('composio'\)/,
    "the apps chip/copy must be gated on the composio module");
  assert.match(appSrc, /mods\.includes\('browser'\)/,
    "the browser mention must be gated on the browser module");
  // The static fallback must be core-safe (no browser/apps promise).
  const html = read("../public/index.html");
  const subtitle = html.match(/id="emptySubtitle"[^>]*>\s*([^<]+)</)[1];
  assert.doesNotMatch(subtitle, /browser|apps/i,
    "static empty-state fallback must not promise module capabilities");
});

test("the cockpit page title is ShellTeam", () => {
  assert.match(read("../public/index.html"), /<title>ShellTeam<\/title>/);
});

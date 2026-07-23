/**
 * SHE-82 / critical follow-up: session search must find sessions by CONTENT and
 * by FOLDER across ALL sessions on disk — not just the newest 50 the browser
 * holds. Before the fix, search was a client-side filter over 50 loaded records'
 * title/model/project, so a term buried in an old ~/sidecar conversation ("supabase")
 * or the folder itself was unfindable once 50 newer sessions pushed it off the list.
 *
 * We drive lib/history.mjs against a throwaway $HOME. constants.mjs reads HOME at
 * module-eval, so HOME is set before the dynamic import below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "she82-"));
process.env.HOME = HOME;
delete process.env.SHELLTEAM_WORKSPACE_LOCK;

// Claude encodes a session's cwd into its project directory name as the abs path
// with slashes replaced by dashes (see cwdFromSessionPath in history.mjs).
function encodeCwd(absPath) {
  return absPath.replace(/\//g, "-");
}

function writeClaudeSession(cwd, sid, userText, mtimeMs) {
  // The real workspace folder must exist — cwdFromSessionPath decodes the
  // dash-encoded project dir by probing the filesystem for the actual path.
  mkdirSync(cwd, { recursive: true });
  const dir = join(HOME, ".claude", "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: userText } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: "ok" } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  // Force a deterministic mtime so the 50-cap ordering is controllable.
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const { listSessions, searchSessions } = await import("../lib/history.mjs");

test("SHE-82: content deep in a session is found even past the 50-session list cap", async () => {
  // 60 recent webapp sessions (newer) bury one old ~/sidecar session that alone
  // mentions Supabase — exactly the reported shape (webapp 49, ~ 1, sidecar 0).
  const base = 1_700_000_000_000;
  for (let i = 0; i < 60; i++) {
    writeClaudeSession(join(HOME, "webapp"), `webapp-${i}`, `webapp task ${i}`, base + i * 1000);
  }
  // The old one, older than all 60 so it is NOT in the newest-50 listing.
  writeClaudeSession(join(HOME, "sidecar"), "sidecar-old", "help me wire up Supabase auth for the app", base - 999_000);

  // Sanity: the plain listing is capped and does NOT include the old sidecar session.
  const listed = listSessions();
  assert.equal(listed.length, 50, "listing is capped at 50");
  assert.ok(!listed.some((s) => s.sessionId === "sidecar-old"), "old sidecar session is off the listed page");

  // The bug: searching "supabase" must still surface it (content match).
  const byContent = await searchSessions("supabase");
  assert.ok(
    byContent.some((s) => s.sessionId === "sidecar-old"),
    "content search finds the buried Supabase conversation",
  );
});

test("SHE-82: a session is findable by the FOLDER it ran in, not just its text", async () => {
  // Searching the workspace name must surface its sessions even when the term
  // appears nowhere in the transcript body.
  const byFolder = await searchSessions("sidecar");
  assert.ok(
    byFolder.some((s) => s.sessionId === "sidecar-old"),
    "folder/path search finds the ~/sidecar session",
  );
  assert.ok(byFolder.every((s) => (s.project || "").includes("sidecar")), "folder matches are scoped to that folder");
});

test("SHE-82: an empty query returns nothing (no accidental full dump)", async () => {
  assert.deepEqual(await searchSessions(""), []);
  assert.deepEqual(await searchSessions("   "), []);
});

test("SHE-82: the cockpit wires the search box to the server, not just a local filter", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  // The input delegates to the debounced handler (not an inline local filter).
  assert.ok(app.includes("oninput=\"onSessionSearchInput(this.value)\""), "search box calls onSessionSearchInput");
  // Which asks the server to search every session on disk.
  assert.ok(/type:\s*'search_sessions'/.test(app), "sends a search_sessions request");
  // And the server's answer is routed back into the browser.
  assert.ok(app.includes("case 'sessions_search_result'"), "handles the search result message");
  assert.ok(app.includes("handleSessionSearchResult"), "search-result handler is wired");
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));

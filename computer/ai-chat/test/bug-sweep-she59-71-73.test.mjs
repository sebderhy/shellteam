import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionForReplay } from "../lib/history.mjs";
import { ClaudeCliAgent } from "../lib/claude-cli-agent.mjs";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// ---------------------------------------------------------------------------
// SHE-73: resuming a compacted session must replay the WHOLE transcript with a
// marker at each compaction point — not just the post-compact tail (which for
// a compact-then-close session rendered as a lone "context compacted" line).
// ---------------------------------------------------------------------------

function claudeLine(type, content, extra = {}) {
  if (type === "user") {
    return JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
  }
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: content }] },
    ...extra,
  });
}

function writeSession(lines) {
  const dir = mkdtempSync(join(tmpdir(), "she73-"));
  const file = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return { dir, file };
}

test("SHE-73: replay keeps pre-compact messages, marker inline at the compact point", () => {
  const { dir, file } = writeSession([
    claudeLine("user", "first question"),
    claudeLine("assistant", "first answer"),
    claudeLine("user", "compact summary text", { isCompactSummary: true }),
    claudeLine("user", "post-compact question"),
    claudeLine("assistant", "post-compact answer"),
  ]);
  try {
    const msgs = readSessionForReplay(file);
    const texts = msgs.filter(m => m.type === "user_message").map(m => m.content);
    assert.deepEqual(texts, ["first question", "post-compact question"],
      "pre-compact user messages must survive replay");
    const markerIdx = msgs.findIndex(m => m.type === "session_event" && m.event === "compacted");
    assert.ok(markerIdx > 0, "compact marker must sit where the compaction happened, not at index 0");
    assert.equal(msgs[markerIdx - 1].type, "text_done", "marker follows the pre-compact content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHE-73: session that was compacted right before closing still shows its history", () => {
  const { dir, file } = writeSession([
    claudeLine("user", "the original ask"),
    claudeLine("assistant", "lots of work"),
    claudeLine("user", "compact summary text", { isCompactSummary: true }),
  ]);
  try {
    const msgs = readSessionForReplay(file);
    assert.equal(msgs[0].type, "user_message");
    assert.equal(msgs[0].content, "the original ask");
    assert.ok(msgs.some(m => m.type === "session_event" && m.event === "compacted"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHE-73: very long transcripts are capped head+tail with a visible truncation marker", () => {
  const lines = [claudeLine("user", "the original ask")];
  for (let i = 0; i < 1200; i++) lines.push(claudeLine("assistant", `chunk ${i}`));
  const { dir, file } = writeSession(lines);
  try {
    const msgs = readSessionForReplay(file);
    assert.ok(msgs.length <= 501, `capped replay must stay bounded, got ${msgs.length}`);
    assert.equal(msgs[0].content, "the original ask", "the opening (title source) survives the cap");
    const marker = msgs.find(m => m.type === "session_event" && m.event === "truncated");
    assert.ok(marker && marker.count > 0, "elided middle must be visibly marked");
    assert.equal(msgs[msgs.length - 1].text, "chunk 1199", "the newest tail survives the cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SHE-59: the idle reaper must NOT kill a CLI process that still hosts live
// background subagents — that tore down whole review fleets every 10 minutes.
// ---------------------------------------------------------------------------

function agentWithFakeProcess() {
  const agent = new ClaudeCliAgent({ model: "claude-test", cwd: tmpdir(), env: process.env });
  const killed = [];
  agent._process = { pid: 1, stdin: { end() {} }, kill(sig) { killed.push(sig); } };
  agent._isGenerating = false;
  return { agent, killed };
}

test("SHE-59: idle reaper defers while background subagents are tracked", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._subagents.set("toolu_bg1", { steps: 3 });
  agent._lastEventAt = Date.now() - 15 * 60 * 1000; // quiet past the idle window
  agent._reapIfIdle();
  assert.deepEqual(killed, [], "must not SIGTERM a process with live subagents");
  assert.ok(agent._idleTimer, "must re-arm the idle timer instead");
  agent._clearIdleTimer();
});

test("SHE-59: idle reaper defers while stdout events are still flowing", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._lastEventAt = Date.now() - 1000; // a subagent line arrived a second ago
  agent._reapIfIdle();
  assert.deepEqual(killed, [], "recent stdout activity means the process is not idle");
  agent._clearIdleTimer();
});

test("SHE-59: idle reaper still kills a genuinely quiet process with no subagents", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._lastEventAt = Date.now() - 15 * 60 * 1000;
  agent._reapIfIdle();
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("SHE-59: a leaked subagent entry cannot pin the process forever (stale cap)", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._subagents.set("toolu_leaked", { steps: 1 });
  agent._lastEventAt = Date.now() - 2 * 60 * 60 * 1000; // zero events for 2h
  agent._reapIfIdle();
  assert.deepEqual(killed, ["SIGTERM"], "an hour of total silence reaps regardless of the tracker");
});

// ---------------------------------------------------------------------------
// SHE-71: the session-picker search input must be rendered ONCE (in
// renderSessionPicker) — rebuilding it on every keystroke inside
// renderSessionBrowser destroyed focus and caret mid-typing.
// ---------------------------------------------------------------------------

test("SHE-71: search input lives in the static header, not the re-rendered results", () => {
  const appJs = readFileSync(join(PUBLIC, "app.js"), "utf8");

  const pickerBody = appJs.split("function renderSessionPicker(")[1].split("\nfunction ")[0];
  const browserBody = appJs.split("function renderSessionBrowser(")[1].split("\nfunction ")[0];

  assert.ok(pickerBody.includes("session-search"),
    "renderSessionPicker must build the search input (once per open)");
  assert.ok(!browserBody.includes('<input type="search"'),
    "renderSessionBrowser must NOT rebuild the search input on each keystroke");
  assert.ok(browserBody.includes("session-results"),
    "renderSessionBrowser must render into the results container only");
});

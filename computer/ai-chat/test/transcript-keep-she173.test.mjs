// Regression tests for SHE-173 (and SHE-151): "my MusicJev tab is now empty.
// I can assure you we had a long conversation there."
//
// Cause: Claude Code deletes a transcript idle for 30 days every time a
// `claude` starts. The tab still pointed at the deleted file, showed nothing,
// and its next message silently started a new conversation.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-she173-"));
const { TABS_FILE, CLAUDE_TRANSCRIPT_KEEP_DIR } = await import("../lib/constants.mjs");
const { CLAUDE_PROJECTS_DIR } = await import("../lib/history.mjs");
const { keepClaudeTranscript, syncKeptTranscripts } = await import("../lib/transcript-keep.mjs");

const PROJECT = "-home-seb";
const line = (text) => JSON.stringify({
  type: "user", uuid: `u-${text}`, sessionId: "x", cwd: process.env.HOME,
  message: { role: "user", content: text },
}) + "\n";

function writeTranscript(id, text) {
  const file = join(CLAUDE_PROJECTS_DIR, PROJECT, `${id}.jsonl`);
  mkdirSync(join(CLAUDE_PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(file, line(text));
  return file;
}

test("a transcript Claude Code deleted is put back, with what was appended since", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const file = writeTranscript(id, "first");
  assert.equal(keepClaudeTranscript(id), "kept");
  appendFileSync(file, line("second"));   // Claude keeps appending to the same file
  unlinkSync(file);                        // the 30-day cleanup

  assert.equal(keepClaudeTranscript(id), "restored");
  const text = readFileSync(file, "utf8");
  assert.match(text, /first/);
  assert.match(text, /second/);
});

test("keeping twice is a no-op and costs no disk (same file, two names)", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const file = writeTranscript(id, "hello");
  keepClaudeTranscript(id);
  assert.equal(keepClaudeTranscript(id), null);
  const kept = join(CLAUDE_TRANSCRIPT_KEEP_DIR, PROJECT, `${id}.jsonl`);
  assert.equal(statSync(kept).ino, statSync(file).ino);
});

test("closing a tab releases its link; open tabs keep theirs", () => {
  const open = "33333333-3333-4333-8333-333333333333";
  const closed = "44444444-4444-4444-8444-444444444444";
  writeTranscript(open, "open");
  writeTranscript(closed, "closed");
  syncKeptTranscripts([open, closed]);
  syncKeptTranscripts([open, null]);
  assert.ok(existsSync(join(CLAUDE_TRANSCRIPT_KEEP_DIR, PROJECT, `${open}.jsonl`)));
  assert.ok(!existsSync(join(CLAUDE_TRANSCRIPT_KEEP_DIR, PROJECT, `${closed}.jsonl`)));
});

test("a tab whose transcript was deleted while the cockpit was down reopens with its conversation", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const file = writeTranscript(id, "a long conversation");
  keepClaudeTranscript(id);
  unlinkSync(file);
  writeFileSync(TABS_FILE, JSON.stringify([
    { id: 7, sessionId: id, sessionFamily: "claude", title: "MusicJev", model: "claude-opus-5-5", cwd: process.env.HOME },
  ]));

  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}`);
  sm.setBroadcast(() => {});
  sm.restoreSlots();

  assert.ok(existsSync(file), "transcript restored on disk");
  const slot = sm.listSlots().find((s) => s.id === 7);
  assert.equal(slot.sessionId, id);
  assert.ok(JSON.stringify(sm.getHistory(7)).includes("a long conversation"));
});

test("a tab whose transcript was lost for good says so instead of showing nothing", async () => {
  writeFileSync(TABS_FILE, JSON.stringify([
    { id: 8, sessionId: "77777777-7777-4777-8777-777777777777", sessionFamily: "claude", title: "Finance", model: "claude-opus-5-5", cwd: process.env.HOME },
  ]));
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-lost`);
  sm.setBroadcast(() => {});
  sm.restoreSlots();
  assert.equal(sm.getHistory(8)[0].event, "transcript_lost");
});

test("an unreadable tab list releases nothing", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const file = writeTranscript(id, "precious");
  keepClaudeTranscript(id);
  unlinkSync(file);
  writeFileSync(TABS_FILE, "{not json");

  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-corrupt`);
  sm.setBroadcast(() => {});
  sm.restoreSlots();
  sm.startTranscriptKeeper();
  assert.ok(existsSync(join(CLAUDE_TRANSCRIPT_KEEP_DIR, PROJECT, `${id}.jsonl`)));
});

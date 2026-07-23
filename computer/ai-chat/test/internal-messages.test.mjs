// SHE-65: injected turns (task notifications, command stdout, delegated tasks)
// flow through the user-message path but must never render as the user's own
// bubble. Pins the shared classifier, the tagging at addUserMessage, the
// replay-time re-derivation for pre-fix history, and that internal turns
// never title a tab.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect HOME before importing — constants.mjs resolves paths at import time.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-internal-"));

const { isInternalUserContent, readSessionForReplay } = await import("../lib/history.mjs");
const sm = await import("../lib/session-manager.mjs");
const { CODEX_HISTORY_DIR, HOME } = await import("../lib/constants.mjs");

const TASK_NOTIF = "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>";

test("classifier: injected envelopes yes, real messages no", () => {
  assert.equal(isInternalUserContent(TASK_NOTIF), true);
  assert.equal(isInternalUserContent("<local-command-stdout>ok</local-command-stdout>"), true);
  assert.equal(isInternalUserContent("<command-name>/compact</command-name>"), true);
  assert.equal(isInternalUserContent("  <system-reminder>x</system-reminder>"), true);
  assert.equal(isInternalUserContent("Fix the auth bug please"), false);
  // XML-ish content the user could legitimately type stays a user message.
  assert.equal(isInternalUserContent("<div>my html question</div>"), false);
  assert.equal(isInternalUserContent(null), false);
});

test("addUserMessage tags envelopes automatically and honors the explicit flag", () => {
  sm.createSlot(300, { cwd: HOME });
  sm.addUserMessage(300, TASK_NOTIF);                      // auto-detected
  sm.addUserMessage(300, "real question", );               // untouched
  sm.addUserMessage(300, "delegated task text", { internal: true }); // explicit
  const h = sm.getHistory(300);
  assert.equal(h[0].internal, true);
  assert.equal(h[1].internal, undefined);
  assert.equal(h[2].internal, true);
});

test("internal turns never become the tab title", () => {
  sm.createSlot(301, { cwd: HOME });
  sm.addUserMessage(301, TASK_NOTIF);
  assert.equal(sm.listSlots().find(s => s.id === 301).label, null);
  sm.addUserMessage(301, "Ship the release");
  assert.equal(sm.listSlots().find(s => s.id === 301).label, "Ship the release");
});

test("cockpit-history replay re-derives internal for pre-fix entries", () => {
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
  const file = join(CODEX_HISTORY_DIR, "legacy-thread.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "user_message", content: TASK_NOTIF }),          // pre-fix: no flag
    JSON.stringify({ type: "user_message", content: "typed by the human" }),
    JSON.stringify({ type: "text_done", text: "assistant reply" }),
  ].join("\n") + "\n");
  const replay = readSessionForReplay(file);
  assert.equal(replay[0].internal, true);
  assert.equal(replay[1].internal, undefined);
  assert.equal(replay[2].internal, undefined);
});

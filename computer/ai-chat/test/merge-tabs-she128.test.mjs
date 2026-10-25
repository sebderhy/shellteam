/**
 * SHE-128 — merge one tab into another. Seb often forks or opens tabs that end
 * up as two workers on the same project, in the same folder, that never talk.
 * Merging B into A hands A's agent B's whole conversation (a readable
 * transcript any agent family can open) with a notice to take it over; B
 * closes; A shows a marker. Mock agents only: no CLI, no cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-merge-"));
const sm = await import("../lib/session-manager.mjs");
const { CODEX_HISTORY_DIR, HOME } = await import("../lib/constants.mjs");

const sent = [];   // [slotId, content] handed to an agent
sm._testSetAgentFactory(() => ({ on() {}, start() {}, stop() {}, interrupt() {}, sendMessage(c) { sent.push(c); } }));
const broadcasts = [];
sm.setBroadcast((m) => broadcasts.push(m));

let nextSlot = 300;
// A Codex tab with a real cockpit-owned history file, like the cockpit writes.
function codexTab(lines, title) {
  const id = nextSlot++;
  const sid = `codex-thread-${id}`;
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
  writeFileSync(join(CODEX_HISTORY_DIR, `${sid}.jsonl`), [
    { type: "session_meta", model: "gpt-6-luna", cwd: HOME, timestamp: Date.now() },
    ...lines,
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  sm.createSlot(id, { model: "gpt-6-luna", cwd: HOME });
  sm.setSessionId(id, sid);
  if (title) sm.renameSlot(id, title);
  return id;
}

const B_WORK = [
  { type: "user_message", content: "Fix the login redirect.", timestamp: Date.now() },
  { type: "text_done", text: "I'll check the auth middleware." },
  { type: "tool_start", id: "t1", name: "Bash" },
  { type: "tool_input", id: "t1", input: { command: "grep -rn redirect api/auth.py" } },
  { type: "tool_result", id: "t1", content: "api/auth.py:42: return redirect(next_url)" },
  { type: "text_done", text: "Fixed: next_url is now validated. PINEAPPLE-7" },
  { type: "turn_done" },
];

test("merging B into A: A's agent gets B's whole conversation and a notice, B closes, A shows a marker", async () => {
  const a = codexTab([{ type: "user_message", content: "Write the signup page." }, { type: "turn_done" }], "Signup");
  const b = codexTab(B_WORK, "Login fix");
  sent.length = 0; broadcasts.length = 0;

  const result = await sm.mergeSlot(b, a);

  assert.ok(!result.error, result.error);
  assert.equal(sm.hasSlot(b), false, "the merged tab is gone");
  assert.ok(existsSync(result.file));
  const transcript = readFileSync(result.file, "utf8");
  assert.match(transcript, /Fix the login redirect\./, "B's user messages");
  assert.match(transcript, /grep -rn redirect api\/auth\.py/, "B's tool calls with their inputs");
  assert.match(transcript, /api\/auth\.py:42/, "B's tool results");
  assert.match(transcript, /PINEAPPLE-7/, "B's answers");

  assert.equal(sent.length, 1, "A's agent was started on the notice");
  assert.match(sent[0], /^<cockpit-notice>/);
  assert.ok(sent[0].includes(result.file), "the notice points at the transcript");
  assert.match(sent[0], /"Login fix"/);

  const history = sm.getHistory(a);
  const notice = history.find((m) => m.type === "user_message" && m.content === sent[0]);
  assert.equal(notice?.internal, true, "the notice never renders as the user's own bubble");
  const marker = history.find((m) => m.type === "session_event" && m.event === "merged");
  assert.equal(marker?.fromTitle, "Login fix");
  assert.equal(marker?.fromFamily, "codex");
  assert.ok(broadcasts.some((m) => m.type === "session_event" && m.event === "merged" && m.slot === a), "live marker for open clients");
});

test("refused while either tab is working, or with nothing to merge; both tabs untouched", async () => {
  const a = codexTab([], "A");
  const b = codexTab(B_WORK, "B");
  sm.startAgent(b);
  sm.sendMessage(b, "still going");   // B is mid-turn
  const busy = await sm.mergeSlot(b, a);
  assert.match(busy.error, /idle/);
  assert.ok(sm.hasSlot(b) && sm.hasSlot(a));

  const empty = nextSlot++;
  sm.createSlot(empty, { model: "gpt-6-luna", cwd: HOME });
  assert.match((await sm.mergeSlot(empty, a)).error, /Nothing to merge/);
  assert.match((await sm.mergeSlot(a, a)).error, /itself/);
  assert.ok(sm.hasSlot(empty));
});

test("an empty target tab takes the merged tab's title", async () => {
  const a = nextSlot++;
  sm.createSlot(a, { model: "claude-haiku-5-5", cwd: HOME });
  const b = codexTab(B_WORK);
  // An auto title comes from the first user message.
  sm.addUserMessage(b, "Fix the login redirect.");
  const result = await sm.mergeSlot(b, a);
  assert.ok(!result.error, result.error);
  assert.equal(sm.listSlots().find((s) => s.id === a).label, "Fix the login redirect.");
});

test("a merge drop is allowed by the drag (a dropEffect the drag doesn't allow cancels the drop)", () => {
  // First build: dragover set dropEffect 'link' while dragstart allowed only
  // 'move', so dropping on a tab's middle silently did nothing (seen in a real
  // browser, 2026-10-25).
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const allowed = src.match(/effectAllowed = '(\w+)'/)?.[1];
  const effects = [...src.matchAll(/dropEffect = merge \? '(\w+)' : '(\w+)'/g)].flatMap((m) => [m[1], m[2]]);
  assert.ok(effects.length, "the tab strip picks a dropEffect per zone");
  for (const effect of effects) {
    assert.ok(allowed.toLowerCase().includes(effect), `effectAllowed '${allowed}' must allow dropEffect '${effect}'`);
  }
});

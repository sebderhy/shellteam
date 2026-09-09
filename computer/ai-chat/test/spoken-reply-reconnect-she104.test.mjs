/**
 * SHE-104 — "I used the TTS button and it replied with text as if I hadn't".
 *
 * What happened (cockpit log, 2026-08-26): the phone sent a message with the
 * speaker on at 15:15:21, its socket dropped at 15:15:30 (screen off), the
 * reply finished at 15:15:40, and the reconnect replayed history — where the
 * turn_done handler skips speech on purpose (never read a whole transcript
 * aloud on reload). The owed audio was silently dropped.
 *
 * Fix: replayHistory speaks the ONE reply still owed — the last text of the
 * last turn, if that turn ended after the last real user message and this is
 * the slot the send came from — then clears the debt so nothing is read twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(join(root, "public/chat.js"), "utf8");
const app = readFileSync(join(root, "public/app.js"), "utf8");

// chat.js is a browser script: lift the pure helper from source so the test
// exercises the real code, not a copy.
function loadOwedSpokenReply() {
  const m = chat.match(/\nfunction owedSpokenReply\(messages\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, "owedSpokenReply missing from chat.js");
  return new Function(`${m[0]}; return owedSpokenReply;`)();
}
const owed = loadOwedSpokenReply();

const user = (content, extra = {}) => ({ type: "user_message", content, ...extra });
const text = (t) => ({ type: "text_done", text: t });
const done = () => ({ type: "turn_done" });

test("a reply that completed while the device was away is owed", () => {
  const history = [user("hi"), text("first answer"), done(), user("go on [Audio reply: …]"), text("narration"), text("the answer"), done()];
  assert.equal(owed(history), "the answer", "the LAST text of the turn is what gets spoken");
});

test("a turn still running owes nothing yet — its live turn_done will speak", () => {
  assert.equal(owed([user("hi"), text("partial…")]), null);
  assert.equal(owed([user("hi")]), null);
});

test("an older reply is never re-read for a newer send", () => {
  assert.equal(owed([user("a"), text("old"), done(), user("b")]), null);
});

test("injected internal turns after the send do not count as the user's message", () => {
  const history = [user("real"), user("[task notification]", { internal: true }), text("answer"), done()];
  assert.equal(owed(history), "answer");
});

test("a turn that ended with nothing to say owes nothing", () => {
  assert.equal(owed([user("a"), done()]), null);
  assert.equal(owed([user("a"), text("   "), done()]), null);
  assert.equal(owed([]), null);
});

test("replayHistory speaks the owed reply once, only for the slot that sent it", () => {
  assert.match(chat, /App\.state\.isReplayingHistory = false;\n\s*this\._speakOwedReply\(messages\);/,
    "replay must run the catch-up after the replay flag drops (speech is skipped while it is set)");
  const fn = chat.match(/_speakOwedReply\(messages\) \{([\s\S]*?)\n    \},/);
  assert.ok(fn, "_speakOwedReply missing");
  assert.match(fn[1], /this\.speakSlotId !== activeSlotId\) return/, "another slot's replay must not speak");
  assert.match(fn[1], /this\.speakNextReply = false/, "the debt is cleared so a second reconnect stays silent");
  assert.match(fn[1], /owedSpokenReply\(messages\)/);
});

test("the live turn_done path also settles the debt and is slot-scoped", () => {
  const td = chat.match(/_handleTurnDone\(msg\) \{([\s\S]*?)\n    \},/);
  assert.ok(td, "_handleTurnDone missing");
  assert.match(td[1], /this\.speakNextReply && this\.speakSlotId === activeSlotId && !App\.state\.isReplayingHistory/);
  assert.match(td[1], /if \(!interrupted\) this\.speakReply\(/);
  assert.match(td[1], /this\.speakNextReply = false/);
});

test("handleSend records which slot the spoken reply is owed to", () => {
  assert.match(app, /Chat\.speakNextReply = speakThisTurn;\n\s*Chat\.speakSlotId = activeSlotId;/);
});

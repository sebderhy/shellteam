/**
 * SHE-132: each user message shows when it was sent, under its bubble. Live
 * messages use the send time; replayed history uses the stored timestamp, and
 * an old entry without one shows no time rather than a wrong "now".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const chat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public/chat.js"), "utf8");
const fn = chat.match(/function userMessageTime\(timestamp, now = new Date\(\)\) \{[\s\S]*?\n\}/);
const userMessageTime = new Function(`${fn[0]}; return userMessageTime;`)();

test("today shows the time only; other days add the date; other years add the year", () => {
  const now = new Date(2026, 9, 31, 12, 0);
  const today = userMessageTime(new Date(2026, 9, 31, 9, 5).getTime(), now);
  const earlier = userMessageTime(new Date(2026, 9, 29, 9, 5).getTime(), now);
  const lastYear = userMessageTime(new Date(2025, 9, 29, 9, 5).getTime(), now);
  assert.match(today, /^\D*0?9\D05/);
  assert.doesNotMatch(today, /29|Oct/);
  assert.match(earlier, /29/);
  assert.doesNotMatch(earlier, /2026/);
  assert.match(lastYear, /2025/);
});

test("replayed history passes its stored timestamp, never the replay time", () => {
  assert.match(chat, /this\.addUserMessage\(msg\.content, null, msg\.timestamp \?\? null\)/);
  assert.match(chat, /if \(timestamp != null\) \{/);
});

test("the server stores a timestamp on every user message", () => {
  const sm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib/session-manager.mjs"), "utf8");
  assert.match(sm, /type: "user_message",\n\s+content,\n\s+timestamp: Date\.now\(\)/);
});

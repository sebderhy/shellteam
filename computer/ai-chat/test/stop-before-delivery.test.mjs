/**
 * A Stop that lands before the agent took the message must say so.
 *
 * 2026-10-22: Seb answered "Yes, please build it now" in a tab whose Claude
 * session was long enough that `claude --resume` took several seconds to load.
 * A Stop (Esc or the button) arrived 3 s after the send, while the CLI had
 * printed nothing yet: Claude exited without recording the message, the adapter
 * emitted no turn_done at all (it only counts a turn once output arrives), the
 * tab kept looking busy, and the agent never saw the answer. Hours later Seb had
 * to ask whether anyone was working.
 *
 * Now every adapter reports `undelivered` on the interrupted turn_done: true when
 * the CLI had not acknowledged the message (so the chat says it is NOT part of
 * the conversation and offers Send again), false when it had.
 *
 * Fake CLIs on PATH stand in for the real ones: a "loading" one prints nothing
 * until it is signalled, a "warm" one answers at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import vm from "node:vm";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-undelivered-"));
const { ClaudeCliAgent } = await import("../lib/claude-cli-agent.mjs");
const { CodexAgent } = await import("../lib/codex-agent.mjs");
const { HOME } = await import("../lib/constants.mjs");

function fakeBin(name, body) {
  const dir = mkdtempSync(join(tmpdir(), `st-fake-${name}-`));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}
// Still loading: silent until signalled, then exits 0 like the real CLI on SIGINT.
const LOADING = `trap 'exit 0' INT TERM\nsleep 30 & wait`;

function nextTurnDone(agent) {
  return new Promise((resolve) => agent.once("turn_done", resolve));
}

test("Claude: Stop while the session is still loading reports the message as undelivered", async () => {
  const agent = new ClaudeCliAgent({ sessionId: null, model: "x", cwd: HOME, env: fakeBin("claude", LOADING) });
  agent.start();
  agent.sendMessage("Yes, please build it now.");
  await sleep(150);
  const done = nextTurnDone(agent);
  agent.interrupt();
  const msg = await Promise.race([done, sleep(2000).then(() => "no turn_done")]);
  assert.notEqual(msg, "no turn_done", "a Stop during loading must end the turn, or the tab stays busy forever");
  assert.equal(msg.subtype, "interrupted");
  assert.equal(msg.undelivered, true);
  agent.stop();
});

test("Claude: Stop after the CLI started answering keeps the message as delivered", async () => {
  // Prints an assistant event right away, then idles like a mid-turn CLI.
  const warm = `trap 'exit 0' INT TERM
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"stream_event","event":{"type":"message_start","message":{}}}'
sleep 30 & wait`;
  const agent = new ClaudeCliAgent({ sessionId: null, model: "x", cwd: HOME, env: fakeBin("claude", warm) });
  agent.start();
  agent.sendMessage("hello");
  await sleep(300);
  const done = nextTurnDone(agent);
  agent.interrupt();
  const msg = await Promise.race([done, sleep(2000).then(() => "no turn_done")]);
  assert.notEqual(msg, "no turn_done");
  assert.equal(msg.undelivered, false);
  agent.stop();
});

test("Codex: Stop before the CLI printed anything reports the message as undelivered", async () => {
  const agent = new CodexAgent({ sessionId: null, model: "x", cwd: HOME, env: fakeBin("codex", LOADING) });
  agent.start();
  agent.sendMessage("hello");
  await sleep(150);
  const done = nextTurnDone(agent);
  agent.interrupt();
  const msg = await Promise.race([done, sleep(2000).then(() => "no turn_done")]);
  assert.notEqual(msg, "no turn_done");
  assert.equal(msg.undelivered, true);
  agent.stop();
});

test("the chat never claims an undelivered message was sent, and offers Send again", () => {
  const src = readFileSync(fileURLToPath(new URL("../public/chat.js", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /your message was sent/, "the old notice told Seb his lost message had been sent");
  const start = src.indexOf("    addInterruptedNotice(subtype, undelivered) {");
  const end = src.indexOf("\n    },", start);
  assert.ok(start > 0 && end > start, "addInterruptedNotice(subtype, undelivered) exists");
  const appended = [];
  const el = () => ({ classList: { add() {}, contains: () => false }, appendChild(c) { this.children.push(c); }, children: [] });
  const ctx = {
    document: { createElement: () => el() },
    App: { el: { messages: { lastElementChild: null, appendChild: (d) => appended.push(d) } } },
    scrollToBottom() {}, handleSend() { ctx.sent = true; },
  };
  vm.createContext(ctx);
  const Chat = vm.runInContext(`({ ${src.slice(start, end + 7)} _lastUserMessageText() { return "Yes, please build it now."; }, prefillComposer(t) { this.filled = t; } })`, ctx);
  Chat.addInterruptedNotice("interrupted", true);
  const [notice] = appended;
  const [content, button] = notice.children;
  assert.match(content.textContent, /before the agent received your message/);
  assert.equal(button.textContent, "Send again");
  button.onclick();
  assert.equal(Chat.filled, "Yes, please build it now.");
  assert.ok(ctx.sent, "Send again resends in one click");
  appended.length = 0;
  Chat.addInterruptedNotice("interrupted", false);
  assert.match(appended[0].children[0].textContent, /The agent has your message/);
});

test("the undelivered flag survives a reload (kept in the slot history)", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/session-manager.mjs", import.meta.url)), "utf8");
  assert.match(src, /undelivered: data\.undelivered/);
});

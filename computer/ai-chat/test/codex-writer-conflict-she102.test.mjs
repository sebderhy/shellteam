/**
 * SHE-102 — "thread … already has an active writer (code -32600)".
 *
 * Codex threads carry a writer lock. A resume spawned while the previous
 * process is still winding down (interrupt → immediate resend), or while any
 * other codex process sits on the thread (agent re-created on model switch,
 * a terminal run), dies with that raw protocol error — which the cockpit
 * painted straight into the chat.
 *
 * The fix is two layers: this instance's spawns queue behind its own dying
 * process, and a writer-conflict failure gets one delayed silent retry of the
 * user's message. Only a second conflict surfaces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAgent } from "../lib/codex-agent.mjs";

const WRITER_MSG =
  "thread/resume failed: thread 019fdc54-71f6-7ca3-9d8f-012fbf30817f already has an active writer (code -32600)";

function makeAgent({ realSpawn = false } = {}) {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent.start();
  agent._lastPrompt = "original message";
  if (!realSpawn) {
    // Never let a leftover retry timer spawn a real codex from the suite.
    agent.respawned = [];
    agent._spawnExec = (p) => agent.respawned.push(p);
  }
  return agent;
}

test("a writer-conflict turn.failed is retried silently, not surfaced", async () => {
  const agent = makeAgent();
  const done = [], errors = [];
  agent.on("turn_done", (d) => done.push(d));
  agent.on("error", (e) => errors.push(e));

  agent._translate({ type: "turn.failed", error: { message: WRITER_MSG } });

  assert.equal(done.length, 0, "no error turn_done while the retry is armed");
  assert.equal(errors.length, 0, "no toast for a recoverable conflict");
  assert.equal(agent._writerRetryPending, true);

  // The armed timer must respawn the user's message once the delay elapses.
  await sleep(1700);
  assert.deepEqual(agent.respawned, ["original message"]);
  assert.equal(agent._writerRetryPending, false);
});

test("a second conflict for the same message surfaces the error", () => {
  const agent = makeAgent();
  agent._writerRetryUsed = true;   // the one retry already spent
  const done = [];
  agent.on("turn_done", (d) => done.push(d));

  agent._translate({ type: "turn.failed", error: { message: WRITER_MSG } });

  assert.equal(done.length, 1);
  assert.equal(done[0].is_error, true);
  assert.match(done[0].errors[0], /active writer/);
});

test("a writer-conflict stream error event never reaches the UI", () => {
  const agent = makeAgent();
  const errors = [];
  agent.on("error", (e) => errors.push(e));

  agent._translate({ type: "error", message: WRITER_MSG });

  assert.equal(errors.length, 0, "raw protocol error must not be painted");
  assert.equal(agent._writerRetryPending, true);
  agent._writerRetryPending = false;   // disarm before the suite moves on
});

test("interrupt disarms a pending retry — Stop must stay stopped", async () => {
  const agent = makeAgent();
  agent._translate({ type: "turn.failed", error: { message: WRITER_MSG } });
  assert.equal(agent._writerRetryPending, true);

  agent.interrupt();
  await sleep(1700);
  assert.deepEqual(agent.respawned, [], "cancelled turn must not resurrect");
});

test("a spawn queues behind a winding-down process instead of racing its lock", () => {
  const agent = makeAgent({ realSpawn: true });  // the queue gate lives in the real _spawnExec
  agent._dying = { pid: 12345 };   // interrupted process not yet closed

  agent.sendMessage("follow-up");

  assert.equal(agent._pendingSpawn, "follow-up", "spawn must wait for the writer lock");
  assert.equal(agent._process, null, "no codex spawned while the lock is held");
  assert.equal(agent.isGenerating, true, "the queued turn still reads as underway");
});

test("interrupt and stop mark the outgoing process as dying and drop queued work", () => {
  const agent = makeAgent();
  const fake = { pid: 999, killed: true };
  agent._process = fake;
  agent._pendingSpawn = "stale";
  agent.interrupt();
  assert.equal(agent._dying, fake);
  assert.equal(agent._pendingSpawn, null);

  const agent2 = makeAgent();
  agent2._process = fake;
  agent2._pendingSpawn = "stale";
  agent2.stop();
  assert.equal(agent2._dying, fake);
  assert.equal(agent2._pendingSpawn, null);
});

test("the close handler runs the queued spawn once the dying process exits", () => {
  // The dying→queued-spawn handoff lives inside the real process close
  // handler, which a unit test can't fire without spawning codex — pin the
  // wiring at source level so a refactor can't drop it.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../lib/codex-agent.mjs"), "utf8");
  const wiring = src.match(/proc\.on\("close",[\s\S]*?\n    \}\);/);
  assert.ok(wiring, "close handler found");
  assert.match(wiring[0], /this\._handleClose\(proc, code, signal/, "close must delegate to _handleClose");
  const close = src.match(/\n  _handleClose\(proc, code, signal[\s\S]*?\n  \}\n/);
  assert.ok(close, "_handleClose found");
  assert.match(close[0], /this\._dying === proc/, "close must recognise the dying process");
  assert.match(close[0], /_pendingSpawn/, "close must run the queued spawn");
});

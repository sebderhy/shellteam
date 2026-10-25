/**
 * SHE-107 — sending to Codex while it is working: "Error: thread/resume failed:
 * thread … already has an active writer (code -32600)".
 *
 * `codex exec` is one turn per process and the thread carries a writer lock.
 * sendMessage() used to spawn a second resume straight away: it died on the
 * lock (the error painted into the chat), the one silent retry (SHE-102) hit
 * the same still-running holder, and the first process kept running as an
 * orphan the adapter no longer tracked. Claude Code queues a mid-turn message;
 * Codex now does the same — held until the running turn's process has exited,
 * then run as its own turn, in order. Since SHE-126 a running turn takes the
 * message directly (turn/steer); this queue is the path for every moment it
 * can't: before the turn started, during /compact or a recovery, or a steer
 * that lost the race with the turn's end.
 *
 * The integration test drives the REAL spawn/close/drain path with a fake
 * `codex` on PATH (no quota, no network); the unit tests pin the state rules.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { CodexAgent } from "../lib/codex-agent.mjs";
import { fakeCodex } from "./fixtures/fake-codex.mjs";

function makeAgent() {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent.start();
  agent.spawned = [];
  // The fake process is marked already-killed: _killTree signals the process
  // GROUP (kill(-pid)), and a made-up pid that ever reached it would signal
  // real processes — pid 1 did exactly that, kill(-1) took the whole user
  // session down three times on 2026-09-07 before the guard below existed.
  agent._spawnTurn = (p) => { agent.spawned.push(p); agent._isGenerating = true; agent._process = { pid: 999, killed: true }; };
  return agent;
}

test("a message sent mid-turn is queued, not spawned onto the locked thread", () => {
  const agent = makeAgent();
  agent.sendMessage("first");
  assert.deepEqual(agent.spawned, ["first"]);

  agent.sendMessage("second");
  agent.sendMessage("third");
  assert.deepEqual(agent.spawned, ["first"], "no second codex while the first still holds the writer lock");
  assert.deepEqual(agent._queued, ["second", "third"], "held in order");
  assert.equal(agent.isGenerating, true);
});

test("turn.completed seen but the process still alive: a send is still queued (the lock is held until exit)", () => {
  const agent = makeAgent();
  agent.sendMessage("first");
  agent._isGenerating = false;          // turn.completed arrived, close has not
  agent.sendMessage("second");
  assert.deepEqual(agent.spawned, ["first"]);
  assert.deepEqual(agent._queued, ["second"]);
  assert.equal(agent.isGenerating, true, "queued work keeps the slot working for the UI");
});

test("the queue drains one message per settled turn, and only once the thread is free", () => {
  const agent = makeAgent();
  agent.sendMessage("first");
  agent.sendMessage("second");
  agent.sendMessage("third");

  agent._drainQueue();
  assert.deepEqual(agent.spawned, ["first"], "still generating: nothing runs");

  // Turn ended (turn.completed) but the process has not exited yet — the lock
  // is still held, so the drain must wait for the close.
  agent._isGenerating = false;
  agent._drainQueue();
  assert.deepEqual(agent.spawned, ["first"], "process alive: lock still held");

  agent._process = null;
  agent._drainQueue();
  assert.deepEqual(agent.spawned, ["first", "second"]);
  assert.deepEqual(agent._queued, ["third"]);
  assert.equal(agent._lastPrompt, "second", "the queued message becomes the retryable prompt of its own turn");

  agent._isGenerating = false; agent._process = null;
  agent._drainQueue();
  assert.deepEqual(agent.spawned, ["first", "second", "third"]);
  assert.deepEqual(agent._queued, []);
});

test("a writer retry or a dying process keeps the queue parked", () => {
  const agent = makeAgent();
  agent.sendMessage("first");
  agent.sendMessage("second");
  agent._isGenerating = false; agent._process = null;

  agent._dying = { pid: 7 };
  agent._drainQueue();
  assert.deepEqual(agent.spawned, ["first"], "interrupted process still winding down");
  agent._dying = null;

  agent._isGenerating = true;   // an armed writer retry / recovery phase owns the turn
  agent._drainQueue();
  assert.deepEqual(agent.spawned, ["first"]);
});

test("Stop drops queued follow-ups — a cancelled turn must not resurrect them", () => {
  const agent = makeAgent();
  agent.sendMessage("first");
  agent.sendMessage("second");
  agent.interrupt();
  assert.deepEqual(agent._queued, []);
  agent._isGenerating = false; agent._process = null; agent._dying = null;
  agent._drainQueue();
  assert.deepEqual(agent.spawned, ["first"]);

  const agent2 = makeAgent();
  agent2.sendMessage("first");
  agent2.sendMessage("second");
  agent2.stop();
  assert.deepEqual(agent2._queued, []);
});

test("end-to-end with a fake codex: a message the running turn can't take runs after the first process exits, as a resume", async () => {
  // The running turn refuses the mid-turn message (turn/steer fails, e.g. it
  // was already finishing — SHE-126), so it falls back to the SHE-107 queue.
  const fake = fakeCodex({ TURN_MS: 400, REFUSE_STEER: 1, THREAD: "thread-she107" });
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: fake.dir, env: fake.env });
  agent.start();
  const dones = [];
  agent.on("turn_done", (d) => dones.push(d));
  const errors = [];
  agent.on("error", (e) => errors.push(e));

  try {
    agent.sendMessage("first");
    await once(agent, "text_done");                 // first process is live and streaming
    agent.sendMessage("second");                    // the SHE-107 moment

    const deadline = Date.now() + 8000;
    while (dones.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(dones.length, 2, `expected two settled turns, got ${dones.length} (errors: ${JSON.stringify(errors)})`);
    assert.ok(!dones.some((d) => d.is_error), `no turn may fail: ${JSON.stringify(dones)}`);
    assert.deepEqual(errors, [], "no error toast");

    const records = fake.records();
    assert.equal(records.filter((r) => r.argv).length, 2, "exactly two codex processes, never concurrent");
    const turns = records.filter((r) => r.method === "turn/start").map((r) => r.params.input[0].text);
    assert.deepEqual(turns, ["first", "second"]);
    const resumes = records.filter((r) => r.method === "thread/resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].params.threadId, "thread-she107", "the queued message resumes the same thread");
    assert.deepEqual(agent._queued, []);
  } finally {
    agent.stop();
    fake.cleanup();
  }
});

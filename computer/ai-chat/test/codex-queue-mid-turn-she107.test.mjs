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
 * then run as its own turn, in order.
 *
 * The integration test drives the REAL spawn/close/drain path with a fake
 * `codex` on PATH (no quota, no network); the unit tests pin the state rules.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { CodexAgent } from "../lib/codex-agent.mjs";

function makeAgent() {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent.start();
  agent.spawned = [];
  // The fake process is marked already-killed: _killTree signals the process
  // GROUP (kill(-pid)), and a made-up pid that ever reached it would signal
  // real processes — pid 1 did exactly that, kill(-1) took the whole user
  // session down three times on 2026-09-07 before the guard below existed.
  agent._spawnExec = (p) => { agent.spawned.push(p); agent._isGenerating = true; agent._process = { pid: 999, killed: true }; };
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

test("end-to-end with a fake codex: the second message runs after the first process exits, as a resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "she107-"));
  const log = join(dir, "calls.log");
  // Fake `codex exec`: records argv + the stdin prompt, streams a minimal
  // JSONL turn, lingers briefly (the window the bug lived in), then exits.
  writeFileSync(join(dir, "codex"), `#!/bin/sh
prompt=$(cat)
printf '%s\\t%s\\n' "$*" "$prompt" >> "${log}"
echo '{"type":"thread.started","thread_id":"thread-she107"}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"reply to '"$prompt"'"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
sleep 0.4
exit 0
`);
  chmodSync(join(dir, "codex"), 0o755);

  const agent = new CodexAgent({
    model: "gpt-5.6-sol", cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CODEX_HOME: join(dir, "codex-home") },
  });
  agent.start();
  const dones = [];
  agent.on("turn_done", (d) => dones.push(d));
  const errors = [];
  agent.on("error", (e) => errors.push(e));

  try {
    agent.sendMessage("first");
    await once(agent, "text_done");                 // first process is live and streaming
    agent.sendMessage("second");                    // the SHE-107 moment
    assert.deepEqual(agent._queued, ["second"]);

    const deadline = Date.now() + 8000;
    while (dones.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(dones.length, 2, `expected two settled turns, got ${dones.length} (errors: ${JSON.stringify(errors)})`);
    assert.ok(!dones.some((d) => d.is_error), `no turn may fail: ${JSON.stringify(dones)}`);
    assert.deepEqual(errors, [], "no error toast");

    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split("\t"));
    assert.equal(calls.length, 2, "exactly two codex processes, never concurrent");
    assert.equal(calls[0][1], "first");
    assert.equal(calls[1][1], "second");
    assert.match(calls[1][0], /^exec resume thread-she107 /, "the queued message resumes the same thread");
    assert.deepEqual(agent._queued, []);
  } finally {
    agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

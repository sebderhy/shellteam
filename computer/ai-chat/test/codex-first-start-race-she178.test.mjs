/**
 * SHE-178: three Codex chats started in the same second on a brand-new box;
 * one showed "failed to initialize sqlite state runtime" in red.
 *
 * Codex creates its state database on its first start, and processes started
 * together race on it: the losers exit with code 1 and that line on stderr
 * (reproduced with 6 parallel `codex app-server` on an empty CODEX_HOME, 5
 * failed; none failed once the database existed). The message is retried once,
 * silently, like a thread writer conflict.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { CodexAgent } from "../lib/codex-agent.mjs";

const RACE_STDERR =
  "Error: failed to initialize sqlite state runtime under /home/owner/.codex: failed to initialize state runtime at /home/owner/.codex";

function agentWhoseCodexJustExited() {
  const agent = new CodexAgent({ model: "gpt-6.1-sol", cwd: tmpdir(), env: {} });
  agent.start();
  agent._lastPrompt = "first message";
  agent.respawned = [];
  agent._spawnTurn = (p) => agent.respawned.push(p); // never spawn a real codex from the suite
  const proc = { pid: 4242, killed: true };
  agent._process = proc;
  agent._isGenerating = true;
  agent._startTime = Date.now();
  agent._recentStderr = RACE_STDERR;
  return { agent, proc };
}

test("a first-start race exit is retried once, silently", async () => {
  const { agent, proc } = agentWhoseCodexJustExited();
  const done = [], errors = [];
  agent.on("turn_done", (d) => done.push(d));
  agent.on("error", (e) => errors.push(e));

  agent._handleClose(proc, 1, null, "");

  assert.equal(done.length, 0, "no red error while the retry is armed");
  assert.equal(errors.length, 0);
  await sleep(1700);
  assert.deepEqual(agent.respawned, ["first message"]);
});

test("a second failure for the same message is shown", () => {
  const { agent, proc } = agentWhoseCodexJustExited();
  agent._writerRetryUsed = true; // the one retry already spent
  const done = [];
  agent.on("turn_done", (d) => done.push(d));

  agent._handleClose(proc, 1, null, "");

  assert.equal(done.length, 1);
  assert.equal(done[0].is_error, true);
  assert.match(done[0].errors[0], /sqlite state runtime/);
});

/**
 * SHE-90 follow-up — "I hit Stop on Codex, it does something, then it continues."
 *
 * Two root causes in the subprocess adapters (Codex, OpenCode):
 *   1. Stop signalled only the direct CLI PID, not its process GROUP. Under
 *      --dangerously-bypass-approvals-and-sandbox the CLI runs its tools/MCP
 *      servers as children; killing just the parent orphaned them and the turn
 *      kept producing output.
 *   2. interrupt() emitted turn_done immediately but kept processing stdout, so
 *      late output re-opened the turn (and a second turn_done fired on close).
 *
 * Fixes (shared in CodingAgent): spawn `detached` (own group) + `_killTree`
 * (kill(-pid)) + `_terminate` (SIGINT/TERM → SIGKILL escalation), and an
 * `_interrupted` gate that drops post-Stop stdout. These are behavioral tests
 * against REAL spawned process trees — the mock-agent suites can't exercise a
 * kill.
 *
 * Run: node --test computer/ai-chat/test/agent-stop-kills-tree-she90.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-stop-tree-"));
const { CodingAgent } = await import("../lib/coding-agent.mjs");
const { CodexAgent } = await import("../lib/codex-agent.mjs");
const { HOME } = await import("../lib/constants.mjs");

// A group is empty when signalling it (signal 0) throws ESRCH.
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}
async function waitGroupGone(pgid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await sleep(25);
  }
  return false;
}

const agent = () => new CodingAgent({ sessionId: null, model: "x", cwd: HOME, env: {} });

test("_killTree reaps the WHOLE process group, not just the parent", async () => {
  // sh + two sleeps, all in one detached group (pgid === child.pid).
  const proc = spawn("sh", ["-c", "sleep 30 & sleep 30"], { detached: true });
  await sleep(150); // let the sleeps come up
  const pgid = proc.pid;
  assert.ok(groupAlive(pgid), "the tree is running before the kill");

  agent()._killTree(proc, "SIGKILL");
  assert.ok(await waitGroupGone(pgid), "every process in the group is gone after _killTree");
});

test("_terminate escalates to SIGKILL when the graceful signal is ignored", async () => {
  // Trap INT/TERM so only SIGKILL can end it — proves the escalation fires.
  const proc = spawn("bash", ["-c", "trap '' INT TERM; sleep 30"], { detached: true });
  await sleep(150);
  const pgid = proc.pid;

  const a = agent();
  a._terminate(proc, "SIGINT", 200); // 200ms grace, then SIGKILL
  await sleep(120);
  assert.ok(groupAlive(pgid), "still alive right after SIGINT (it's trapped)");
  assert.ok(await waitGroupGone(pgid, 2000), "SIGKILL escalation reaps it");
});

test("Codex interrupt(): one turn_done, and post-Stop stdout is dropped", () => {
  const a = new CodexAgent({ sessionId: null, model: "gpt-5.6-luna", cwd: HOME, env: {} });
  a._isActive = true;
  a._isGenerating = true;
  a._startTime = Date.now();

  let turnDone = 0;
  let leaked = 0;
  a.on("turn_done", () => turnDone++);
  a.on("text_delta", () => leaked++);
  a.on("tool_start", () => leaked++);

  a.interrupt(); // no live process (null) — exercises the state machine, not a kill
  assert.equal(a._interrupted, true, "interrupt sets the stdout gate");
  assert.equal(turnDone, 1, "exactly one turn_done on Stop");
  assert.equal(a.isGenerating, false, "generating cleared");

  // Codex keeps streaming as it winds down — every line must be dropped.
  a._processLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "still going" } }));
  a._processLine(JSON.stringify({ type: "item.started", item: { id: "t1", type: "command_execution", command: "x" } }));
  assert.equal(leaked, 0, "no event escapes the interrupted gate");
  assert.equal(turnDone, 1, "and no second turn_done");
});

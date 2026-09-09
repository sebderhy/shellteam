// The idle reaper's background-Bash blind spot: _reapIfIdle deferred only for
// Task subagents (SHE-59), so a CLI whose Bash tool was still running a build
// or server in the background got SIGTERM'd after 10 quiet minutes — killing
// the background work with it. Background tasks are now tracked from the
// stream (launch = the Bash tool_result announcing the ID; completion = the
// injected <task-notification>) and defer the reap under the same stale cap
// as subagents.

import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ClaudeCliAgent } from "../lib/claude-cli-agent.mjs";

function agentWithFakeProcess() {
  const agent = new ClaudeCliAgent({ model: "claude-test", cwd: tmpdir(), env: process.env });
  const killed = [];
  agent._process = { pid: 1, stdin: { end() {} }, kill(sig) { killed.push(sig); } };
  agent._isGenerating = false;
  return { agent, killed };
}

function bashLaunchResult(id) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_bash1",
        content: `Command running in background with ID: ${id}. Output is being written to: /tmp/x.output. You will be notified when it completes.`,
      }],
    },
  };
}

function taskNotification(id) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`,
      }],
    },
  };
}

test("background Bash launch is tracked from its tool_result", () => {
  const { agent } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgabc123"));
  assert.ok(agent._bgTasks.has("bgabc123"), "the announced background ID must be tracked");
});

test("task-notification completion untracks the background task", () => {
  const { agent } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgabc123"));
  agent._handleMessage(taskNotification("bgabc123"));
  assert.equal(agent._bgTasks.size, 0, "a completed task must not keep pinning the process");
});

test("idle reaper defers while a background Bash task is tracked", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgabc123"));
  agent._lastEventAt = Date.now() - 15 * 60 * 1000; // quiet past the idle window
  agent._reapIfIdle();
  assert.deepEqual(killed, [], "must not SIGTERM a process with a live background task");
  assert.ok(agent._idleTimer, "must re-arm the idle timer instead");
  agent._clearIdleTimer();
});

test("idle reaper kills once the background task completed and quiet resumes", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgabc123"));
  agent._handleMessage(taskNotification("bgabc123"));
  agent._lastEventAt = Date.now() - 15 * 60 * 1000;
  agent._reapIfIdle();
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("a never-completing background task cannot pin the process forever (stale cap)", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgdevserver"));
  agent._lastEventAt = Date.now() - 2 * 60 * 60 * 1000; // zero events for 2h
  agent._reapIfIdle();
  assert.deepEqual(killed, ["SIGTERM"], "the stale cap bounds a leaked/immortal entry");
});

test("process close handler clears tracked background tasks (source contract)", async () => {
  // The close handler is wired inside _spawnCLI (which spawns a real CLI), so
  // pin the contract at the source level: the handler must clear _bgTasks —
  // tasks die with the process, and a stale entry must not pin the NEXT one.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/claude-cli-agent.mjs", import.meta.url), "utf8");
  const closeHandler = src.split('this._process.on("close"')[1].split("this._resetWatchdog()")[0];
  assert.ok(closeHandler.includes("this._bgTasks.clear()"),
    "the close handler must clear _bgTasks");
});

test("unrelated tool results and notifications do not confuse the tracker", () => {
  const { agent } = agentWithFakeProcess();
  agent._handleMessage({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42 passed" }] },
  });
  agent._handleMessage(taskNotification("bg-never-seen"));
  assert.equal(agent._bgTasks.size, 0);
});

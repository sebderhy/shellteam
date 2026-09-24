// The idle reaper and background work inside the Claude CLI process.
//
// SHE-59: the reaper killed a CLI whose Task subagents were still working.
// Then background Bash (run_in_background) had the same blind spot: tracked
// from the stream (launch = the Bash tool_result announcing the ID and output
// file; completion = the injected <task-notification>).
//
// SHE-93: the 1 h stale cap treated a QUIET task as a leaked one. A watcher on
// a multi-hour benchmark (`until grep -q DONE log; do sleep 60; done`) prints
// nothing, so after an hour the CLI was reaped, the watcher died with it, and
// the agent never reported. Liveness is now judged by the task's shell, which
// holds the output file open for writing until it exits — never by silence.
// A CLI that dies with tasks running reports them so the session manager can
// resume the agent with a notice.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, openSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliAgent } from "../lib/claude-cli-agent.mjs";

const dir = mkdtempSync(join(tmpdir(), "st-reap-"));

function agentWithFakeProcess() {
  const agent = new ClaudeCliAgent({ model: "claude-test", cwd: tmpdir(), env: process.env });
  const killed = [];
  agent._process = { pid: 1, stdin: { end() {} }, kill(sig) { killed.push(sig); } };
  agent._isGenerating = false;
  agent._isActive = true;
  return { agent, killed };
}

function bashLaunchResult(id, outputFile = `/tmp/${id}.output`) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_bash1",
        content: `Command running in background with ID: ${id}. Output is being written to: ${outputFile}. You will be notified when it completes.`,
      }],
    },
  };
}

function taskNotification(id, toolUseId = "toolu_bash1") {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>completed</status>\n</task-notification>`,
      }],
    },
  };
}

/** A real quiet task: a shell child holding its output file open for writing. */
async function liveTask(name) {
  const file = join(dir, `${name}.output`);
  const fd = openSync(file, "a");
  const child = spawn("sleep", ["60"], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  await once(child, "spawn");
  return { file, stop: async () => { child.kill("SIGKILL"); await once(child, "close"); } };
}

function finishedTask(name) {
  const file = join(dir, `${name}.output`);
  writeFileSync(file, "[exited with code 0]\n");
  return file;
}

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test("background Bash launch is tracked with its output file", () => {
  const { agent } = agentWithFakeProcess();
  const events = [];
  agent.on("background_tasks", (e) => events.push(e));
  agent._handleMessage(bashLaunchResult("bgabc123", "/tmp/claude-1/tasks/bgabc123.output"));
  assert.equal(agent._bgTasks.get("bgabc123")?.outputFile, "/tmp/claude-1/tasks/bgabc123.output",
    "the output file (with the sentence's trailing period stripped) is the liveness handle");
  assert.equal(events.at(-1).tasks[0].id, "bgabc123", "the session manager is told what is tracked");
});

test("task-notification completion untracks the background task", () => {
  const { agent } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgabc123"));
  agent._handleMessage(taskNotification("bgabc123"));
  assert.equal(agent._bgTasks.size, 0, "a completed task must not keep pinning the process");
});

test("SHE-93: a quiet background task is never reaped while its shell is alive, however long the silence", async () => {
  const { agent, killed } = agentWithFakeProcess();
  const task = await liveTask("watcher");
  try {
    agent._handleMessage(bashLaunchResult("bgwatch", task.file));
    agent._lastEventAt = Date.now() - 3 * 60 * 60 * 1000; // three silent hours, past the old 1 h cap
    const logs = captureLogs(() => agent._reapIfIdle());
    assert.deepEqual(killed, [], "must not SIGTERM a process whose background task is still running");
    assert.ok(agent._idleTimer, "must re-arm the idle timer instead");
    assert.ok(logs.some((l) => l.includes("still running (bgwatch)")), `the deferral names the live task: ${logs}`);
  } finally {
    agent._clearIdleTimer();
    await task.stop();
  }
});

test("a tracked task whose shell has exited is untracked, and the reaper proceeds", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgdone", finishedTask("done")));
  agent._lastEventAt = Date.now() - 15 * 60 * 1000;
  const logs = captureLogs(() => agent._reapIfIdle());
  assert.equal(agent._bgTasks.size, 0, "a task nobody writes to any more is finished");
  assert.deepEqual(killed, ["SIGTERM"]);
  assert.ok(logs.some((l) => l.includes("bgdone: no process writes")), `the untracking is logged: ${logs}`);
  assert.ok(logs.some((l) => l.includes("quiet for") && l.includes("nothing tracked")), `the kill log states the real reason: ${logs}`);
});

test("idle reaper kills once the background task completed and quiet resumes", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._handleMessage(bashLaunchResult("bgabc123"));
  agent._handleMessage(taskNotification("bgabc123"));
  agent._lastEventAt = Date.now() - 15 * 60 * 1000;
  agent._reapIfIdle();
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("the stale cap still bounds leaked subagents, and the kill log says so instead of claiming nothing was tracked", () => {
  const { agent, killed } = agentWithFakeProcess();
  agent._subagents.set("toolu_leaked", { steps: 3 });
  agent._lastEventAt = Date.now() - 30 * 60 * 1000;
  let logs = captureLogs(() => agent._reapIfIdle());
  assert.deepEqual(killed, [], "under the cap a tracked subagent still defers the reap");
  assert.ok(logs.some((l) => l.includes("1 subagent(s)") && l.includes("stale cap")), `deferral names the cap: ${logs}`);
  agent._clearIdleTimer();
  agent._lastEventAt = Date.now() - 2 * 60 * 60 * 1000;
  logs = captureLogs(() => agent._reapIfIdle());
  assert.deepEqual(killed, ["SIGTERM"]);
  assert.ok(logs.some((l) => l.includes("Idle timeout (stale cap: 1 subagent(s)")), `the reason is the cap, not "nothing tracked": ${logs}`);
});

test("SHE-93: an async subagent's task-notification releases its tracker entry", () => {
  const { agent } = agentWithFakeProcess();
  const done = [];
  agent.on("subagent_done", (e) => done.push(e.parent_id));
  agent._subagents.set("toolu_agent1", { steps: 7 });
  // Async Agent completions arrive as a notification naming the Agent tool call,
  // never as a parent_tool_use_id result — the leak that counted 6 phantom
  // subagents hours after they had all finished.
  agent._handleMessage(taskNotification("afd71a8d7fd0c00ed", "toolu_agent1"));
  assert.equal(agent._subagents.size, 0);
  assert.deepEqual(done, ["toolu_agent1"], "the cockpit's subagent indicator is closed too");
});

test("a CLI that dies with background tasks running reports them; a deliberate stop does not", () => {
  const { agent } = agentWithFakeProcess();
  const lost = [];
  agent.on("background_tasks_lost", (e) => lost.push(e));
  agent._handleMessage(bashLaunchResult("bgcrash", "/tmp/bgcrash.output"));
  agent._onProcessClose(137, null);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].tasks[0].id, "bgcrash");
  assert.equal(lost[0].exit, "code=137 signal=null");
  assert.equal(agent._bgTasks.size, 0, "a stale entry must not pin the NEXT spawned process");

  const stopped = agentWithFakeProcess();
  const lost2 = [];
  stopped.agent.on("background_tasks_lost", (e) => lost2.push(e));
  stopped.agent._handleMessage(bashLaunchResult("bgabandoned"));
  stopped.agent.stop(); // clears _isActive before the kill
  stopped.agent._onProcessClose(143, null);
  assert.deepEqual(lost2, [], "the user asked for the stop: nothing to resume");
});

test("a deliberate idle reap never reads as lost work", () => {
  const { agent, killed } = agentWithFakeProcess();
  const lost = [];
  agent.on("background_tasks_lost", (e) => lost.push(e));
  agent._handleMessage(bashLaunchResult("bgdone", finishedTask("done2")));
  agent._lastEventAt = Date.now() - 15 * 60 * 1000;
  agent._reapIfIdle();
  assert.deepEqual(killed, ["SIGTERM"]);
  agent._onProcessClose(143, null);
  assert.deepEqual(lost, []);
});

test("unrelated tool results and notifications do not confuse the tracker", () => {
  const { agent } = agentWithFakeProcess();
  agent._handleMessage({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42 passed" }] },
  });
  agent._handleMessage(taskNotification("bg-never-seen", "toolu_never"));
  assert.equal(agent._bgTasks.size, 0);
  assert.equal(agent._subagents.size, 0);
});

// --- Structured task messages (Claude Code >= 2.1.28x) ---------------------
// The CLI narrates background work as `system` messages; the text forms above
// are the fallback. A real capture drives the whole tracker end to end.
import { readFileSync } from "node:fs";

const FIXTURE = readFileSync(new URL("./fixtures/claude-stream-background-task.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean);

// _processLine arms the watchdog and, on `result`, the idle timer; a pending
// timer would keep the test runner alive for minutes.
const disarm = (agent) => { agent._clearIdleTimer(); agent._clearWatchdog(); };

test("a real stream: task_started tracks the task with its tool call, task_notification releases it", () => {
  const { agent } = agentWithFakeProcess();
  agent._isActive = true;
  const seen = [];
  agent.on("background_tasks", (e) => seen.push(e.tasks.map((t) => t.id)));
  for (const line of FIXTURE) {
    agent._processLine(line);
    const msg = JSON.parse(line);
    if (msg.subtype === "task_started") {
      assert.deepEqual([...agent._bgTasks.keys()], ["b9xbfrywn"], "tracked from the structured start");
      assert.equal(agent._bgTasks.get("b9xbfrywn").toolUseId, "toolu_01FBQrgsQc8HZdMmJXwyYQcU");
    }
  }
  disarm(agent);
  assert.equal(agent._bgTasks.size, 0, "released by the end of the stream");
  assert.ok(seen.some((ids) => ids.includes("b9xbfrywn")) && seen.at(-1).length === 0,
    "the session manager saw the task appear and disappear");
});

test("background_tasks_changed is authoritative: a tracked task missing from the CLI's list is dropped", () => {
  const { agent } = agentWithFakeProcess();
  agent._processLine(JSON.stringify({ type: "system", subtype: "task_started", task_id: "bgA", tool_use_id: "toolu_A", task_type: "local_bash", is_backgrounded: true }));
  agent._processLine(JSON.stringify({ type: "system", subtype: "task_started", task_id: "bgB", tool_use_id: "toolu_B", task_type: "local_bash", is_backgrounded: true }));
  agent._processLine(JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bgB", task_type: "local_bash" }] }));
  disarm(agent);
  assert.deepEqual([...agent._bgTasks.keys()], ["bgB"]);
});

test("the structured task_notification releases an async subagent by tool_use_id", () => {
  const { agent } = agentWithFakeProcess();
  const done = [];
  agent.on("subagent_done", (e) => done.push(e.parent_id));
  agent._subagents.set("toolu_agent9", { steps: 2 });
  agent._processLine(JSON.stringify({ type: "system", subtype: "task_notification", task_id: "a1b2c3", tool_use_id: "toolu_agent9", status: "completed", output_file: "/tmp/x.output" }));
  disarm(agent);
  assert.equal(agent._subagents.size, 0);
  assert.deepEqual(done, ["toolu_agent9"]);
});

test("the text launch result enriches a structured start with the output file instead of replacing it", () => {
  const { agent } = agentWithFakeProcess();
  agent._processLine(JSON.stringify({ type: "system", subtype: "task_started", task_id: "bgZ", tool_use_id: "toolu_Z", task_type: "local_bash", is_backgrounded: true }));
  const startedAt = agent._bgTasks.get("bgZ").startedAt;
  agent._handleMessage(bashLaunchResult("bgZ", "/tmp/claude-1/tasks/bgZ.output"));
  disarm(agent);
  const task = agent._bgTasks.get("bgZ");
  assert.equal(task.outputFile, "/tmp/claude-1/tasks/bgZ.output");
  assert.equal(task.toolUseId, "toolu_Z");
  assert.equal(task.startedAt, startedAt);
});

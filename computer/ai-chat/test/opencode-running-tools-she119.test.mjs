/**
 * SHE-119 — "OpenCode seems stuck again".
 *
 * What happened (2026-10-16): GLM 5.3 started a 20-minute benchmark through
 * OpenCode's bash tool. `opencode run --format json` reports a tool call only
 * once it finishes, so the chat showed nothing for 15 minutes; the idle
 * watchdog then read that silence as a wedged process, killed the turn and
 * resent the user's message. The benchmark survived as an orphan: OpenCode's
 * bash tool runs commands under setsid, outside the process group that
 * Stop/watchdog signal.
 *
 * Pinned here with a fake `opencode` that records its running tool call in a
 * real SQLite database (as OpenCode does) and runs it under setsid:
 *  1. the running call is shown at once, and its completion is not shown twice;
 *  2. a running tool keeps the watchdog quiet;
 *  3. Stop also kills tool processes that left the CLI's process group.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAgent } from "../lib/opencode-agent.mjs";

// FAKE_TOOL_MS: how long the bash call runs silently before it completes.
function fakeOpencode(dir) {
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const out = (o) => process.stdout.write(JSON.stringify({ sessionID: "ses_fake", ...o }) + "\\n");
const dbDir = process.env.XDG_DATA_HOME + "/opencode";
fs.mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(dbDir + "/opencode.db");
db.exec("CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
// Like OpenCode, the row keeps the part id in its own column, not in the blob.
const tool = { type: "tool", tool: "bash", callID: "call_1",
  state: { status: "running", input: { command: "python3 bench.py" } } };
out({ type: "step_start", part: { type: "step-start" } });
// FAKE_LOCK_MS: hold the write lock that long, as OpenCode's own writes do.
if (process.env.FAKE_LOCK_MS) {
  db.exec("BEGIN EXCLUSIVE");
  setTimeout(() => db.exec("COMMIT"), Number(process.env.FAKE_LOCK_MS));
}
db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("prt_bash1", "msg_1", "ses_fake", Date.now(), Date.now(), JSON.stringify(tool));
const child = spawn("setsid", ["sleep", "60"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_TOOL_PID, String(child.pid));
setTimeout(() => {
  tool.state = { ...tool.state, status: "completed", output: "bench done" };
  db.prepare("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify(tool), "prt_bash1");
  out({ type: "tool_use", part: { id: "prt_bash1", ...tool } });
  out({ type: "text", part: { type: "text", text: "finished" } });
  child.kill();
  process.exit(0);
}, Number(process.env.FAKE_TOOL_MS));
`);
  chmodSync(bin, 0o755);
}

function setup(toolMs, lockMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "she119-"));
  fakeOpencode(dir);
  const pidFile = join(dir, "tool.pid");
  const agent = new OpenCodeAgent({
    model: "glm-5p3", cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, XDG_DATA_HOME: join(dir, "data"),
      FAKE_TOOL_PID: pidFile, FAKE_TOOL_MS: String(toolMs),
      ...(lockMs ? { FAKE_LOCK_MS: String(lockMs) } : {}) },
  });
  agent._toolPollMs = 100;
  agent.start();
  const events = [];
  for (const t of ["tool_start", "tool_input", "tool_result", "turn_done"]) agent.on(t, (d) => events.push({ t, ...d }));
  const toolPid = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  return { agent, events, toolPid, cleanup: () => { agent.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

const waitFor = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a running tool call is shown while it runs, and its completion is not shown twice", async () => {
  const { agent, events, cleanup } = setup(3000);
  try {
    agent.sendMessage("run the benchmark");
    await waitFor(() => events.some((e) => e.t === "tool_start"));
    assert.equal(events.some((e) => e.t === "tool_result"), false, "shown before it finished");
    assert.deepEqual(events.find((e) => e.t === "tool_start"), { t: "tool_start", id: "prt_bash1", name: "Bash" });
    assert.deepEqual(events.find((e) => e.t === "tool_input").input, { command: "python3 bench.py" });
    await waitFor(() => events.some((e) => e.t === "turn_done"));
    assert.equal(events.filter((e) => e.t === "tool_start").length, 1);
    assert.equal(events.find((e) => e.t === "tool_result").content, "bench done");
  } finally { cleanup(); }
});

test("a busy OpenCode database delays the running card, it does not hide it", async () => {
  // OpenCode writes to its database constantly; a poll that hit its lock used
  // to stop polling for the whole turn, so the tool stayed invisible again.
  const { agent, events, cleanup } = setup(3000, 800);
  try {
    agent.sendMessage("run the benchmark");
    await waitFor(() => events.some((e) => e.t === "tool_start" || e.t === "tool_result"), 10000);
    assert.equal(events.some((e) => e.t === "tool_result"), false, "shown before it finished, once the lock was released");
    await waitFor(() => events.some((e) => e.t === "turn_done"), 10000);
  } finally { cleanup(); }
});

test("a long silent tool call does not trip the idle watchdog", async () => {
  const { agent, events, cleanup } = setup(3000);
  try {
    agent.sendMessage("run the benchmark");
    // Shorten the watchdog only once the tool is running: armed earlier, a slow
    // start of the fake CLI under a loaded machine tripped it before the tool
    // existed (a real silence, so the right call, but not this test's subject).
    await waitFor(() => events.some((e) => e.t === "tool_start"));
    agent._watchdogIdleMs = 1000;  // a third of the tool's silence
    agent._resetWatchdog();
    await waitFor(() => events.some((e) => e.t === "turn_done"), 10000);
    const done = events.find((e) => e.t === "turn_done");
    assert.notEqual(done.subtype, "watchdog_timeout");
    assert.equal(events.find((e) => e.t === "tool_result").content, "bench done");
  } finally { cleanup(); }
});

test("Stop kills a tool process that left the CLI's process group (setsid)", async () => {
  const { agent, toolPid, cleanup } = setup(30000);
  try {
    agent.sendMessage("run the benchmark");
    await waitFor(() => toolPid() && alive(toolPid()));
    // setsid forks when it is a group leader; wait for the sleep it execs.
    await new Promise((r) => setTimeout(r, 200));
    agent.interrupt();
    await waitFor(() => !alive(toolPid()), 3000);
  } finally { cleanup(); }
});

/**
 * SHE-118 — "OpenCode + GLM 5.3 doesn't seem to be working at all".
 *
 * What happened (2026-10-16): GLM 5.3 spent the first turn's whole output
 * budget (OpenCode caps it at 32K tokens) thinking — it drafted every file of
 * the task in its reasoning — and stopped with finish "length" after 8.5 min,
 * having written nothing and called no tool. The cockpit hides OpenCode's
 * reasoning, so the chat showed nothing. The user's "Are you working?" then
 * spawned a SECOND `opencode run` on the same session while the first still
 * ran: both answered into one conversation, and Stop only reached the newer.
 *
 * Fixes pinned here, driving the REAL spawn/close path with a fake `opencode`:
 *  1. a mid-turn message waits for the running process to exit (shared queue,
 *     same as Codex SHE-107) — never two processes on one session;
 *  2. a step that hits the cap having done nothing is reported and nudged
 *     once to act; a second such step ends the turn with an error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAgent } from "../lib/opencode-agent.mjs";
import { AntigravityAgent } from "../lib/antigravity-agent.mjs";

// The fake prints a scripted JSONL sequence per call and logs start/end times.
// FAKE_MODE=slow: every call answers after 300 ms. FAKE_MODE=overflow: every
// call thinks until the cap; FAKE_MODE=overflow-once: only calls whose prompt
// is not the cockpit nudge do.
function fakeOpencode(dir) {
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const prompt = process.argv[process.argv.length - 1];
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify({ sessionID: "ses_fake", ...o }) + "\\n");
log({ start: Date.now(), prompt });
const mode = process.env.FAKE_MODE;
const overflow = mode === "overflow" || (mode === "overflow-once" && !prompt.includes("<cockpit-notice>"));
out({ type: "step_start", part: { type: "step-start" } });
setTimeout(() => {
  if (overflow) {
    out({ type: "reasoning", part: { type: "reasoning", text: "plan plan plan" } });
    out({ type: "step_finish", part: { type: "step-finish", reason: "length", tokens: { output: 1, reasoning: 31999 } } });
  } else {
    out({ type: "text", part: { type: "text", text: "answer to: " + prompt.slice(0, 40) } });
    out({ type: "step_finish", part: { type: "step-finish", reason: "stop" } });
  }
  log({ end: Date.now() });
  process.exit(0);
}, 300);
`);
  chmodSync(bin, 0o755);
}

function setup(mode) {
  const dir = mkdtempSync(join(tmpdir(), "she118-"));
  fakeOpencode(dir);
  const logFile = join(dir, "calls.jsonl");
  const agent = new OpenCodeAgent({
    model: "glm-5p3", cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: logFile, FAKE_MODE: mode },
  });
  agent.start();
  const events = [];
  for (const t of ["text_done", "error", "turn_done"]) agent.on(t, (d) => events.push({ t, ...d }));
  const calls = () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { dir, agent, events, calls, cleanup: () => { agent.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

// Not events.once: it rejects on the "error" event, which the overflow notice is.
function turnsDone(agent, n) {
  return new Promise((resolve) => {
    let seen = 0;
    const on = () => { if (++seen === n) { agent.off("turn_done", on); resolve(); } };
    agent.on("turn_done", on);
  });
}

test("a message sent mid-turn waits for the running opencode to exit — never two on one session", async () => {
  const { agent, events, calls, cleanup } = setup("slow");
  try {
    agent.sendMessage("first");
    agent.sendMessage("are you working?");
    assert.equal(agent._queued.length, 1, "held, not spawned");
    assert.equal(agent.isGenerating, true);
    await turnsDone(agent, 2);

    const log = calls();
    const starts = log.filter((c) => c.start);
    const ends = log.filter((c) => c.end);
    assert.deepEqual(starts.map((c) => c.prompt), ["first", "are you working?"], "both ran, in order");
    assert.ok(starts[1].start >= ends[0].end, "the second process started only after the first exited");
    assert.deepEqual(events.filter((e) => e.t === "text_done").map((e) => e.text),
      ["answer to: first", "answer to: are you working?"]);
    assert.equal(agent.isGenerating, false);
  } finally { cleanup(); }
});

test("Stop drops a queued follow-up instead of running it after the cancelled turn", async () => {
  const { agent, calls, cleanup } = setup("slow");
  try {
    agent.sendMessage("first");
    agent.sendMessage("queued");
    while (!calls().length) await new Promise((r) => setTimeout(r, 20));
    agent.interrupt();
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(calls().filter((c) => c.start).map((c) => c.prompt), ["first"]);
    assert.equal(agent.isGenerating, false);
  } finally { cleanup(); }
});

test("a step that thinks to the cap and does nothing is reported and nudged once to act", async () => {
  const { agent, events, calls, cleanup } = setup("overflow-once");
  try {
    agent.sendMessage("build the benchmark");
    await turnsDone(agent, 1);

    const prompts = calls().filter((c) => c.start).map((c) => c.prompt);
    assert.equal(prompts.length, 2, "one automatic continuation");
    assert.match(prompts[1], /act on your plan now/);
    const errors = events.filter((e) => e.t === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /glm-5p3 spent its whole output budget thinking/);
    assert.equal(events.filter((e) => e.t === "turn_done").length, 1, "still ONE turn for the user");
    const done = events.find((e) => e.t === "turn_done");
    assert.ok(!done.is_error);
    assert.match(events.find((e) => e.t === "text_done").text, /answer to: <cockpit-notice>/);
  } finally { cleanup(); }
});

test("a second overflow ends the turn with an error instead of looping", async () => {
  const { agent, events, calls, cleanup } = setup("overflow");
  try {
    agent.sendMessage("build the benchmark");
    await turnsDone(agent, 1);
    assert.equal(calls().filter((c) => c.start).length, 2, "nudged once, never twice");
    const done = events.find((e) => e.t === "turn_done");
    assert.equal(done.is_error, true);
    assert.match(done.errors[0], /thinking again/);

    // The next user message gets its own nudge.
    agent.sendMessage("try again");
    await turnsDone(agent, 1);
    assert.equal(calls().filter((c) => c.start).length, 4);
  } finally { cleanup(); }
});

test("Antigravity queues a mid-turn message too", () => {
  const agent = new AntigravityAgent({ model: "gemini-3.5-pro", cwd: tmpdir(), env: {} });
  agent.start();
  const spawned = [];
  agent._spawnTurn = (p) => { spawned.push(p); agent._isGenerating = true; agent._process = { pid: 999, killed: true }; };
  agent.sendMessage("first");
  agent.sendMessage("second");
  assert.deepEqual(spawned, ["first"]);
  agent._isGenerating = false; agent._process = null;
  agent._drainQueue();
  assert.deepEqual(spawned, ["first", "second"]);
});

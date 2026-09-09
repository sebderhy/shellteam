// Integration tests for AntigravityAgent — drives the REAL adapter (spawn →
// parse → event emission) against a fake `agy` on PATH, so no Google round-trip.
//
// The fake agy: records its argv to $AGY_ARGV_FILE, then prints a JSON envelope
// (canned via $AGY_ENVELOPE, or a default SUCCESS blob), mirroring the shape of
// `agy -p --output-format json`.
//
// Run: node --test computer/ai-chat/test/antigravity-agent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityAgent } from "../lib/antigravity-agent.mjs";

// Build a throwaway dir holding a fake `agy` executable + argv sink.
function fakeAgyEnv(envelope) {
  const dir = mkdtempSync(join(tmpdir(), "agy-fake-"));
  const argvFile = join(dir, "argv.json");
  const agy = join(dir, "agy");
  // Node shebang keeps this OS-portable (no bash-ism) and lets us emit exact JSON.
  writeFileSync(
    agy,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.AGY_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(process.env.AGY_ENVELOPE || "");
`,
  );
  chmodSync(agy, 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    AGY_ARGV_FILE: argvFile,
    AGY_ENVELOPE: envelope,
  };
  const argvLines = () =>
    (existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean) : []).map((l) =>
      JSON.parse(l),
    );
  return { env, cwd: dir, argvLines };
}

// Run one turn and collect every emitted event in order.
function driveTurn(agent, prompt) {
  const events = [];
  for (const ev of ["init", "text_delta", "text_done", "tool_start", "tool_result", "error", "turn_done"]) {
    agent.on(ev, (data) => events.push({ ev, data }));
  }
  return new Promise((resolve) => {
    agent.on("turn_done", () => setImmediate(() => resolve(events)));
    agent.sendMessage(prompt);
  });
}

test("a fresh turn emits init → text_done → turn_done, captures conversation_id + usage", async () => {
  const envelope = JSON.stringify({
    conversation_id: "conv-abc",
    status: "SUCCESS",
    response: "hello\n",
    num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, total_tokens: 120 },
  });
  const { env, cwd } = fakeAgyEnv(envelope);
  const agent = new AntigravityAgent({ sessionId: null, model: "gemini-3.1-pro", cwd, env });
  agent.start();

  const events = await driveTurn(agent, "hi");
  const types = events.map((e) => e.ev);

  assert.ok(types.includes("text_done"), "should emit text_done");
  assert.ok(types.includes("turn_done"), "should emit turn_done");
  assert.equal(types.indexOf("text_done") < types.indexOf("turn_done"), true, "text_done before turn_done");

  const textDone = events.find((e) => e.ev === "text_done");
  assert.equal(textDone.data.text, "hello", "trailing newline trimmed");

  // conversation_id arrives in the result → a second init pins it as sessionId.
  const initWithId = events.filter((e) => e.ev === "init").find((e) => e.data.sessionId === "conv-abc");
  assert.ok(initWithId, "an init should carry the conversation_id as sessionId");
  assert.equal(agent.sessionId, "conv-abc");

  const turnDone = events.find((e) => e.ev === "turn_done");
  assert.equal(turnDone.data.is_error, false);
  assert.deepEqual(turnDone.data.usage, {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    thinking_tokens: 5,
  });
  agent.stop();
});

test("model id maps to the agy display name; resume passes --conversation", async () => {
  const envelope = JSON.stringify({ conversation_id: "conv-xyz", status: "SUCCESS", response: "ok" });
  const { env, cwd, argvLines } = fakeAgyEnv(envelope);
  const agent = new AntigravityAgent({ sessionId: null, model: "gemini-3.1-pro", cwd, env });
  agent.start();

  await driveTurn(agent, "first");
  await driveTurn(agent, "second");

  const calls = argvLines();
  assert.equal(calls.length, 2, "two turns → two agy spawns");

  // Both turns: catalog id "gemini-3.1-pro" → display name "Gemini 3.1 Pro (High)".
  for (const argv of calls) {
    const mi = argv.indexOf("--model");
    assert.ok(mi >= 0, "--model passed");
    assert.equal(argv[mi + 1], "Gemini 3.1 Pro (High)", "mapped to agy display name");
    assert.ok(argv.includes("--output-format") && argv[argv.indexOf("--output-format") + 1] === "json");
  }

  // Turn 1 is fresh (no --conversation); turn 2 resumes the captured id.
  assert.equal(calls[0].includes("--conversation"), false, "turn 1 fresh");
  const ci = calls[1].indexOf("--conversation");
  assert.ok(ci >= 0 && calls[1][ci + 1] === "conv-xyz", "turn 2 resumes conv-xyz");
  agent.stop();
});

test("a non-SUCCESS envelope surfaces an error and a failed turn_done", async () => {
  const envelope = JSON.stringify({ conversation_id: "c1", status: "ERROR", error: "quota exhausted" });
  const { env, cwd } = fakeAgyEnv(envelope);
  const agent = new AntigravityAgent({ sessionId: null, model: "gemini-3.1-pro", cwd, env });
  agent.start();

  const events = await driveTurn(agent, "hi");
  const err = events.find((e) => e.ev === "error");
  assert.ok(err && /quota exhausted/.test(err.data.message), "error surfaced");
  const turnDone = events.find((e) => e.ev === "turn_done");
  assert.equal(turnDone.data.is_error, true);
  assert.match(turnDone.data.errors[0], /quota exhausted/);
  agent.stop();
});

test("unparseable agy output fails loudly (error + errored turn_done), never silently", async () => {
  const { env, cwd } = fakeAgyEnv("not json at all");
  const agent = new AntigravityAgent({ sessionId: null, model: "gemini-3.1-pro", cwd, env });
  agent.start();

  const events = await driveTurn(agent, "hi");
  assert.ok(events.some((e) => e.ev === "error"), "should emit an error");
  const turnDone = events.find((e) => e.ev === "turn_done");
  assert.equal(turnDone.data.is_error, true);
  agent.stop();
});

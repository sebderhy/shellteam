// Integration tests for AntigravityAgent: drives the REAL adapter (spawn →
// stream parse → event emission) against a fake `agy` on PATH that replays
// output recorded from agy 1.5.9 (test/fixtures/agy/, 14 Nov 2026, SHE-113).
//
// The fake agy records its argv to $AGY_ARGV_FILE, prints $AGY_STDOUT_FILE to
// stdout and $AGY_STDERR_FILE to stderr, and exits with $AGY_EXIT.
//
// Run: node --test computer/ai-chat/test/antigravity-agent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// HOME is read once at import (lib/constants.mjs): a throwaway one, so the
// launch layer never writes into the real box's memory or runtime files.
process.env.HOME = mkdtempSync(join(tmpdir(), "agy-home-"));
const { AntigravityAgent, agyErrorInWords } = await import("../lib/antigravity-agent.mjs");
const { DEFAULT_ANTIGRAVITY_MODEL } = await import("../lib/constants.mjs");
const { cliModelForId } = await import("../lib/model-catalog.mjs");

const FIXTURES = fileURLToPath(new URL("./fixtures/agy/", import.meta.url));
const fixture = (name) => join(FIXTURES, name);

function fakeAgyEnv({ stdout = null, stderr = null, exit = 0, text = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agy-fake-"));
  const argvFile = join(dir, "argv.json");
  let out = stdout;
  if (text !== null) {
    out = join(dir, "out.jsonl");
    writeFileSync(out, text);
  }
  const agy = join(dir, "agy");
  writeFileSync(
    agy,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.AGY_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.AGY_STDERR_FILE) process.stderr.write(fs.readFileSync(process.env.AGY_STDERR_FILE));
if (process.env.AGY_STDOUT_FILE) process.stdout.write(fs.readFileSync(process.env.AGY_STDOUT_FILE));
process.exitCode = Number(process.env.AGY_EXIT || 0);
`,
  );
  chmodSync(agy, 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    AGY_ARGV_FILE: argvFile,
    AGY_STDOUT_FILE: out || "",
    AGY_STDERR_FILE: stderr || "",
    AGY_EXIT: String(exit),
    GEMINI_API_KEY: "must-be-stripped",
  };
  const argvLines = () =>
    (existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean) : []).map((l) =>
      JSON.parse(l),
    );
  return { env, cwd: dir, argvLines };
}

const EVENTS = ["init", "text_delta", "text_done", "tool_start", "tool_input", "tool_result", "error", "turn_done"];

function driveTurn(agent, prompt) {
  const events = [];
  const listeners = EVENTS.map((ev) => {
    const fn = (data) => events.push({ ev, data });
    agent.on(ev, fn);
    return [ev, fn];
  });
  return new Promise((resolve) => {
    agent.once("turn_done", () => setImmediate(() => {
      for (const [ev, fn] of listeners) agent.off(ev, fn);
      resolve(events);
    }));
    agent.sendMessage(prompt);
  });
}

function newAgent(env, cwd, sessionId = null) {
  const agent = new AntigravityAgent({ sessionId, model: DEFAULT_ANTIGRAVITY_MODEL, cwd, env });
  agent.start();
  return agent;
}

test("a turn streams: text as it is written, tools live, usage at the end", async () => {
  const { env, cwd } = fakeAgyEnv({ stdout: fixture("claude-tools.stdout.jsonl") });
  const agent = newAgent(env, cwd);
  const events = await driveTurn(agent, "read, run, edit, call deepwiki");
  const of = (ev) => events.filter((e) => e.ev === ev).map((e) => e.data);

  const convId = "e6455dd0-ba77-460e-bdc6-67f543c52b27";
  assert.equal(of("init")[0].sessionId, convId, "the conversation id is pinned from agy's first event");
  assert.equal(agent.sessionId, convId);

  assert.deepEqual(of("tool_start").map((t) => t.name), [
    "Bash", "Read", "Bash", "Edit", "Read", "mcp__research_deepwiki__read_wiki_structure",
  ]);
  const inputs = of("tool_input").map((t) => t.input);
  assert.equal(inputs[0].command, "find /home/user/work -name notes.txt");
  assert.equal(inputs[1].file_path, "/home/user/work/scratch/notes.txt");
  assert.deepEqual(inputs[5], { repoName: "facebook/react" });
  const results = of("tool_result");
  assert.equal(results.length, 6, "every tool gets its result");
  assert.match(results[5].content, /Available pages for faceboo/);
  assert.equal(results[3].content, "Done", "a tool with no output still closes");

  assert.ok(of("text_delta").length >= 2, "text arrives in pieces");
  const [said] = of("text_done");
  assert.match(said.text, /^I read `notes.txt`.*8 top-level topics\.$/s);
  assert.equal(of("text_done").length, 1, "steps with no text add no empty message");

  const done = of("turn_done")[0];
  assert.equal(done.is_error, false);
  // The context meter wants the size of the last request (agy's result sums
  // every step of the turn): the last step read 944 new + 25,907 cached.
  assert.equal(done.usage.input_tokens, 944);
  assert.equal(done.usage.cache_read_input_tokens, 25907);
  assert.equal(done.usage.output_tokens, 749, "output is the whole turn's");
  agent.stop();
});

test("the catalog's id is passed as agy's own model name; a second turn resumes", async () => {
  const { env, cwd, argvLines } = fakeAgyEnv({ stdout: fixture("claude-tools.stdout.jsonl") });
  const agent = newAgent(env, cwd);
  await driveTurn(agent, "first");
  await driveTurn(agent, "second");
  const [first, second] = argvLines();
  for (const argv of [first, second]) {
    assert.equal(argv[argv.indexOf("--model") + 1], cliModelForId(DEFAULT_ANTIGRAVITY_MODEL));
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
  }
  assert.match(cliModelForId(DEFAULT_ANTIGRAVITY_MODEL), /^gemini-[a-z0-9.-]+-(low|medium|high|xhigh)$/,
    "an `agy models` slug, never a display name agy no longer accepts");
  assert.equal(first.includes("--conversation"), false);
  assert.equal(second[second.indexOf("--conversation") + 1], "e6455dd0-ba77-460e-bdc6-67f543c52b27");
  agent.stop();
});

test("Google's location refusal reaches the tab in plain words", async () => {
  const { env, cwd } = fakeAgyEnv({
    stdout: fixture("gemini-location-error.stdout.jsonl"),
    stderr: fixture("gemini-location-error.stderr.txt"),
    exit: 3,
  });
  const agent = newAgent(env, cwd);
  const events = await driveTurn(agent, "hi");
  const errors = events.filter((e) => e.ev === "error").map((e) => e.data.message);
  assert.equal(errors.length, 1, "said once");
  assert.match(errors[0], /Google refused Gemini for this server's location/);
  assert.match(errors[0], /User location is not supported/, "Google's own words kept");
  const done = events.find((e) => e.ev === "turn_done").data;
  assert.equal(done.is_error, true);
  assert.equal(done.errors[0], errors[0]);
});

test("an agy error other than the location one is shown as agy said it", () => {
  assert.equal(agyErrorInWords("RESOURCE_EXHAUSTED (code 429): quota"), "Antigravity: RESOURCE_EXHAUSTED (code 429): quota");
});

test("a conversation agy no longer knows is said, not silently replaced", async () => {
  const { env, cwd } = fakeAgyEnv({
    stdout: fixture("resume-unknown-id.stdout.jsonl"),
    stderr: fixture("resume-unknown-id.stderr.txt"),
  });
  const agent = newAgent(env, cwd, "00000000-0000-0000-0000-000000000000");
  const events = await driveTurn(agent, "hi again");
  const notice = events.find((e) => e.ev === "error");
  assert.match(notice.data.message, /earlier conversation .* not found.*starts a new one/);
  assert.equal(agent.sessionId, "c06b644c-5c67-4fb3-83b5-de861c993547");
  assert.equal(events.find((e) => e.ev === "turn_done").data.is_error, false, "the reply itself still lands");
});

test("a Gemini API key in the environment never reaches agy (it would bypass the signed-in plan)", async () => {
  const { env, cwd } = fakeAgyEnv({ stdout: fixture("claude-tools.stdout.jsonl") });
  const agent = newAgent(env, cwd);
  assert.equal(agent._env.GEMINI_API_KEY, undefined);
  agent.stop();
});

test("output that is not agy's stream fails loudly, never silently", async () => {
  const { env, cwd } = fakeAgyEnv({ text: "not json at all\n", exit: 1 });
  const agent = newAgent(env, cwd);
  const events = await driveTurn(agent, "hi");
  assert.ok(events.some((e) => e.ev === "error"));
  assert.equal(events.find((e) => e.ev === "turn_done").data.is_error, true);
});

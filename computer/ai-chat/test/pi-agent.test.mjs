/**
 * SHE-114: Pi replaces OpenCode as the included-models agent. PiAgent drives
 * `pi --mode rpc`; these tests run it against a fake `pi` (fixtures/fake-pi.mjs)
 * that speaks the RPC protocol and logs what it was sent.
 *
 * Run: node --test computer/ai-chat/test/pi-agent.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "st-pi-agent-"));
process.env.HOME = FAKE_HOME;
const BIN = join(FAKE_HOME, "bin");
mkdirSync(BIN);
symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs"), join(BIN, "pi"));

// A built layer, as api/services/agent_layer.py writes it.
const LAYER = join(FAKE_HOME, ".shellteam", "agent-layer");
mkdirSync(join(LAYER, "pi"), { recursive: true });
writeFileSync(join(LAYER, "pi", "shellteam.ts"), "// extension\n");
writeFileSync(join(LAYER, "pi", "layer.json"), JSON.stringify({ provider: {}, mcpServers: {} }));
writeFileSync(join(LAYER, "system-prompt.md"), "be good\n");
writeFileSync(join(LAYER, "layer.json"), JSON.stringify({ modules: ["persona"], artifacts: { pi_layer: true, claude_system_prompt: true } }));

const { PiAgent } = await import("../lib/pi-agent.mjs");
const { piModel } = await import("../lib/model-catalog.mjs");

let n = 0;
const live = [];
// A failed assertion must not leave a fake Pi running: it would hold the run open.
after(() => { for (const a of live) a.stop(); });
function makeAgent(opts = {}) {
  const log = join(FAKE_HOME, `pi-${++n}.log`);
  const agent = new PiAgent({
    sessionId: opts.sessionId ?? null,
    model: opts.model ?? "glm-5p3",
    cwd: FAKE_HOME,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAKE_PI_LOG: log, ...opts.env },
  });
  live.push(agent);
  const events = [];
  for (const type of ["init", "text_delta", "text_done", "tool_start", "tool_input", "tool_result", "turn_done", "error", "session_event"]) {
    agent.on(type, (data) => events.push({ type, ...data }));
  }
  const records = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const commands = () => records().filter((r) => r.cmd).map((r) => r.cmd);
  return { agent, events, records, commands };
}

async function until(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(20);
  }
  throw new Error("timed out waiting");
}

const turns = (events) => events.filter((e) => e.type === "turn_done");

test("a turn streams text and tools live and ends with Pi's own cost and context", async () => {
  const { agent, events, records } = makeAgent();
  agent.start();
  agent.sendMessage("hi");
  await until(() => turns(events).length === 1);

  const init = events.find((e) => e.type === "init");
  assert.match(init.sessionId, /^pi-[0-9a-f-]{36}$/);
  assert.deepEqual(events.filter((e) => e.type === "text_delta").map((e) => e.text), ["Hel", "lo there"],
    "deltas arrive one by one, and a Unicode line separator does not split a record");
  assert.equal(events.find((e) => e.type === "text_done").text, "Hello there");
  assert.deepEqual(events.find((e) => e.type === "tool_start"), { type: "tool_start", id: "call_1", name: "Bash" });
  assert.deepEqual(events.find((e) => e.type === "tool_input").input, { command: "ls" });
  assert.equal(events.filter((e) => e.type === "tool_start").length, 1, "one tool card per call");
  assert.deepEqual(events.find((e) => e.type === "tool_result"), { type: "tool_result", id: "call_1", content: "a.txt" });
  assert.deepEqual(turns(events)[0], { type: "turn_done", cost: 0.12, usage: { input_tokens: 1234 }, context_window: 1048576 });

  const { argv, env } = records()[0];
  const upstream = piModel("glm-5p3").upstream;
  assert.deepEqual(argv.slice(0, 8), ["--mode", "rpc", "--provider", "shellteam", "--model", upstream, "--thinking", "max"]);
  assert.equal(argv[argv.indexOf("-e") + 1], join(LAYER, "pi", "shellteam.ts"));
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], join(LAYER, "system-prompt.md"));
  assert.equal(argv[argv.indexOf("--session-id") + 1], init.sessionId);
  assert.deepEqual(env, { SHELLTEAM_PI_LAYER: join(LAYER, "pi", "layer.json"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
  agent.stop();
});

test("a fast turn whose answer and events arrive in one chunk still ends", async () => {
  const { agent, events } = makeAgent({ env: { FAKE_PI_ONECHUNK: "1" } });
  agent.start();
  agent.sendMessage("hi");
  await until(() => turns(events).length === 1, 5000);
  agent.stop();
});

test("a resumed chat reopens its own session id", async () => {
  const { agent, events, records } = makeAgent({ sessionId: "pi-1234" });
  agent.start();
  agent.sendMessage("again");
  await until(() => turns(events).length === 1);
  const { argv } = records()[0];
  assert.equal(argv[argv.indexOf("--session-id") + 1], "pi-1234");
  assert.equal(events.find((e) => e.type === "init").sessionId, "pi-1234");
  agent.stop();
});

test("a message sent mid-turn steers the running turn, in the same process", async () => {
  const { agent, events, commands, records } = makeAgent();
  agent.start();
  agent.sendMessage("SLOW one");
  await until(() => events.some((e) => e.type === "tool_result"));
  agent.sendMessage("and then this");
  await until(() => commands().filter((c) => c.type === "prompt").length === 2);
  const prompts = commands().filter((c) => c.type === "prompt");
  assert.equal(prompts[0].streamingBehavior, undefined);
  assert.equal(prompts[1].streamingBehavior, "steer", "a mid-turn message is read by the running turn (SHE-126)");
  assert.equal(records().filter((r) => r.argv).length, 1, "no second Pi process");
  assert.equal(agent.isGenerating, true);
  agent.stop();
});

test("two messages back-to-back: the second waits for Pi's run to start, then queues behind the first; one turn answers both", async () => {
  const { agent, events, commands } = makeAgent({ env: { FAKE_PI_SLOWSTART: "1" } });
  agent.start();
  agent.sendMessage("first");
  agent.sendMessage("second");
  await until(() => turns(events).length === 1);
  await sleep(300);
  assert.equal(turns(events).length, 1, "one turn");
  assert.ok(events.some((e) => e.type === "text_done" && e.text === "answer to: second"), "the second message is answered");
  const prompts = commands().filter((c) => c.type === "prompt");
  assert.deepEqual(prompts.map((c) => c.streamingBehavior), [undefined, "followUp"]);
  agent.stop();
});

test("Stop aborts the run, drops its late output, and the next message waits for the abort", async () => {
  const { agent, events, commands } = makeAgent();
  agent.start();
  agent.sendMessage("SLOW one");
  await until(() => events.some((e) => e.type === "tool_result"));
  agent.interrupt();
  assert.equal(turns(events).at(-1).subtype, "interrupted");
  agent.sendMessage("next");
  await until(() => turns(events).length === 2);
  const types = commands().map((c) => c.type);
  assert.ok(types.indexOf("abort") < types.lastIndexOf("prompt"), "the next prompt goes after the abort");
  assert.ok(types.includes("clear_queue"), "queued follow-ups are dropped");
  assert.ok(!events.some((e) => e.type === "text_delta" && e.text === "LATE"), "the aborted run's late text never reaches the chat");
  assert.equal(turns(events).length, 2, "the aborted run's settle does not end the next turn");
  agent.stop();
});

test("/compact runs Pi's compaction and reports it", async () => {
  const { agent, events, commands } = makeAgent({ sessionId: "pi-compact" });
  agent.start();
  agent.sendMessage("/compact");
  await until(() => turns(events).length === 1);
  assert.ok(commands().some((c) => c.type === "compact"));
  assert.ok(!commands().some((c) => c.type === "prompt"), "/compact is not sent as a prompt");
  assert.equal(events.filter((e) => e.type === "session_event" && e.event === "compacted").length, 1);
  agent.stop();
});

test("/compact on a chat too small to compact is a quiet no-op, not an error", async () => {
  const { agent, events } = makeAgent({ env: { FAKE_PI_TINY: "1" } });
  agent.start();
  agent.sendMessage("/compact");
  await until(() => turns(events).length === 1);
  assert.equal(turns(events)[0].is_error, undefined);
  assert.equal(events.filter((e) => e.type === "error").length, 0);
  agent.stop();
});

test("a provider error ends the turn as an error with Pi's message", async () => {
  const { agent, events } = makeAgent();
  agent.start();
  agent.sendMessage("ERR please");
  await until(() => turns(events).length === 1);
  const done = turns(events)[0];
  assert.equal(done.is_error, true);
  assert.deepEqual(done.errors, ["429 Too Many Requests"]);
  agent.stop();
});

test("Pi dying mid-turn ends the turn loudly and marks the agent dead for a restart", async () => {
  const { agent, events } = makeAgent();
  agent.start();
  agent.sendMessage("CRASH");
  await until(() => turns(events).length === 1);
  assert.equal(turns(events)[0].is_error, true);
  assert.match(events.find((e) => e.type === "error").message, /Pi exited unexpectedly.*boom: provider exploded/);
  assert.equal(agent.isDead, true);
});

test("a model Pi doesn't run fails loudly instead of spawning", async () => {
  const { agent, events, records } = makeAgent({ model: "not-a-pi-model" });
  agent.start();
  await until(() => turns(events).length === 1);
  assert.match(events.find((e) => e.type === "error").message, /not one of Pi's models/);
  assert.equal(records().length, 0);
  assert.equal(agent.isDead, true);
});

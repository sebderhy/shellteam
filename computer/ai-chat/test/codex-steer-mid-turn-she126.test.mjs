/**
 * SHE-126 — in Codex's terminal UI a message sent while it works joins the
 * running turn; in the cockpit it waited for the turn to end (seat #18: two
 * messages waited 22 minutes and were never read). The cockpit ran `codex
 * exec`, which has no input channel once a turn starts.
 *
 * Codex now runs through `codex app-server`, still one process per turn, and a
 * mid-turn message goes to the running turn with turn/steer. These tests drive
 * the real spawn/close path against a fake app-server on PATH.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { CodexAgent, turnErrorMessage } from "../lib/codex-agent.mjs";
import { fakeCodex } from "./fixtures/fake-codex.mjs";

async function settled(dones, n, ms = 8000) {
  const deadline = Date.now() + ms;
  while (dones.length < n && Date.now() < deadline) await sleep(25);
}

test("a message sent mid-turn joins the running turn: one process, one turn, the agent reads it", async () => {
  const fake = fakeCodex({ TURN_MS: 600 });
  const agent = new CodexAgent({ model: "gpt-6-luna", cwd: fake.dir, env: fake.env });
  agent.start();
  const dones = [], texts = [];
  agent.on("turn_done", (d) => dones.push(d));
  agent.on("text_done", (t) => texts.push(t.text));
  try {
    agent.sendMessage("first");
    await once(agent, "text_done");
    agent.sendMessage("also do this");
    await settled(dones, 1);
    await sleep(300);   // a wrongly queued message would start a second turn here

    assert.equal(dones.length, 1, "a steered message must not become a turn of its own");
    assert.ok(!dones[0].is_error);
    assert.deepEqual(texts, ["reply to first", "steered: also do this"]);
    const records = fake.records();
    assert.equal(records.filter((r) => r.argv).length, 1, "one codex process for the whole exchange");
    const steer = records.find((r) => r.method === "turn/steer");
    assert.ok(steer, "the message went in with turn/steer");
    assert.equal(steer.params.expectedTurnId, "turn-1", "steered into the turn that is running");
    assert.equal(steer.params.input[0].text, "also do this");
    assert.deepEqual(agent._steered, [], "the turn read it");
    assert.deepEqual(agent._queued, []);
  } finally {
    agent.stop();
    fake.cleanup();
  }
});

test("the prompt travels in turn/start, never argv; the thread runs without approvals or sandbox", async () => {
  // SHE-67: a prompt starting with "- " used to be parsed as a CLI flag.
  const fake = fakeCodex();
  const agent = new CodexAgent({ model: "gpt-6-luna", cwd: fake.dir, env: fake.env });
  agent.start();
  try {
    const done = once(agent, "turn_done");
    agent.sendMessage("- Remove the dev->main PR for now.");
    const [result] = await done;
    assert.ok(!result.is_error);
    assert.equal(result.usage.input_tokens, 1234, "the turn's thread/tokenUsage feeds the meter when no rollout exists");
    const records = fake.records();
    const { argv } = records.find((r) => r.argv);
    assert.deepEqual(argv.slice(0, 2), ["app-server", "--stdio"]);
    assert.ok(!argv.join(" ").includes("Remove the dev->main"), "the prompt must not appear in argv");
    const start = records.find((r) => r.method === "thread/start");
    assert.equal(start.params.approvalPolicy, "never");
    assert.equal(start.params.sandbox, "danger-full-access");
    assert.equal(start.params.model, "gpt-6-luna");
    assert.equal(records.find((r) => r.method === "turn/start").params.input[0].text, "- Remove the dev->main PR for now.");
  } finally {
    agent.stop();
    fake.cleanup();
  }
});

test("a turn that ends before reading a steered message runs it as the next turn", () => {
  const agent = new CodexAgent({ model: "gpt-6-luna", cwd: "/tmp", env: {} });
  agent.start();
  agent._isGenerating = true;
  agent._activeTurnId = "turn-1";
  agent._steered = [{ clientId: "steer-1", prompt: "late one" }];
  agent._translate = () => {};
  agent._fromAppServer("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  assert.deepEqual(agent._queued, ["late one"]);
  assert.deepEqual(agent._steered, []);
});

test("no steering into a /compact turn, a recovery, or a turn not started yet", () => {
  const agent = new CodexAgent({ model: "gpt-6-luna", cwd: "/tmp", env: {} });
  agent.start();
  const steers = [];
  agent._process = { pid: 999, killed: true, rpc: { request: (m, p) => { steers.push(p); return new Promise(() => {}); } } };
  agent._isGenerating = true;
  agent._threadId = "t";

  assert.equal(agent._steer("x"), false, "no turn id yet: the turn hasn't started");
  agent._activeTurnId = "turn-1";
  agent._compactTurn = true;
  assert.equal(agent._steer("x"), false, "a compaction turn can't be steered");
  agent._compactTurn = false;
  agent._recovery = { phase: "compacting" };
  assert.equal(agent._steer("x"), false, "an overflow recovery owns the turn");
  agent._recovery = null;
  assert.equal(agent._steer("/compact"), false, "/compact is its own turn");
  assert.equal(agent._steer("go on"), true);
  assert.equal(steers.length, 1);
});

test("Stop drops steered messages the turn hasn't read, and reports them undelivered", () => {
  const agent = new CodexAgent({ model: "gpt-6-luna", cwd: "/tmp", env: {} });
  agent.start();
  const dones = [];
  agent.on("turn_done", (d) => dones.push(d));
  agent._isGenerating = true;
  agent._turnHeard = true;
  agent._steered = [{ clientId: "steer-1", prompt: "unread" }];
  agent.interrupt();
  assert.deepEqual(agent._steered, []);
  assert.equal(dones[0].undelivered, true, "the unread message is not part of the conversation");
});

test("turn errors read as text, and a context overflow always reads as one (SHE-66 recovery)", () => {
  const raw = JSON.stringify({ type: "error", status: 400, error: { message: "The 'x' model is not supported." } });
  assert.equal(turnErrorMessage({ message: raw }), "The 'x' model is not supported.");
  assert.equal(turnErrorMessage({ message: "stream disconnected" }), "stream disconnected");
  assert.match(turnErrorMessage({ message: "input too long", codexErrorInfo: "contextWindowExceeded" }), /ran out of room/);
});

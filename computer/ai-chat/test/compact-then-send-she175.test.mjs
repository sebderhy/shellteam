// SHE-175: "Compact & send". On a long chat one click compacts the
// conversation and then delivers the message. The message must wait for the
// compaction turn to end, and must never be lost on the way.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-she175-"));
const sm = await import("../lib/session-manager.mjs");
const { HOME } = await import("../lib/constants.mjs");
sm.setBroadcast(() => {});

// A stand-in agent that records what it is sent and lets the test end a turn.
function fakeAgents() {
  const agents = [];
  sm._testSetAgentFactory(() => {
    const handlers = {};
    const agent = {
      sent: [],
      on(event, fn) { handlers[event] = fn; },
      emit(event, data) { handlers[event]?.(data); },
      start() {}, stop() {}, interrupt() {},
      sendMessage(content) { this.sent.push(content); },
    };
    agents.push(agent);
    return agent;
  });
  return agents;
}

let nextSlot = 30;
function slotWithSession() {
  const id = nextSlot++;
  const sessionId = `${String(id).repeat(4)}-1111-4111-8111-111111111111`.padStart(36, "a");
  mkdirSync(join(HOME, ".claude", "projects", "-p"), { recursive: true });
  writeFileSync(join(HOME, ".claude", "projects", "-p", `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", sessionId, cwd: HOME, message: { role: "user", content: "hi" } }) + "\n");
  sm.createSlot(id, { model: "claude-opus-5-5", cwd: HOME });
  sm.setSessionId(id, sessionId);
  return id;
}

test("the message is delivered only after the compaction turn ends", async () => {
  const agents = fakeAgents();
  const id = slotWithSession();
  await sm.compactThenSend(id, "now something new");
  const agent = agents.at(-1);
  assert.deepEqual(agent.sent, ["/compact"]);

  agent.emit("turn_done", {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(agent.sent, ["/compact", "now something new"]);

  agent.emit("turn_done", {});   // the reply's own turn: nothing is sent twice
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.sent.length, 2);
});

test("pressing Stop during the compaction cancels the queued message", async () => {
  const agents = fakeAgents();
  const id = slotWithSession();
  await sm.compactThenSend(id, "never mind");
  agents.at(-1).emit("turn_done", { subtype: "interrupted" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(agents.at(-1).sent, ["/compact"]);
});

test("with no conversation to compact the message is simply sent", async () => {
  const agents = fakeAgents();
  const id = nextSlot++;
  sm.createSlot(id, { model: "claude-opus-5-5", cwd: HOME });
  await sm.compactThenSend(id, "first message");
  assert.deepEqual(agents.at(-1).sent, ["first message"]);
});

test("the button only offers itself on a long, idle conversation", () => {
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/app.js"), "utf8");
  const m = app.match(/const COMPACT_HINT_TOKENS = ([\d_]+);\n\nfunction canCompactSend\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, "app.js must define COMPACT_HINT_TOKENS and canCompactSend");
  const make = (S, slot) => new Function("S", "sessionSlots", "activeSlotId", `${m[0]}\nreturn canCompactSend();`)(S, [slot], 1);
  assert.equal(make({ sessionId: "x", isGenerating: false }, { id: 1, contextTokens: 250_000 }), true);
  assert.equal(make({ sessionId: "x", isGenerating: false }, { id: 1, contextTokens: 150_000 }), false);
  assert.equal(make({ sessionId: "x", isGenerating: true }, { id: 1, contextTokens: 250_000 }), false, "compacting would stop a running agent");
  assert.equal(make({ sessionId: null, isGenerating: false }, { id: 1, contextTokens: 250_000 }), false);
});

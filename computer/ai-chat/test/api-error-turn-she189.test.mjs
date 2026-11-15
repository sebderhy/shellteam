// SHE-189: a Claude API error (here a Cloudflare 403 in front of the API) ended
// a turn mid-work. Claude Code reports it as a SYNTHETIC assistant message
// ("Failed to authenticate. API Error: 403 …", is_api_error_message) followed
// by `result` with is_error:true but no `errors` list. The cockpit rendered the
// synthetic text as if the agent had said it, showed no error, and nothing
// resumed the work: the tab sat "stuck" for 3 hours until the user asked.
// Shapes below are copied from a real `claude -p --output-format stream-json`
// run against a server answering 403 (Claude Code 2.1.321).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-she189-"));
const { ClaudeCliAgent } = await import("../lib/claude-cli-agent.mjs");
const { readSessionForReplay } = await import("../lib/history.mjs");

const ERROR_TEXT = "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";
const SYNTHETIC = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: ERROR_TEXT }] },
  parent_tool_use_id: null, error: "authentication_failed", is_api_error_message: true, api_error_status: 403,
};
const RESULT = { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 403, result: ERROR_TEXT, total_cost_usd: 0 };

function makeAgent() {
  const agent = new ClaudeCliAgent({ sessionId: null, model: "claude-opus-5-5", cwd: tmpdir(), env: {} });
  agent._isActive = true;
  const events = [];
  for (const t of ["text_done", "turn_done"]) agent.on(t, (e) => events.push({ t, ...e }));
  const feed = (msg) => agent._processLine(JSON.stringify(msg));
  const cleanup = () => { agent._clearWatchdog(); agent._clearIdleTimer(); };
  return { agent, events, feed, cleanup };
}

test("live: an API error ends the turn as an error, not as words the agent said", () => {
  const { events, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feed(SYNTHETIC);
  feed(RESULT);
  cleanup();
  assert.equal(events.filter((e) => e.t === "text_done").length, 0, "the synthetic error text is not an agent message");
  const done = events.filter((e) => e.t === "turn_done");
  assert.equal(done.length, 1);
  assert.equal(done[0].is_error, true);
  assert.deepEqual(done[0].errors, [ERROR_TEXT], "the error reaches the chat's red notice");
  assert.deepEqual(done[0].api_error, { status: 403 }, "the session manager can decide whether to retry");
});

test("live: a result that already lists errors keeps them", () => {
  const { events, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feed({ type: "result", is_error: true, errors: ["boom"], result: "other" });
  cleanup();
  assert.deepEqual(events.find((e) => e.t === "turn_done").errors, ["boom"]);
});

test("replay: the transcript's API error line comes back as an error notice", () => {
  const file = join(process.env.HOME, "s.jsonl");
  const lines = [
    { type: "user", message: { role: "user", content: "fix it" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } },
    { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 403, error: "authentication_failed",
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: ERROR_TEXT }] } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const msgs = readSessionForReplay(file);
  assert.deepEqual(msgs.filter((m) => m.type === "text_done").map((m) => m.text), ["On it."]);
  const err = msgs.at(-1);
  assert.equal(err.type, "turn_done");
  assert.equal(err.is_error, true);
  assert.deepEqual(err.errors, [ERROR_TEXT]);
});

// --- recovery: the session manager resumes the turn once ---

class FakeAgent extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.sent = []; }
  start() {}
  sendMessage(content) { this.sent.push(content); }
  stop() {}
  interrupt() {}
  get isBroken() { return false; }
  get isDead() { return false; }
  get isGenerating() { return false; }
}

async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  const sentToBrowser = [];
  sm.setBroadcast((m) => sentToBrowser.push(m));
  sm._testSetApiErrorRetryDelay(0);
  const created = [];
  sm._testSetAgentFactory((opts) => { const a = new FakeAgent(opts); created.push(a); return a; });
  return { sm, created };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const apiErrorTurn = (status) => ({ is_error: true, errors: [ERROR_TEXT], api_error: { status } });

test("a turn killed by a transient API error is resumed once, with a notice", async () => {
  const { sm, created } = await freshSM();
  sm.createSlot(5, { model: "claude-opus-5-5" });
  await sm.startAgent(5);
  await sm.sendMessage(5, "fix it");
  const agent = created[0];
  agent.emit("turn_done", apiErrorTurn(403));
  await tick();
  assert.equal(agent.sent.length, 2, "one automatic resume");
  assert.match(agent.sent[1], /^<cockpit-notice>/);
  assert.match(agent.sent[1], /403/);
  assert.match(agent.sent[1], /carry on/i);
  assert.equal(sm.getHistory(5).at(-1).internal, true, "the resume shows as a system note");
  // The retry fails too: no second resume, the error notice stays for the user.
  agent.emit("turn_done", apiErrorTurn(403));
  await tick();
  assert.equal(agent.sent.length, 2, "never loops");
  // A good turn re-arms the retry for the next failure.
  agent.emit("turn_done", {});
  agent.emit("turn_done", apiErrorTurn(529));
  await tick();
  assert.equal(agent.sent.length, 3);
});

test("errors a retry cannot fix (rate limit, bad request, login) are not retried", async () => {
  const { sm, created } = await freshSM();
  sm.createSlot(6, { model: "claude-opus-5-5" });
  await sm.startAgent(6);
  await sm.sendMessage(6, "fix it");
  const agent = created[0];
  for (const status of [400, 401, 413, 429]) agent.emit("turn_done", apiErrorTurn(status));
  agent.emit("turn_done", { is_error: true, errors: ["CLI exited code=1"] });
  await tick();
  assert.equal(agent.sent.length, 1, "only the user's own message");
});

test("no resume when the owner has already sent something during the wait", async () => {
  const { sm, created } = await freshSM();
  sm._testSetApiErrorRetryDelay(40);
  sm.createSlot(7, { model: "claude-opus-5-5" });
  await sm.startAgent(7);
  await sm.sendMessage(7, "fix it");
  const agent = created[0];
  agent.emit("turn_done", apiErrorTurn(503));
  await sm.sendMessage(7, "never mind, do this instead");
  agent.emit("turn_done", {});
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(agent.sent.length, 2, "only the owner's two messages");
});

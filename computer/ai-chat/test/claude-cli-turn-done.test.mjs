// Regression tests for ClaudeCliAgent turn-completion tracking.
//
// Bug: the per-turn `_turnDoneEmitted` flag was reset at SEND time. When a user
// sent a message while a prior turn was still generating (Claude Code queues it),
// the prior turn's `result` flipped the flag true, and the queued turn's own
// `result` was then suppressed — leaving the UI stuck "working" until idle-kill.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { ClaudeCliAgent } from "../lib/claude-cli-agent.mjs";

function makeAgent() {
  const agent = new ClaudeCliAgent({ sessionId: null, model: "claude-opus-4-8", cwd: tmpdir(), env: {} });
  agent._isActive = true;
  const turnDones = [];
  agent.on("turn_done", (e) => turnDones.push(e));
  const feed = (msg) => agent._processLine(JSON.stringify(msg));
  const cleanup = () => { agent._clearWatchdog(); agent._clearIdleTimer(); };
  return { agent, turnDones, feed, cleanup };
}

test("each turn's `result` emits its own turn_done (queued messages don't get swallowed)", () => {
  const { turnDones, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  // Two turns complete back-to-back (the queued-message scenario): two results.
  feed({ type: "result", total_cost_usd: 0.01 });
  feed({ type: "result", total_cost_usd: 0.02 });
  cleanup();
  assert.equal(turnDones.length, 2, "both turns should emit turn_done");
});

test("end_turn + result for the SAME turn emits turn_done exactly once (no double-emit)", () => {
  const { turnDones, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  // Early end_turn path: a final assistant message with end_turn and no tool_use.
  feed({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } });
  // …followed by the authoritative `result` for the same turn.
  feed({ type: "result", total_cost_usd: 0.01 });
  cleanup();
  assert.equal(turnDones.length, 1, "one turn → one turn_done");
});

test("subagent results never emit a main turn_done", () => {
  const { turnDones, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feed({ type: "result", parent_tool_use_id: "tool_1", total_cost_usd: 0.01 });
  cleanup();
  assert.equal(turnDones.length, 0, "subagent result is not a main turn boundary");
});

// SHE-48: the context meter read "10584k · 100%" and never fell after /compact.
// Cause: `result.usage` SUMS cache_read across every internal round-trip in the
// turn (a 60-tool turn re-reads a 120k context 60× → millions of "tokens"). The
// meter needs the LAST API call's own usage — the real window occupancy.
const WINDOW = { input_tokens: 5, cache_read_input_tokens: 118000, cache_creation_input_tokens: 2000 }; // ~120k
const CUMULATIVE = { input_tokens: 500, cache_read_input_tokens: 10_000_000, cache_creation_input_tokens: 500_000 }; // ~10.5M

test("turn_done forwards the last call's usage, not the cumulative result.usage (result path)", () => {
  const { turnDones, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  // A multi-round-trip turn: several message_start events, each carrying that
  // call's own input usage. The final one is the true end-of-turn window.
  feed({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 40000, cache_creation_input_tokens: 5000 } } } });
  feed({ type: "stream_event", event: { type: "message_start", message: { usage: WINDOW } } });
  // The authoritative result carries the ballooned cumulative sum — must be ignored.
  feed({ type: "result", total_cost_usd: 0.02, usage: CUMULATIVE });
  cleanup();
  assert.equal(turnDones.length, 1);
  assert.deepEqual(turnDones[0].usage, WINDOW, "must be the last message_start usage, not the summed result.usage");
});

test("turn_done forwards the final assistant message's own usage (early end_turn path)", () => {
  const { agent, turnDones, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  agent._isGenerating = true; // the end_turn fast-path only fires mid-generation
  feed({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: WINDOW } });
  cleanup();
  assert.equal(turnDones.length, 1);
  assert.deepEqual(turnDones[0].usage, WINDOW, "end_turn path must forward the message's per-call usage");
});

test("a fresh turn's usage is not the previous turn's (cross-turn reset)", () => {
  const { turnDones, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feed({ type: "stream_event", event: { type: "message_start", message: { usage: WINDOW } } });
  feed({ type: "result", total_cost_usd: 0.01, usage: CUMULATIVE });
  // Next turn streams no message_start (rare no-stream case) — must NOT reuse the
  // prior turn's window; falls back to result.usage rather than stale state.
  feed({ type: "result", total_cost_usd: 0.02, usage: CUMULATIVE });
  cleanup();
  assert.equal(turnDones.length, 2);
  assert.deepEqual(turnDones[1].usage, CUMULATIVE, "no per-call usage this turn → fall back, don't reuse last turn's window");
});

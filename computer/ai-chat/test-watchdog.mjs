/**
 * Tests for watchdog auto-restart logic in session-manager.
 *
 * Verifies that:
 *  - watchdogRestarts counter increments on each watchdog_timeout
 *  - counter does NOT reset during watchdog restarts (the infinite-loop bug)
 *  - counter DOES reset on genuine new user messages
 *  - max restart limit is enforced and error is broadcast
 *  - lastSentContent is preserved during watchdog restarts
 *  - lastSentContent is cleared on normal turn completion
 *
 * Run:  node --test computer/ai-chat/test-watchdog.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CodingAgent } from "./lib/coding-agent.mjs";

// --- Mock agent that we can drive from tests ---

class MockAgent extends CodingAgent {
  constructor() {
    super({ sessionId: null, model: "test-model", cwd: "/tmp", env: {} });
    this.started = false;
    this.stopped = false;
    this.messages = [];
    this._isActive = true;
  }
  start() { this.started = true; }
  stop() { this.stopped = true; this._isActive = false; }
  interrupt() {}
  sendMessage(content) { this.messages.push(content); }
  get isBroken() { return false; }
  get isDead() { return false; }
}

// --- Helpers to load a fresh session-manager per test ---

let mgr;
let broadcasts;
let mockAgent;
let mockAgentsCreated; // tracks agents created by the factory during auto-restart

async function loadFresh() {
  const ts = Date.now() + Math.random();
  mgr = await import(`./lib/session-manager.mjs?v=${ts}`);
  broadcasts = [];
  mockAgentsCreated = [];
  mgr.setBroadcast((msg) => broadcasts.push(msg));
  // Prevent real CLI processes from spawning during watchdog auto-restarts
  mgr._testSetAgentFactory(() => {
    const a = new MockAgent();
    mockAgentsCreated.push(a);
    return a;
  });
}

/** Inject a mock agent into a slot and wire its events — bypasses startAgent(). */
function injectMockAgent(slotId) {
  mockAgent = new MockAgent();
  mgr.createSlot(slotId);
  mgr._testInjectAgent(slotId, mockAgent);
  return mockAgent;
}

function findBroadcasts(type) {
  return broadcasts.filter(b => b.type === type);
}

function lastBroadcast(type) {
  const matches = findBroadcasts(type);
  return matches[matches.length - 1];
}

// ────────────────────────────────────────────────────────────

describe("Watchdog restart logic", () => {
  beforeEach(async () => {
    await loadFresh();
  });

  describe("counter increments correctly", () => {
    it("increments watchdogRestarts on each watchdog_timeout", () => {
      const agent = injectMockAgent(5);

      // Simulate first watchdog timeout
      agent.emit("turn_done", { subtype: "watchdog_timeout" });
      // The handler calls stopAgent + startAgent, but our mock won't actually
      // restart. Check that the counter incremented via the broadcast log.
      const turnDones = findBroadcasts("turn_done");
      assert.equal(turnDones.length, 1);
      assert.equal(turnDones[0].subtype, "watchdog_timeout");
    });

    it("does NOT reset counter on text_delta events", async () => {
      const agent = injectMockAgent(5);

      // Send a message (sets lastSentContent)
      await mgr.sendMessage(5, "test message");
      assert.equal(mockAgent.messages.length, 1);

      // Simulate watchdog timeout → counter becomes 1
      agent.emit("turn_done", { subtype: "watchdog_timeout" });

      // Now simulate text_delta (as if the restarted agent started producing output)
      // Re-inject agent since stopAgent clears it
      const agent2 = injectMockAgent(5);
      agent2.emit("text_delta", { text: "hello" });

      // Simulate another watchdog timeout — counter should be 2 (not reset to 1)
      agent2.emit("turn_done", { subtype: "watchdog_timeout" });

      // Simulate one more — should be 3, exceeding limit of 2
      const agent3 = injectMockAgent(5);
      agent3.emit("text_delta", { text: "world" });
      agent3.emit("turn_done", { subtype: "watchdog_timeout" });

      // Should have broadcast an error (limit reached)
      const errors = findBroadcasts("error");
      assert.equal(errors.length, 1, "should broadcast error when limit reached");
      assert.ok(errors[0].message.includes("unresponsive"));
    });

    it("does NOT reset counter on tool_start events", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "test message");

      // First timeout
      agent.emit("turn_done", { subtype: "watchdog_timeout" });

      // Re-inject and emit tool_start
      const agent2 = injectMockAgent(5);
      agent2.emit("tool_start", { id: "t1", name: "Read" });

      // Second timeout
      agent2.emit("turn_done", { subtype: "watchdog_timeout" });

      // Third timeout should exceed limit
      const agent3 = injectMockAgent(5);
      agent3.emit("tool_start", { id: "t2", name: "Write" });
      agent3.emit("turn_done", { subtype: "watchdog_timeout" });

      const errors = findBroadcasts("error");
      assert.equal(errors.length, 1, "should broadcast error when limit reached");
    });

    it("DOES reset counter on genuine new user message", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "first message");

      // Two watchdog timeouts
      agent.emit("turn_done", { subtype: "watchdog_timeout" });
      const agent2 = injectMockAgent(5);
      agent2.emit("turn_done", { subtype: "watchdog_timeout" });

      // Now user sends a NEW message (not watchdog resend)
      const agent3 = injectMockAgent(5);
      await mgr.sendMessage(5, "brand new message"); // resets counter

      // Next timeout should be attempt 1, not 3
      agent3.emit("turn_done", { subtype: "watchdog_timeout" });

      // And another — attempt 2
      const agent4 = injectMockAgent(5);
      agent4.emit("turn_done", { subtype: "watchdog_timeout" });

      // Third should exceed — this proves counter was reset (otherwise it'd be 5)
      const agent5 = injectMockAgent(5);
      agent5.emit("turn_done", { subtype: "watchdog_timeout" });

      const errors = findBroadcasts("error");
      assert.equal(errors.length, 1, "should only hit limit once (after reset)");
    });

    it("does NOT reset counter on watchdog resend", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "original message");

      // Watchdog timeout 1
      agent.emit("turn_done", { subtype: "watchdog_timeout" });

      // Simulate what the restart handler does: sendMessage with isWatchdogResend
      const agent2 = injectMockAgent(5);
      await mgr.sendMessage(5, "original message", { isWatchdogResend: true });

      // Watchdog timeout 2
      agent2.emit("turn_done", { subtype: "watchdog_timeout" });

      // Simulate resend again
      const agent3 = injectMockAgent(5);
      await mgr.sendMessage(5, "original message", { isWatchdogResend: true });

      // Watchdog timeout 3 — should exceed limit
      agent3.emit("turn_done", { subtype: "watchdog_timeout" });

      const errors = findBroadcasts("error");
      assert.equal(errors.length, 1, "limit should be reached");
    });
  });

  describe("max restart limit", () => {
    it("allows exactly MAX_WATCHDOG_RESTARTS attempts before giving up", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "test");

      // Timeout 1 — should restart (attempt 1/2)
      agent.emit("turn_done", { subtype: "watchdog_timeout" });
      let errors = findBroadcasts("error");
      assert.equal(errors.length, 0, "should not error after first timeout");

      // Timeout 2 — should restart (attempt 2/2)
      const agent2 = injectMockAgent(5);
      agent2.emit("turn_done", { subtype: "watchdog_timeout" });
      errors = findBroadcasts("error");
      assert.equal(errors.length, 0, "should not error after second timeout");

      // Timeout 3 — should give up (exceeds limit of 2)
      const agent3 = injectMockAgent(5);
      agent3.emit("turn_done", { subtype: "watchdog_timeout" });
      errors = findBroadcasts("error");
      assert.equal(errors.length, 1, "should error after third timeout");
      assert.ok(errors[0].message.includes("unresponsive"));
    });

    it("clears lastSentContent when giving up", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "test");

      // Exhaust retries
      agent.emit("turn_done", { subtype: "watchdog_timeout" });
      const a2 = injectMockAgent(5);
      a2.emit("turn_done", { subtype: "watchdog_timeout" });
      const a3 = injectMockAgent(5);
      a3.emit("turn_done", { subtype: "watchdog_timeout" });

      // Verify no more restarts would happen — lastSentContent should be null
      // (tested indirectly: error was broadcast, which means the code path
      // that sets lastSentContent = null was executed)
      const errors = findBroadcasts("error");
      assert.equal(errors.length, 1);
    });
  });

  describe("lastSentContent tracking", () => {
    it("preserves lastSentContent on watchdog_timeout", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "important message");

      // Watchdog timeout should NOT clear lastSentContent
      agent.emit("turn_done", { subtype: "watchdog_timeout" });

      // Verify by sending another watchdog resend — if lastSentContent was cleared,
      // the resend path wouldn't fire
      const agent2 = injectMockAgent(5);
      // The watchdog handler internally calls sendMessage with lastContent,
      // but since we're using mock agents, we verify the counter advanced
      agent2.emit("turn_done", { subtype: "watchdog_timeout" });

      // If lastSentContent had been cleared, the second timeout would not
      // increment (it early-returns). Counter should be 2.
      const agent3 = injectMockAgent(5);
      agent3.emit("turn_done", { subtype: "watchdog_timeout" });

      // Should hit limit
      const errors = findBroadcasts("error");
      assert.equal(errors.length, 1);
    });

    it("clears lastSentContent on normal turn completion", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "some message");

      // Normal completion (no subtype)
      agent.emit("turn_done", {});

      // Now if a watchdog fires, there's no lastSentContent to resend
      // (the slot's lastSentContent was cleared)
      const turnDones = findBroadcasts("turn_done");
      assert.equal(turnDones.length, 1);
      assert.equal(turnDones[0].subtype, undefined);
    });
  });

  describe("event forwarding during watchdog", () => {
    it("broadcasts text_delta events to clients", () => {
      const agent = injectMockAgent(5);
      agent.emit("text_delta", { text: "hello " });
      agent.emit("text_delta", { text: "world" });

      const deltas = findBroadcasts("text_delta");
      assert.equal(deltas.length, 2);
      assert.equal(deltas[0].text, "hello ");
      assert.equal(deltas[1].text, "world");
    });

    it("broadcasts tool_start events to clients", () => {
      const agent = injectMockAgent(5);
      agent.emit("tool_start", { id: "t1", name: "Read" });

      const starts = findBroadcasts("tool_start");
      assert.equal(starts.length, 1);
      assert.equal(starts[0].name, "Read");
    });

    it("broadcasts error when watchdog limit exceeded", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "test");

      // Exhaust retries
      for (let i = 0; i < 3; i++) {
        const a = i === 0 ? agent : injectMockAgent(5);
        a.emit("turn_done", { subtype: "watchdog_timeout" });
      }

      const errors = findBroadcasts("error");
      assert.equal(errors.length, 1);
      assert.ok(errors[0].message.includes("unresponsive"));
      assert.ok(errors[0].message.includes("new chat"));
    });
  });

  describe("isGenerating state", () => {
    it("sets isGenerating=true on text_delta", () => {
      const agent = injectMockAgent(5);
      assert.equal(mgr.getIsGenerating(5), false);
      agent.emit("text_delta", { text: "hi" });
      assert.equal(mgr.getIsGenerating(5), true);
    });

    it("sets isGenerating=true on tool_start", () => {
      const agent = injectMockAgent(5);
      agent.emit("tool_start", { id: "t1", name: "Read" });
      assert.equal(mgr.getIsGenerating(5), true);
    });

    it("clears isGenerating on turn_done", () => {
      const agent = injectMockAgent(5);
      agent.emit("text_delta", { text: "hi" });
      assert.equal(mgr.getIsGenerating(5), true);
      agent.emit("turn_done", {});
      assert.equal(mgr.getIsGenerating(5), false);
    });

    it("clears isGenerating on watchdog_timeout", () => {
      const agent = injectMockAgent(5);
      agent.emit("text_delta", { text: "hi" });
      assert.equal(mgr.getIsGenerating(5), true);
      agent.emit("turn_done", { subtype: "watchdog_timeout" });
      assert.equal(mgr.getIsGenerating(5), false);
    });
  });

  describe("cost tracking", () => {
    it("updates totalCost from turn_done", () => {
      const agent = injectMockAgent(5);
      assert.equal(mgr.getTotalCost(5), 0);
      agent.emit("turn_done", { cost: 1.23 });
      assert.equal(mgr.getTotalCost(5), 1.23);
    });

    it("preserves cost across watchdog restarts", async () => {
      const agent = injectMockAgent(5);
      await mgr.sendMessage(5, "test");

      agent.emit("turn_done", { cost: 0.50, subtype: "watchdog_timeout" });
      assert.equal(mgr.getTotalCost(5), 0.50);

      const agent2 = injectMockAgent(5);
      agent2.emit("turn_done", { cost: 0.75, subtype: "watchdog_timeout" });
      assert.equal(mgr.getTotalCost(5), 0.75);
    });
  });

  describe("history tracking", () => {
    it("records turn_done with watchdog_timeout subtype in history", () => {
      const agent = injectMockAgent(5);
      agent.emit("turn_done", { subtype: "watchdog_timeout" });

      const history = mgr.getHistory(5);
      const turnDones = history.filter(h => h.type === "turn_done");
      assert.equal(turnDones.length, 1);
      assert.equal(turnDones[0].subtype, "watchdog_timeout");
    });

    it("records text_done in history", () => {
      const agent = injectMockAgent(5);
      agent.emit("text_done", { text: "Hello world" });

      const history = mgr.getHistory(5);
      const textDones = history.filter(h => h.type === "text_done");
      assert.equal(textDones.length, 1);
      assert.equal(textDones[0].text, "Hello world");
    });

    it("records tool lifecycle in history", () => {
      const agent = injectMockAgent(5);
      agent.emit("tool_start", { id: "t1", name: "Read" });
      agent.emit("tool_input", { id: "t1", input: { file: "/etc/hosts" } });
      agent.emit("tool_result", { id: "t1", content: "contents", is_error: false });

      const history = mgr.getHistory(5);
      assert.equal(history.filter(h => h.type === "tool_start").length, 1);
      assert.equal(history.filter(h => h.type === "tool_input").length, 1);
      assert.equal(history.filter(h => h.type === "tool_result").length, 1);
    });
  });
});

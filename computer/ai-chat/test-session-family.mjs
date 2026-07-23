/**
 * Tests for cross-agent-family session safety.
 *
 * Session IDs are agent-family-specific (Codex thread IDs ≠ Claude UUIDs ≠
 * OpenCode ses_…). Resuming a session with the wrong CLI fails with
 * "No conversation found with session ID". These tests verify the two guards
 * that prevent a cross-family pairing from ever reaching the CLI:
 *
 *   1. familyOfSession() correctly classifies a session ID by its on-disk home.
 *   2. startAgent() drops an orphaned session whose family ≠ the slot's model.
 *   3. wireAgentEvents() ignores events from a stale (replaced) agent, so a
 *      killed Codex process can't re-pin its thread ID onto a Claude slot.
 *
 * Run:  node --test computer/ai-chat/test-session-family.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgent } from "./lib/coding-agent.mjs";

// constants.mjs freezes HOME at first import — set it once, before any (dynamic)
// import, and keep the same dir for every test so the path-based helpers resolve.
const tempHome = mkdtempSync(join(tmpdir(), "family-test-"));
process.env.HOME = tempHome;

let history;
let mgr;

class MockAgent extends CodingAgent {
  constructor(opts = {}) {
    super({ sessionId: opts.sessionId ?? null, model: opts.model ?? "test-model", cwd: opts.cwd ?? "/tmp", env: {} });
    this.startSessionId = opts.sessionId ?? null;
    this._isActive = true;
  }
  start() {}
  stop() { this._isActive = false; }
  interrupt() {}
  sendMessage() {}
  get isBroken() { return false; }
  get isDead() { return false; }
}

async function loadModules() {
  const ts = Date.now() + Math.random();
  history = await import(`./lib/history.mjs?v=${ts}`);
  mgr = await import(`./lib/session-manager.mjs?v=${ts}`);
  mgr.setBroadcast(() => {});
}

function writeCodexSession(sessionId) {
  const dir = join(tempHome, ".config", "shellteam", "codex-history");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "session_meta", model: "gpt-5.5", cwd: tempHome }) + "\n");
}

function writeClaudeSession(sessionId) {
  const dir = join(tempHome, ".claude", "projects", "-home-user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
}

describe("Cross-family session safety", () => {
  beforeEach(async () => {
    // Wipe per-test state but keep the same HOME dir (frozen in constants.mjs).
    rmSync(join(tempHome, ".claude"), { recursive: true, force: true });
    rmSync(join(tempHome, ".config"), { recursive: true, force: true });
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    await loadModules();
  });

  describe("familyOfSession", () => {
    it("classifies a Codex thread by its history file", () => {
      writeCodexSession("019eb6b2-2e96-79d2-ad96-971642f4ea26");
      assert.equal(history.familyOfSession("019eb6b2-2e96-79d2-ad96-971642f4ea26"), "codex");
    });

    it("classifies a Claude session by its projects file", () => {
      writeClaudeSession("7ea43598-583d-4af1-aebc-a3849c64045a");
      assert.equal(history.familyOfSession("7ea43598-583d-4af1-aebc-a3849c64045a"), "claude");
    });

    it("classifies an OpenCode session by its ses_ prefix", () => {
      assert.equal(history.familyOfSession("ses_19c8ef078ffe40JjcprDWGPHvn"), "opencode");
    });

    it("returns null for an unknown / unclassifiable id", () => {
      assert.equal(history.familyOfSession("totally-unknown-id"), null);
      assert.equal(history.familyOfSession(null), null);
    });
  });

  describe("startAgent family backstop", () => {
    it("drops a Codex session when the slot's model is Claude", async () => {
      const codexId = "019eb6b2-2e96-79d2-ad96-971642f4ea26";
      writeCodexSession(codexId);

      let spawnedWith = null;
      mgr._testSetAgentFactory((opts) => { spawnedWith = opts; return new MockAgent(opts); });

      // Simulate the corrupted state: Claude model paired with a Codex thread id.
      mgr.createSlot(2, { model: "claude-opus-4-8" });
      mgr.setSessionId(2, codexId);

      await mgr.startAgent(2);

      assert.equal(spawnedWith.sessionId, null, "agent must NOT be spawned with the cross-family session id");
      assert.equal(mgr.getSessionId(2), null, "orphaned session must be cleared from slot state");
    });

    it("keeps a Codex session when the slot's model is Codex", async () => {
      const codexId = "019eb6b2-2e96-79d2-ad96-971642f4ea26";
      writeCodexSession(codexId);

      let spawnedWith = null;
      mgr._testSetAgentFactory((opts) => { spawnedWith = opts; return new MockAgent(opts); });

      mgr.createSlot(2, { model: "gpt-5.5" });
      mgr.setSessionId(2, codexId);

      await mgr.startAgent(2);

      assert.equal(spawnedWith.sessionId, codexId, "matching-family session must be preserved for resume");
      assert.equal(mgr.getSessionId(2), codexId);
    });

    it("keeps an unclassifiable session id (cannot prove a mismatch)", async () => {
      let spawnedWith = null;
      mgr._testSetAgentFactory((opts) => { spawnedWith = opts; return new MockAgent(opts); });

      mgr.createSlot(2, { model: "gpt-5.5" });
      mgr.setSessionId(2, "some-opaque-id-we-cannot-classify");

      await mgr.startAgent(2);

      assert.equal(spawnedWith.sessionId, "some-opaque-id-we-cannot-classify");
    });

    it("drops a Claude session with no transcript on disk (orphaned)", async () => {
      // A real stuck-session case: a Claude model paired with a session id
      // whose JSONL is gone. `claude --resume <id>` would fail "No conversation
      // found" on every turn, hanging the chat.
      let spawnedWith = null;
      mgr._testSetAgentFactory((opts) => { spawnedWith = opts; return new MockAgent(opts); });

      mgr.createSlot(2, { model: "claude-opus-4-8" });
      mgr.setSessionId(2, "f0eb117b-fd59-4153-a466-e4dc4ec51caa");

      await mgr.startAgent(2);

      assert.equal(spawnedWith.sessionId, null, "orphaned Claude session must NOT be resumed");
      assert.equal(mgr.getSessionId(2), null, "orphaned session must be cleared from slot state");
    });
  });

  describe("stale-agent event guard", () => {
    it("ignores init from a replaced agent (no cross-family re-pin)", () => {
      const slotId = 3;
      const first = new MockAgent({ model: "gpt-5.5" });
      mgr.createSlot(slotId, { model: "gpt-5.5" });
      mgr._testInjectAgent(slotId, first);

      // Replace the agent (as stopAgent + startAgent would on a model switch).
      const second = new MockAgent({ model: "claude-opus-4-8" });
      mgr._testInjectAgent(slotId, second);

      // The old, now-stale agent emits a late init carrying its Codex thread id.
      first.emit("init", { sessionId: "019eb6b2-2e96-79d2-ad96-971642f4ea26" });

      assert.equal(mgr.getSessionId(slotId), null,
        "a stale agent's init must not re-pin its session id onto the slot");
    });

    it("accepts init from the current agent", () => {
      const slotId = 4;
      const agent = new MockAgent({ model: "gpt-5.5" });
      mgr.createSlot(slotId, { model: "gpt-5.5" });
      mgr._testInjectAgent(slotId, agent);

      agent.emit("init", { sessionId: "019eb6b2-2e96-79d2-ad96-971642f4ea26" });

      assert.equal(mgr.getSessionId(slotId), "019eb6b2-2e96-79d2-ad96-971642f4ea26");
    });

    it("ignores turn_done(watchdog) from a stale agent (no restart)", () => {
      const slotId = 5;
      const first = new MockAgent({ model: "gpt-5.5" });
      mgr.createSlot(slotId, { model: "gpt-5.5" });
      mgr._testInjectAgent(slotId, first);

      const second = new MockAgent({ model: "gpt-5.5" });
      mgr._testInjectAgent(slotId, second);

      // Stale agent fires a watchdog timeout; it must not tear down the current agent.
      first.emit("turn_done", { subtype: "watchdog_timeout" });

      assert.equal(mgr.isQueryActive(slotId), true, "current agent must remain active");
    });
  });

  describe("workspace is authoritative from the session", () => {
    it("restoreSlots corrects a Codex slot's cwd from session_meta", () => {
      const codexId = "019eb6b2-2e96-79d2-ad96-971642f4ea26";
      // session_meta.cwd points at beta-app; the persisted tab lies (acme-project).
      const dir = join(tempHome, ".config", "shellteam", "codex-history");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${codexId}.jsonl`),
        JSON.stringify({ type: "session_meta", model: "gpt-5.5", cwd: "/home/user/projects/beta-app" }) + "\n");
      writeFileSync(join(tempHome, ".claude-chat-tabs.json"), JSON.stringify([
        { id: 2, model: "gpt-5.5", sessionId: codexId, cwd: "/home/user/projects/acme-project" },
      ]));

      mgr.restoreSlots();

      assert.equal(mgr.getCwd(2), "/home/user/projects/beta-app",
        "restored cwd must come from session_meta, not the stale tab value");
    });

    it("createSlot does not let a reconnecting frontend clobber a restored session's cwd/model", () => {
      const codexId = "019eb6b2-2e96-79d2-ad96-971642f4ea26";
      const dir = join(tempHome, ".config", "shellteam", "codex-history");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${codexId}.jsonl`),
        JSON.stringify({ type: "session_meta", model: "gpt-5.5", cwd: "/home/user/projects/beta-app" }) + "\n");
      writeFileSync(join(tempHome, ".claude-chat-tabs.json"), JSON.stringify([
        { id: 2, model: "gpt-5.5", sessionId: codexId, cwd: "/home/user/projects/beta-app" },
      ]));
      mgr.restoreSlots();

      // Frontend reconnects and re-issues create_tab with its stale config.
      mgr.createSlot(2, { model: "claude-opus-4-8", cwd: "/home/user/projects/acme-project" });

      assert.equal(mgr.getCwd(2), "/home/user/projects/beta-app", "cwd must be preserved");
      assert.equal(mgr.getSlotModel(2), "gpt-5.5", "model must be preserved");
    });

    it("createSlot still applies config for a brand-new (session-less) tab", () => {
      mgr.createSlot(3, { model: "gpt-5.5", cwd: "/home/user/projects/foo" });
      assert.equal(mgr.getCwd(3), "/home/user/projects/foo");
      assert.equal(mgr.getSlotModel(3), "gpt-5.5");
    });
  });
});

/**
 * Tests for slot (tab) state management.
 *
 * Verifies that per-slot config (model, cwd) is independent across slots,
 * and that operations on one slot don't affect others.
 *
 * Run:  node --test computer/ai-chat/test-slots.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

let bridge;
// HOME is captured at import time by constants.mjs — we use slot 0's default cwd
// as the reference value for "default HOME" instead of process.env.HOME.
let defaultHome;

async function loadBridge() {
  const ts = Date.now() + Math.random();
  bridge = await import(`./lib/session-manager.mjs?v=${ts}`);
}

describe("Slot state management", () => {
  beforeEach(async () => {
    await loadBridge();
    bridge.setBroadcast(() => {});
    // Slot 0 is created at import time with cwd=HOME — use that as reference
    defaultHome = bridge.getCwd(0);
  });

  describe("slot creation and defaults", () => {
    it("slot 0 exists at startup", () => {
      const slots = bridge.listSlots();
      assert.equal(slots.length, 1);
      assert.equal(slots[0].id, 0);
    });

    it("new slot gets default model and cwd", () => {
      bridge.createSlot(1);
      const slots = bridge.listSlots();
      const slot1 = slots.find(s => s.id === 1);
      assert.ok(slot1, "slot 1 should exist");
      assert.ok(slot1.model, "should have a default model");
      assert.equal(slot1.cwd, defaultHome, "cwd should default to HOME");
    });

    it("createSlot with model and cwd overrides defaults", () => {
      bridge.createSlot(2, { model: "gpt-5.5", cwd: "/home/user/projects/foo" });
      const slots = bridge.listSlots();
      const slot2 = slots.find(s => s.id === 2);
      assert.equal(slot2.model, "gpt-5.5");
      assert.equal(slot2.cwd, "/home/user/projects/foo");
    });

    it("createSlot without overrides keeps defaults", () => {
      bridge.createSlot(3);
      const slot = bridge.listSlots().find(s => s.id === 3);
      assert.equal(slot.cwd, defaultHome);
    });
  });

  describe("per-slot cwd isolation", () => {
    it("setCwd on slot 0 does not affect slot 1", () => {
      bridge.createSlot(1);
      bridge.setCwd(0, "/home/user/project-a");
      assert.equal(bridge.getCwd(0), "/home/user/project-a");
      assert.equal(bridge.getCwd(1), defaultHome, "slot 1 cwd should be unchanged");
    });

    it("setCwd on slot 1 does not affect slot 0", () => {
      bridge.createSlot(1);
      bridge.setCwd(1, "/home/user/project-b");
      assert.equal(bridge.getCwd(0), defaultHome, "slot 0 cwd should be unchanged");
      assert.equal(bridge.getCwd(1), "/home/user/project-b");
    });

    it("each slot can have a different cwd", () => {
      bridge.createSlot(1);
      bridge.createSlot(2);
      bridge.setCwd(0, "/home/user/a");
      bridge.setCwd(1, "/home/user/b");
      bridge.setCwd(2, "/home/user/c");
      assert.equal(bridge.getCwd(0), "/home/user/a");
      assert.equal(bridge.getCwd(1), "/home/user/b");
      assert.equal(bridge.getCwd(2), "/home/user/c");
    });
  });

  describe("per-slot model isolation", () => {
    it("setSlotModel on slot 0 does not affect slot 1", () => {
      bridge.createSlot(1, { model: "claude-sonnet-4-5-20250514" });
      bridge.setSlotModel(0, "gpt-5.5");
      assert.equal(bridge.getSlotModel(0), "gpt-5.5");
      assert.equal(bridge.getSlotModel(1), "claude-sonnet-4-5-20250514");
    });
  });

  describe("per-slot session isolation", () => {
    it("setSessionId on slot 0 does not affect slot 1", () => {
      bridge.createSlot(1);
      bridge.setSessionId(0, "session-aaa");
      bridge.setSessionId(1, "session-bbb");
      assert.equal(bridge.getSessionId(0), "session-aaa");
      assert.equal(bridge.getSessionId(1), "session-bbb");
    });
  });

  describe("stopQuery isolation", () => {
    it("stopQuery on slot 0 does not affect slot 1 generating state", () => {
      bridge.createSlot(1);
      // Simulate both slots generating (we can't start real queries, but we can
      // verify stopQuery only touches the target slot's fields)
      bridge.stopAgent(0);
      // slot 1 should still have its default state
      assert.equal(bridge.getIsGenerating(1), false);
      assert.equal(bridge.getSessionId(1), null);
    });
  });

  describe("listSlots returns all config fields", () => {
    it("includes id, sessionId, isGenerating, model, cwd, createdAt, and lastUsedAt", () => {
      bridge.createSlot(1, { model: "test-model", cwd: "/home/user/test" });
      bridge.setSessionId(1, "sess-123");
      const slot = bridge.listSlots().find(s => s.id === 1);
      assert.equal(slot.id, 1);
      assert.equal(slot.sessionId, "sess-123");
      assert.equal(slot.isGenerating, false);
      assert.equal(slot.model, "test-model");
      assert.equal(slot.cwd, "/home/user/test");
      assert.ok(typeof slot.createdAt === "number");
      assert.ok(typeof slot.lastUsedAt === "number");
    });

    it("all fields are present (no undefined)", () => {
      const slot = bridge.listSlots().find(s => s.id === 0);
      const keys = Object.keys(slot);
      for (const key of ["id", "sessionId", "isGenerating", "model", "cwd", "createdAt", "lastUsedAt"]) {
        assert.ok(keys.includes(key), `missing field: ${key}`);
      }
    });
  });

  describe("deleteSlot", () => {
    it("removes only the target slot", () => {
      bridge.createSlot(1);
      bridge.createSlot(2);
      assert.equal(bridge.listSlots().length, 3); // 0, 1, 2
      bridge.deleteSlot(1);
      const remaining = bridge.listSlots();
      assert.equal(remaining.length, 2);
      assert.ok(remaining.find(s => s.id === 0));
      assert.ok(remaining.find(s => s.id === 2));
      assert.ok(!remaining.find(s => s.id === 1));
    });
  });

  describe("stale slot pruning", () => {
    it("removes stale non-primary slots from the live slot map", () => {
      bridge.createSlot(1);
      bridge.createSlot(2);
      const oldTs = Date.now() - (8 * 24 * 60 * 60 * 1000);
      bridge.setSlotLastUsedAt(1, oldTs);
      bridge.setSlotLastUsedAt(2, Date.now());

      const result = bridge.pruneStaleSlots(7);
      const remaining = bridge.listSlots();

      assert.equal(result.removed.length, 1);
      assert.ok(result.removed.find((slot) => slot.id === 1));
      assert.ok(remaining.find((slot) => slot.id === 0));
      assert.ok(!remaining.find((slot) => slot.id === 1));
      assert.ok(remaining.find((slot) => slot.id === 2));
    });

    it("markSlotUsed refreshes the live recency timestamp", () => {
      bridge.createSlot(1);
      const oldTs = Date.now() - (8 * 24 * 60 * 60 * 1000);
      bridge.setSlotLastUsedAt(1, oldTs);
      bridge.markSlotUsed(1);
      const slot = bridge.listSlots().find((item) => item.id === 1);
      assert.ok(slot.lastUsedAt > oldTs);
    });
  });
});

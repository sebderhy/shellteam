// Regression tests for SHE-50: "This tab keeps reappearing even though I closed
// it several times."
//
// Cause: slot 0 was treated as a permanent slot. The server's close_tab handler
// ignored a close of slot 0 (`slot !== 0`), and restoreSlots always re-created
// it — so the client dropped the tab locally while the server kept the slot and
// re-materialized it on the next status broadcast / restart. "Slot 0 always
// exists" is only a cold-start default, not a runtime invariant.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set HOME before importing constants so TABS_FILE resolves under a temp dir.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-she50-"));
const { TABS_FILE } = await import("../lib/constants.mjs");

// A cache-busted import gives each test a fresh slots map (and re-runs the
// module-load ensureSlot(0)), mirroring test-slots.mjs.
async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  sm.setBroadcast(() => {});
  return sm;
}

test("deleteSlot removes slot 0 like any other — it is not permanent", async () => {
  const sm = await freshSM();
  sm.createSlot(1);
  assert.equal(sm.listSlots().length, 2, "slots 0 and 1 exist");
  sm.deleteSlot(0);
  assert.deepEqual(sm.listSlots().map((s) => s.id), [1], "slot 0 is gone");
});

test("reading slot state after closing slot 0 must NOT resurrect it (buildStatus vector)", async () => {
  // buildStatus() reads top-level cwd/sessionId/… — historically via getCwd(0)
  // etc., each of which calls ensureSlot(0) and re-creates slot 0 as a read side
  // effect. That resurrected the closed tab on the next status broadcast and
  // re-persisted it (SHE-50, missed by the first fix). Reads must be against a
  // present slot, never a hardcoded 0.
  const sm = await freshSM();
  sm.createSlot(1);
  sm.deleteSlot(0);
  // Simulate what buildStatus now does: pick the lowest existing slot, read it.
  const primaryId = sm.listSlots()[0].id;
  sm.getCwd(primaryId);
  sm.getSessionId(primaryId);
  sm.getTotalCost(primaryId);
  sm.getIsGenerating(primaryId);
  assert.deepEqual(sm.listSlots().map((s) => s.id), [1], "slot 0 stays closed after a status read");
});

test("restoreSlots does NOT resurrect a slot 0 the user had closed", async () => {
  // A saved tab set from a session where slot 0 was closed (only tab 1 remained).
  writeFileSync(TABS_FILE, JSON.stringify([{ id: 1, model: "claude-opus-4-8", cwd: process.env.HOME }]));
  const sm = await freshSM();
  sm.restoreSlots();
  const ids = sm.listSlots().map((s) => s.id);
  assert.ok(!ids.includes(0), "the pristine startup slot 0 is dropped when absent from saved tabs");
  assert.ok(ids.includes(1), "the saved tab is restored");
});

test("restoreSlots keeps slot 0 when it WAS among the saved tabs", async () => {
  writeFileSync(TABS_FILE, JSON.stringify([{ id: 0 }, { id: 1 }]));
  const sm = await freshSM();
  sm.restoreSlots();
  assert.deepEqual(sm.listSlots().map((s) => s.id).sort((a, b) => a - b), [0, 1]);
});

test("restoreSlots falls back to a single default slot 0 when nothing was saved", async () => {
  writeFileSync(TABS_FILE, JSON.stringify([]));
  const sm = await freshSM();
  sm.restoreSlots();
  assert.deepEqual(sm.listSlots().map((s) => s.id), [0], "empty saved set → keep the default tab");
});

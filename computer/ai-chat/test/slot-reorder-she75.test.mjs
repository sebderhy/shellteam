// SHE-75: drag-and-drop tab reorder. The server owns the durable tab ORDER
// (the slots Map's insertion order == what listSlots()/saveTabs() emit and the
// client renders), so reorderSlots() must re-lay the Map, persist it, and survive
// a restart — including moving slot 0, which the module-load ensureSlot(0) forces
// to the front unless restore honors the saved order.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-she75-"));

async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  sm.setBroadcast(() => {});
  return sm;
}
const ids = (sm) => sm.listSlots().map((s) => s.id);

test("reorderSlots re-lays the strip in the requested order", async () => {
  const sm = await freshSM();
  sm.createSlot(1);
  sm.createSlot(2);
  assert.deepEqual(ids(sm), [0, 1, 2]);
  sm.reorderSlots([2, 0, 1]);
  assert.deepEqual(ids(sm), [2, 0, 1]);
});

test("reorderSlots never drops a slot omitted from the order (appended in place)", async () => {
  const sm = await freshSM();
  sm.createSlot(1);
  sm.createSlot(2);
  sm.reorderSlots([2]); // only mention slot 2
  assert.deepEqual(ids(sm), [2, 0, 1], "unmentioned slots keep their relative order at the end");
});

test("reorderSlots ignores unknown ids and is a no-op on a bad payload", async () => {
  const sm = await freshSM();
  sm.createSlot(1);
  sm.reorderSlots([99, 1, 0, 42]);
  assert.deepEqual(ids(sm), [1, 0]);
  sm.reorderSlots(null); // must not throw
  assert.deepEqual(ids(sm), [1, 0]);
});

test("reordered order (incl. slot 0 moved) survives a restart via saved tabs", async () => {
  const sm = await freshSM();
  sm.createSlot(1);
  sm.createSlot(2);
  sm.reorderSlots([1, 2, 0]); // move slot 0 to the END
  await new Promise((r) => setTimeout(r, 350)); // saveTabs debounce (300ms)

  // A fresh module instance = a server restart: module-load ensureSlot(0) puts
  // slot 0 first, then restoreSlots must re-apply the saved order.
  const sm2 = await freshSM();
  sm2.restoreSlots();
  assert.deepEqual(ids(sm2), [1, 2, 0], "slot 0 stays where it was dragged after restart");
});

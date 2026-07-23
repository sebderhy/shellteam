// SHE-52 (release-audit round 3, P1-01): slot existence is SERVER-authoritative,
// fully. The SHE-78 patch guarded create_tab/touch_slot/interrupt but left the
// rest of the surface on ensureSlot: `new_session` on a closed slot recreated
// it (proven over live WebSockets by the audit), every getter had creation
// side effects, and client-allocated tab ids let two devices race the same
// integer and merge two intended conversations into one server slot.
//
// The invariant now: materializeSlot is the ONLY creation path, reachable
// solely from createSlot / forkSlot / restoreSlots / cold-start; every other
// read or mutation on a missing slot is a refusal or a neutral default; and
// the server allocates canonical ids (allocateSlotId), treating the client's
// id as a hint.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-she52-"));

async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  sm.setBroadcast(() => {});
  return sm;
}

const ids = (sm) => sm.listSlots().map((s) => s.id).sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Parameterized contract: EVERY slot-scoped operation on a closed id leaves
// the slot set unchanged. This is the coverage the round-3 audit demanded —
// the previous test asserted only the two known paths.
// ---------------------------------------------------------------------------

const STALE_OPS = [
  ["resetSlot (the audit's live repro: new_session resurrected)", (sm, id) => sm.resetSlot(id)],
  ["setCwd", (sm, id) => sm.setCwd(id, process.env.HOME)],
  ["setSessionId", (sm, id) => sm.setSessionId(id, "sess-x")],
  ["setSlotModel", (sm, id) => sm.setSlotModel(id, "claude-opus-4-8")],
  ["switchSlotModel", (sm, id) => sm.switchSlotModel(id, "claude-opus-4-8")],
  ["sendMessage", (sm, id) => sm.sendMessage(id, "hello?")],
  ["startAgent", (sm, id) => sm.startAgent(id)],
  ["stopAgent", (sm, id) => sm.stopAgent(id)],
  ["interruptAgent", (sm, id) => sm.interruptAgent(id)],
  ["markSlotUsed", (sm, id) => sm.markSlotUsed(id)],
  ["setSlotLastUsedAt", (sm, id) => sm.setSlotLastUsedAt(id, 123)],
  ["rewindSlot", (sm, id) => sm.rewindSlot(id)],
  ["compactSlot", (sm, id) => sm.compactSlot(id)],
  ["refreshSlotFromDisk", (sm, id) => sm.refreshSlotFromDisk(id)],
  ["resumeSession", (sm, id) => sm.resumeSession(id, "no-such-session")],
  ["addUserMessage", (sm, id) => sm.addUserMessage(id, "typed into a ghost")],
  ["renameSlot", (sm, id) => sm.renameSlot(id, "ghost")],
  ["clientCreateSlot without fresh", (sm, id) => sm.clientCreateSlot(id, {}, false)],
];

for (const [name, op] of STALE_OPS) {
  test(`SHE-52: stale ${name} on a closed slot never recreates it`, async () => {
    const sm = await freshSM();
    sm.createSlot(910001, { model: "claude-opus-4-8" });
    sm.deleteSlot(910001);
    assert.deepEqual(ids(sm), [0], "setup: 910001 closed");
    await op(sm, 910001);
    assert.deepEqual(ids(sm), [0], `${name} resurrected slot 910001`);
  });
}

test("SHE-52: every state getter is a pure read with a neutral default", async () => {
  const sm = await freshSM();
  sm.createSlot(7);
  sm.deleteSlot(7);
  assert.equal(sm.isQueryActive(7), false);
  assert.equal(sm.getIsGenerating(7), false);
  assert.equal(sm.getSessionId(7), null);
  assert.equal(typeof sm.getCwd(7), "string"); // neutral default, not a crash
  assert.equal(sm.getTotalCost(7), 0);
  assert.equal(typeof sm.getSlotModel(7), "string");
  assert.deepEqual(sm.getHistory(7), []);
  assert.deepEqual(ids(sm), [0], "a getter resurrected the slot");
});

// ---------------------------------------------------------------------------
// Server-side id allocation: the client id is a hint, never the authority.
// ---------------------------------------------------------------------------

test("SHE-52: a free hint is granted (optimistic client id stays stable)", async () => {
  const sm = await freshSM();
  assert.equal(sm.allocateSlotId(3), 3);
});

test("SHE-52: two raced creates with the same hint get DISTINCT ids", async () => {
  const sm = await freshSM();
  // Both devices hold snapshot [0] and both compute nextSlotId = 1.
  const a = sm.allocateSlotId(1);
  sm.createSlot(a, { model: "claude-opus-4-8" });
  const b = sm.allocateSlotId(1);
  sm.createSlot(b, { model: "claude-opus-4-8" });
  assert.notEqual(a, b, "raced creates merged into one slot");
  assert.deepEqual(ids(sm), [0, a, b].sort((x, y) => x - y));
});

test("SHE-52: no hint (draft recovery) allocates a brand-new identity", async () => {
  const sm = await freshSM();
  sm.createSlot(1);
  sm.createSlot(2);
  sm.deleteSlot(1); // the closed slot whose draft is being recovered
  const fresh = sm.allocateSlotId(undefined);
  assert.equal(fresh, 3, "draft recovery must get max+1, never the closed id back");
});

test("SHE-52: excluded (broker) ids do not inflate user tab allocation", async () => {
  const sm = await freshSM();
  sm.createSlot(910001); // broker-style out-of-band slot
  sm.createSlot(1);
  const next = sm.allocateSlotId(undefined, (id) => id >= 900000);
  assert.equal(next, 2, "allocation must skip excluded ranges, not jump above them");
});

// ---------------------------------------------------------------------------
// The guarantees that must survive the refactor.
// ---------------------------------------------------------------------------

test("SHE-52: authoritative creation still works end to end", async () => {
  const sm = await freshSM();
  sm.createSlot(1, { model: "claude-opus-4-8" });
  assert.ok(sm.hasSlot(1));
  sm.setCwd(1, process.env.HOME);
  sm.setSessionId(1, "sess-1");
  assert.equal(sm.getSessionId(1), "sess-1");
  const r = sm.resetSlot(1);
  assert.notEqual(r, false, "reset of an EXISTING slot must still work");
  assert.equal(sm.getSessionId(1), null);
});

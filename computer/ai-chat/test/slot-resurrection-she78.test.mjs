// Regression tests for SHE-78: "ShellTeam is still opening some empty chat
// tabs for no reason."
//
// Root cause (release recheck 2026-07-20, P1-NEW-02): slot EXISTENCE was
// client-driven. Two deterministic resurrection paths:
//   1. Reconnect replay — every client re-issued create_tab for its whole
//      local tab list on reconnect, and the server's handler ensureSlot'd any
//      unknown id. A stale/offline client thus re-created (and re-persisted)
//      every tab another device had closed.
//   2. View-touch — touch_slot (sent on every tab switch) called
//      markSlotUsed → ensureSlot, so switching to a tab another device had
//      just closed resurrected it as an empty slot.
//
// The fix makes the server authoritative for existence: only an explicitly
// `fresh` create_tab may bring a new slot into being (clientCreateSlot), and
// view actions never create (markSlotUsed refuses unknown ids). The client no
// longer replays; it reconciles against the first snapshot instead.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Set HOME before importing constants so TABS_FILE resolves under a temp dir.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-she78-"));
const { TABS_FILE } = await import("../lib/constants.mjs");

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// A cache-busted import gives each test a fresh slots map (and re-runs the
// module-load ensureSlot(0)), mirroring slot-close-she50.test.mjs.
async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  sm.setBroadcast(() => {});
  return sm;
}

// ---------------------------------------------------------------------------
// The two-client scenario from the release recheck, at the protocol-policy
// level: A and B know tabs 0–4; B goes offline; A closes 1–4; B reconnects
// with stale state and replays create_tab for every tab it remembers.
// ---------------------------------------------------------------------------

test("SHE-78: a stale client's create_tab replay does NOT resurrect closed tabs", async () => {
  const sm = await freshSM();
  // Both clients know tabs 0–4.
  for (const id of [1, 2, 3, 4]) sm.createSlot(id, { model: "claude-opus-4-8" });
  assert.equal(sm.listSlots().length, 5);

  // Client A closes 1–4 (the server's close_tab path calls deleteSlot).
  for (const id of [1, 2, 3, 4]) sm.deleteSlot(id);
  assert.deepEqual(sm.listSlots().map((s) => s.id), [0]);

  // Stale client B reconnects and replays its whole tab list — the old
  // protocol's reconnect behavior (no `fresh` flag).
  const results = [0, 1, 2, 3, 4].map((id) =>
    sm.clientCreateSlot(id, { model: "claude-opus-4-8" }, false));

  assert.deepEqual(results, [true, false, false, false, false],
    "existing slot 0 touches fine; closed 1–4 are refused");
  assert.deepEqual(sm.listSlots().map((s) => s.id), [0],
    "the closed tabs stay closed on the server");
});

test("SHE-78: a fresh create_tab (the + button / a reconciled draft) still creates", async () => {
  const sm = await freshSM();
  assert.equal(sm.clientCreateSlot(7, { model: "claude-opus-4-8", cwd: process.env.HOME }, true), true);
  assert.ok(sm.listSlots().some((s) => s.id === 7));
});

test("SHE-78: a non-fresh create_tab for an EXISTING slot keeps working (legacy touch)", async () => {
  const sm = await freshSM();
  sm.createSlot(1, { model: "claude-opus-4-8" });
  assert.equal(sm.clientCreateSlot(1, { model: "some-stale-model" }, false), true);
  // And existing-slot semantics are unchanged: stale config never clobbers.
  assert.equal(sm.listSlots().find((s) => s.id === 1).model, "claude-opus-4-8");
});

// ---------------------------------------------------------------------------
// The view-touch resurrection path.
// ---------------------------------------------------------------------------

test("SHE-78: touching a closed slot (tab switch on a stale device) does not create it", async () => {
  const sm = await freshSM();
  sm.createSlot(1);
  sm.deleteSlot(1);
  assert.equal(sm.markSlotUsed(1), false, "touch of an unknown slot is refused");
  assert.deepEqual(sm.listSlots().map((s) => s.id), [0], "no ghost slot appeared");
  assert.equal(sm.markSlotUsed(0), true, "touching a live slot still works");
});

// ---------------------------------------------------------------------------
// Restart durability: a tab created inside the 300 ms save debounce must
// survive a graceful shutdown — the client must never need to resurrect tabs
// the server forgot (that pressure is what bred the replay protocol).
// ---------------------------------------------------------------------------

test("SHE-78: flushTabs persists a just-created tab through the debounce window", async () => {
  const sm = await freshSM();
  sm.createSlot(3, { model: "claude-opus-4-8" });
  sm.flushTabs(); // what shutdown() now calls
  const saved = JSON.parse(readFileSync(TABS_FILE, "utf8"));
  assert.ok(saved.some((t) => t.id === 3), "tab 3 is on disk immediately, not after 300 ms");
});

// ---------------------------------------------------------------------------
// Client-side protocol contract, pinned at the source level (the cockpit
// frontend has no DOM test harness): the reconnect replay is gone, every
// remaining create_tab send is explicitly fresh, and the snapshot reconcile
// exists. Textual, but each assertion targets the exact line that caused or
// fixes SHE-78 — if a refactor renames these, this test SHOULD make you look.
// ---------------------------------------------------------------------------

test("SHE-78: app.js no longer replays create_tab on reconnect and marks real creates fresh", () => {
  const src = readFileSync(join(PUBLIC, "app.js"), "utf8");

  const creates = [...src.matchAll(/type:\s*'create_tab'[^}]*/g)].map((m) => m[0]);
  assert.ok(creates.length >= 2, "expected the + button and the reconcile to send create_tab");
  for (const c of creates) {
    assert.match(c, /fresh:\s*true/,
      `every create_tab send must be explicitly fresh, found: ${c}`);
  }

  // The resurrection loop replayed every local slot's config on reconnect.
  assert.ok(!/for \(const slot of sessionSlots\) \{\s*\n?\s*S\.ws\.send\(JSON\.stringify\(\{ type: 'create_tab'/.test(src),
    "the reconnect create_tab replay loop must not come back");

  // The reconcile drops local tabs the server no longer has.
  assert.match(src, /serverIds/,
    "the first-snapshot reconcile (server-authoritative existence) must exist");
});

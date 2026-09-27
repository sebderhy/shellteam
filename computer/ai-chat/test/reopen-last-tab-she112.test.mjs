// SHE-112: "When I close and reopen shellteam, it should come back to the same
// tab I was using (at least on same device, ideally across devices)."
//
// Root cause (same device): the cockpit saved the active tab in localStorage,
// but on a box whose tab 0 had been closed, every load dropped the placeholder
// tab 0 and switched to the first tab BEFORE reading the saved one. That switch
// wrote the first tab's id to localStorage, so the saved tab was erased and the
// cockpit always reopened on the first tab.
//
// Fix: the tab to open is decided before any fallback switch, and it is the tab
// the owner last viewed on ANY device (server-side viewedAt, stamped on every
// tab switch and send), falling back to this device's own saved tab.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-she112-"));
const { TABS_FILE } = await import("../lib/constants.mjs");

const APP_JS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js"), "utf8");
const DASHBOARD = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend", "dashboard.html"), "utf8");

// app.js is a browser script: lift the pure helper so the test runs the real code.
function loadStartSlotId() {
  const m = APP_JS.match(/\nfunction startSlotId\(serverSlots, savedId\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, "startSlotId missing from app.js");
  return new Function(`${m[0]}; return startSlotId;`)();
}
const startSlotId = loadStartSlotId();

async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  sm.setBroadcast(() => {});
  return sm;
}

test("the most recently viewed tab wins, from any device", () => {
  const slots = [{ id: 42, viewedAt: 100 }, { id: 9, viewedAt: 300 }, { id: 28, viewedAt: 200 }];
  assert.equal(startSlotId(slots, 42), 9, "server's last-viewed beats this device's saved tab");
});

test("with no view stamps yet, this device's saved tab is used if it still exists", () => {
  assert.equal(startSlotId([{ id: 42 }, { id: 9 }], 9), 9);
  assert.equal(startSlotId([{ id: 42 }, { id: 9 }], 5), null, "a closed saved tab is ignored");
  assert.equal(startSlotId([{ id: 42 }, { id: 9 }], NaN), null, "nothing saved");
});

test("the tab to reopen is decided before the fallback switches that overwrite localStorage", () => {
  const decided = APP_JS.indexOf("const restoreId = firstSnapshot");
  const firstFallback = APP_JS.indexOf("const pristine = s0 && !s0.sessionId");
  assert.ok(decided > 0 && firstFallback > 0, "both sites exist");
  assert.ok(decided < firstFallback, "restoreId must be read before any fallback switch");
  // The fallbacks themselves land on the restored tab, not blindly the first one.
  assert.match(APP_JS, /if \(wasActive\) \{ activeSlotId = -1; switchSessionTab\(restoreId \?\? sessionSlots\[0\]\.id\); \}/);
  assert.match(APP_JS, /switchSessionTab\(restoreId \?\? msg\.slots\[0\]\.id\)/);
  // The old restore re-read localStorage after the fallbacks had clobbered it.
  assert.doesNotMatch(APP_JS, /const savedActive = parseInt\(localStorage\.getItem\('activeSlotId'\)/);
});

test("viewing a tab stamps viewedAt, which survives a cockpit restart", async () => {
  const sm = await freshSM();
  sm.createSlot(7, { model: "claude-opus-5" });
  sm.createSlot(8, { model: "claude-opus-5" });
  assert.equal(sm.listSlots().find((s) => s.id === 7).viewedAt, 0, "never viewed");

  assert.equal(sm.markSlotUsed(7), true);
  const stamped = sm.listSlots().find((s) => s.id === 7).viewedAt;
  assert.ok(stamped > 0, "a tab switch stamps viewedAt");
  assert.equal(sm.listSlots().find((s) => s.id === 8).viewedAt, 0, "other tabs untouched");

  sm.flushTabs();
  const saved = JSON.parse(readFileSync(TABS_FILE, "utf8"));
  assert.equal(saved.find((s) => s.id === 7).viewedAt, stamped, "persisted to the tabs file");

  const restarted = await freshSM();
  restarted.restoreSlots();
  assert.equal(restarted.listSlots().find((s) => s.id === 7).viewedAt, stamped, "restored after restart");
});

test("a send marks its tab as viewed, so a device left open on a tab still counts", () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"), "utf8");
  const send = server.slice(server.indexOf('case "send": {'), server.indexOf("addUserMessage(slot, historyContent);"));
  assert.match(send, /markSlotUsed\(slot\);/);
});

test("the dashboard reopens on this device's last tab when the URL has no #tab", () => {
  assert.match(DASHBOARD, /localStorage\.setItem\(LAST_TAB_KEY, tab\)/);
  assert.match(DASHBOARD, /else if \(visibleTab\(lastTab\)\) switchTab\(lastTab\);/);
});

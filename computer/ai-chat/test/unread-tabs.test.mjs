// Unread tabs, Slack-style (Seb, 2026-10-22): "I have no way to know clearly
// when a tab finished running and posted a final answer that I haven't read
// yet." A tab whose agent finished a turn since the owner last looked at it is
// unread: bold title, a green dot, "(n) ShellTeam" in the browser tab. Opening
// it reads it on every device; right-click or Alt+U marks it unread again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-unread-"));

async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  sm.setBroadcast(() => {});
  return sm;
}
class FakeAgent extends EventEmitter { stop() {} interrupt() {} }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("server: a finished turn makes the tab unread until it is viewed", async () => {
  const sm = await freshSM();
  sm.createSlot(920001, { model: "claude-opus-5" });
  const agent = new FakeAgent();
  sm._testInjectAgent(920001, agent);
  sm.markSlotUsed(920001);
  assert.equal(sm.isSlotUnread(920001), false, "just viewed");
  await wait(5);
  agent.emit("turn_done", {});
  assert.equal(sm.isSlotUnread(920001), true, "an answer arrived after the last view");
  sm.markSlotUsed(920001);
  assert.equal(sm.isSlotUnread(920001), false, "opening the tab reads it");
  const listed = sm.listSlots().find((s) => s.id === 920001);
  assert.ok(listed.answeredAt > 0 && "markedUnread" in listed, "every device gets the read state");
});

test("server: a turn the owner stopped, or a watchdog self-restart, is not an answer", async () => {
  const sm = await freshSM();
  sm.createSlot(920002, { model: "claude-opus-5" });
  const agent = new FakeAgent();
  sm._testInjectAgent(920002, agent);
  sm.markSlotUsed(920002);
  await wait(5);
  agent.emit("turn_done", { subtype: "interrupted" });
  agent.emit("turn_done", { subtype: "stopped" });
  assert.equal(sm.isSlotUnread(920002), false);
});

test("server: mark as unread survives until the tab is opened; mark as read clears an answer", async () => {
  const sm = await freshSM();
  sm.createSlot(920003, { model: "claude-opus-5" });
  sm.markSlotUsed(920003);
  assert.equal(sm.setSlotUnread(920003, true), true);
  assert.equal(sm.isSlotUnread(920003), true);
  sm.markSlotUsed(920003);
  assert.equal(sm.isSlotUnread(920003), false);
  const agent = new FakeAgent();
  sm._testInjectAgent(920003, agent);
  await wait(5);
  agent.emit("turn_done", {});
  sm.setSlotUnread(920003, false);
  assert.equal(sm.isSlotUnread(920003), false);
  assert.equal(sm.setSlotUnread(999999, true), false, "an unknown slot is refused, not created");
});

// --- client logic, run from the real app.js source -------------------------
const appSrc = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");
function clientFns() {
  const pick = (name) => {
    const start = appSrc.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    return appSrc.slice(start, appSrc.indexOf("\n}\n", start) + 2);
  };
  const ctx = { document: { hidden: false }, activeSlotId: 1 };
  vm.createContext(ctx);
  vm.runInContext(["isTurnAnswer", "slotUnread", "syncReadState", "markSlotRead"].map(pick).join("\n"), ctx);
  return ctx;
}

test("client: a background tab that got an answer is unread; the tab you are looking at is not", () => {
  const c = clientFns();
  const bg = { id: 2, liveUnread: true };
  const active = { id: 1, liveUnread: true };
  assert.equal(c.slotUnread(bg), true);
  assert.equal(c.slotUnread(active), false);
  c.document.hidden = true;
  assert.equal(c.slotUnread(active), true, "answered while you were on another browser tab");
  c.document.hidden = false;
  assert.equal(c.slotUnread({ id: 2, liveUnread: true, isGenerating: true }), false, "a working tab has nothing to read yet");
  assert.equal(c.slotUnread({ id: 1, markedUnread: true }), true, "marked unread shows even on the active tab");
  c.markSlotRead(bg);
  assert.equal(c.slotUnread(bg), false);
});

test("client: reading on another device clears it here; server and browser clocks are never compared", () => {
  const c = clientFns();
  const slot = { id: 2, liveUnread: true };
  c.syncReadState(slot, { answeredAt: 1000, viewedAt: 900, markedUnread: false });
  assert.equal(c.slotUnread(slot), true);
  c.syncReadState(slot, { answeredAt: 1000, viewedAt: 1200, markedUnread: false });
  assert.equal(c.slotUnread(slot), false);
  assert.equal(c.isTurnAnswer({ subtype: "interrupted" }), false);
  assert.equal(c.isTurnAnswer({}), true);
});

test("wiring: tab and drawer render it, right-click and Alt+U toggle it, the title counts it", () => {
  const html = readFileSync(fileURLToPath(new URL("../../../frontend/dashboard.html", import.meta.url)), "utf8");
  const css = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");
  assert.match(appSrc, /class="session-tab\$\{active\}\$\{generating\}\$\{unread\}"/);
  assert.match(appSrc, /drawer-item\$\{isActive \? ' active' : ''\}\$\{slotUnread\(slot\) \? ' unread' : ''\}/);
  assert.match(appSrc, /addEventListener\('contextmenu'[\s\S]*?openTabMenu\(/);
  assert.match(appSrc, /e\.code === 'KeyU'[\s\S]*?setTabUnread\(/);
  assert.match(appSrc, /\['Alt\+U', /, "the ? cheat sheet lists it");
  assert.match(appSrc, /type: 'mark_unread'/);
  assert.match(appSrc, /kind: 'unread-count'/);
  assert.match(html, /d\.kind === 'unread-count'\) document\.title/);
  assert.match(css, /\.session-tab\.unread \{/);
  assert.match(appSrc, /getElementById\('convSwitcherBadge'\)/, "phones count the other tabs' waiting answers");
  assert.match(readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8"), /id="convSwitcherBadge" hidden/);
});

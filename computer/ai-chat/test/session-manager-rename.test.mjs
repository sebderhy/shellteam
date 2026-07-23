// Tests for custom tab titles (renameSlot). A user-set name must:
//  - surface as the slot's label (listSlots),
//  - win over an auto-derived first-message title,
//  - persist to the tabs file so it survives a restart,
//  - clear back to auto-derivation when set empty.
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect HOME before importing — constants.mjs resolves paths at import time.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-rename-"));

const sm = await import("../lib/session-manager.mjs");
const { HOME } = await import("../lib/constants.mjs");
const TABS_FILE = join(HOME, ".claude-chat-tabs.json");

function labelOf(id) {
  return sm.listSlots().find((s) => s.id === id)?.label ?? null;
}
// saveTabs() debounces ~300ms; wait it out before asserting on disk.
const flush = () => new Promise((r) => setTimeout(r, 400));

test("renameSlot sets a custom label surfaced by listSlots", () => {
  sm.createSlot(200, { cwd: HOME });
  assert.equal(labelOf(200), null); // untitled, no messages yet
  assert.equal(sm.renameSlot(200, "Deploy pipeline"), true);
  assert.equal(labelOf(200), "Deploy pipeline");
});

test("renameSlot trims and caps length at 40 chars", () => {
  sm.createSlot(201, { cwd: HOME });
  sm.renameSlot(201, "   padded name   ");
  assert.equal(labelOf(201), "padded name");
  sm.renameSlot(201, "x".repeat(60));
  assert.equal(labelOf(201).length, 40);
});

test("a custom title wins over the auto-derived first-message title", () => {
  sm.createSlot(202, { cwd: HOME });
  // Simulate the first user message the auto-titler would derive from.
  sm.addUserMessage(202, "Refactor the auth service and drop the token flow");
  sm.renameSlot(202, "Auth work");
  assert.equal(labelOf(202), "Auth work");
});

test("empty rename clears the custom title (reverts to auto-derivation)", () => {
  sm.createSlot(203, { cwd: HOME });
  sm.addUserMessage(203, "Write a CSV parser");
  sm.renameSlot(203, "Temp name");
  assert.equal(labelOf(203), "Temp name");
  sm.renameSlot(203, "   "); // whitespace-only clears it
  assert.equal(labelOf(203), "Write a CSV parser"); // back to derived title
});

test("renameSlot returns false for an unknown slot and creates nothing", () => {
  assert.equal(sm.renameSlot(9999, "ghost"), false);
  assert.equal(sm.listSlots().some((s) => s.id === 9999), false);
});

test("a custom title is persisted to the tabs file", async () => {
  sm.createSlot(204, { cwd: HOME });
  sm.renameSlot(204, "Persisted title");
  await flush();
  assert.ok(existsSync(TABS_FILE));
  const saved = JSON.parse(readFileSync(TABS_FILE, "utf8"));
  const row = saved.find((s) => s.id === 204);
  assert.equal(row.title, "Persisted title");
});

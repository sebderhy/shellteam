/**
 * SHE-92 — the context meter read "584k · 100%" on a Fable 5 tab, even though
 * Fable 5 has a 1M window (584k should be ~58%).
 *
 * Root cause: `slot.contextWindow` caches the running model's OPERATIVE window,
 * which only Codex reports (258400 for gpt-5.6). It was set once and never
 * cleared, so a tab switched Codex -> Fable kept the stale 258400 as the meter's
 * denominator (584k / 258400 caps at 100%). A pure-Claude tab never sets it and
 * derives 1M correctly from the catalog — which is exactly why it only showed up
 * after a cross-family switch.
 *
 * Fix: clear `slot.contextWindow` whenever the model changes on a slot (and in
 * clearContextMeter), so the meter re-derives the new model's window from the
 * catalog instead of capping against a foreign model's operative window.
 *
 * Run: node --test computer/ai-chat/test/context-meter-model-switch-she92.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { contextLimitForId } from "../lib/model-catalog.mjs";

// --- Behavioral: the catalog resolver the meter falls back to is correct ------
// With the stale window cleared, contextWindowForSlot falls back to the shared
// catalog window. Pin that Fable 5 genuinely resolves to 1M (not the 200k/258k
// defaults) so the meter denominator is right.
test("SHE-92: claude-fable-5-1 resolves to its 1M catalog window", () => {
  assert.equal(contextLimitForId("claude-fable-5-1"), 1_000_000);
});

test("SHE-92: a Codex operative window is NOT what a Claude model resolves to", () => {
  // The stale value that used to poison the Fable meter.
  assert.notEqual(contextLimitForId("claude-fable-5-1"), 258_400);
  assert.notEqual(contextLimitForId("claude-fable-5-1"), 200_000);
});

// --- Source contract: the per-model window is cleared on model change ---------
// app.js is a DOM-coupled monolith; like SHE-90/SHE-89 and tab-bar-she81-83 we
// pin the state-clearing at the source level so a refactor that drops it fails
// loudly here.
const DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(DIR, "../public/app.js"), "utf8");

test("SHE-92: clearContextMeter nulls the per-model window, not just the tokens", () => {
  const fn = APP_JS.match(/function clearContextMeter\(slotId\)\s*{[\s\S]*?\n}/);
  assert.ok(fn, "clearContextMeter exists");
  assert.ok(
    /slot\.contextWindow = null/.test(fn[0]),
    "clearContextMeter must clear slot.contextWindow (SHE-92), not only contextTokens",
  );
});

test("SHE-92: a model_changed for a slot clears that slot's stale window", () => {
  // The handler runs for active AND background slots and for both reset and
  // handoff switches — clearing contextWindow there is what covers the
  // Codex->Fable handoff (session kept, window must re-derive).
  const handler = APP_JS.match(/msg\.type === 'model_changed'[\s\S]*?if \(msg\.reset\)/);
  assert.ok(handler, "model_changed handler exists");
  assert.ok(
    /changedSlot\.contextWindow = null/.test(handler[0]),
    "model_changed must clear the changed slot's contextWindow so a foreign operative window can't outlive its model (SHE-92)",
  );
});

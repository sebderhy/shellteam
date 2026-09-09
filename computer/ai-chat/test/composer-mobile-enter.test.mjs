/**
 * On a phone/tablet the on-screen keyboard's Enter is the only way to type a
 * newline, so it must NOT send the message (WhatsApp behaviour): Enter inserts a
 * newline and the Send button sends. On desktop, Enter sends and Shift+Enter is
 * the newline. These are the source-level contracts behind that fix; a refactor
 * that reverts them fails here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(DIR, "../public/app.js"), "utf8");

test("soft-keyboard devices are detected with a coarse-pointer / no-hover query", () => {
  assert.match(
    APP_JS,
    /const softKeyboardQuery = window\.matchMedia\('\(pointer: coarse\) and \(hover: none\)'\)/,
    "must use a live matchMedia query so a phone (touch, no mouse) is recognised",
  );
});

test("Enter sends only on desktop — never on a soft keyboard, never mid-IME", () => {
  const fn = APP_JS.match(/function enterSendsMessage\(e\)\s*\{([\s\S]*?)\}/);
  assert.ok(fn, "enterSendsMessage() helper exists");
  const body = fn[1];
  assert.match(body, /e\.key === 'Enter'/, "gated on the Enter key");
  assert.match(body, /!e\.shiftKey/, "Shift+Enter is always a newline");
  assert.match(body, /!softKeyboardQuery\.matches/, "soft keyboards never send on Enter");
  assert.match(body, /!e\.isComposing/, "an in-flight IME composition never sends");
});

test("the composer keydown handler sends through the guard, not a bare Enter check", () => {
  // The old code was `if (e.key === 'Enter' && !e.shiftKey) { handleSend() }`,
  // which sent on every phone keystroke. It must route through the helper now.
  assert.match(
    APP_JS,
    /if \(enterSendsMessage\(e\)\) \{\s*e\.preventDefault\(\);\s*handleSend\(\);/,
    "composer keydown must call handleSend() only when enterSendsMessage() is true",
  );
  assert.doesNotMatch(
    APP_JS,
    /if \(e\.key === 'Enter' && !e\.shiftKey\) \{\s*e\.preventDefault\(\);\s*handleSend/,
    "the bare Enter-sends check that fired on mobile must be gone",
  );
});

/**
 * Phone composer collapse: while a draft is being typed on a phone, the
 * attach/mic/audio trio folds into one chevron so the text field gets the
 * width back. Exists because four 44px controls left the field at 88px on a
 * 320px phone — narrower than its own placeholder.
 *
 * Static contract tests in the style of touch-targets-she79: they pin the
 * wiring that a headless unit suite cannot exercise (real layout), so a
 * refactor cannot quietly drop a piece of the mechanism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "public/styles.css"), "utf8");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const app = readFileSync(join(root, "public/app.js"), "utf8");

test("collapsing hides every composer action, not a stale subset", () => {
  const rule = css.match(/\.composer\.collapsed[^{]*\{[^}]*\}/s);
  assert.ok(rule, ".composer.collapsed rule missing from styles.css");
  for (const cls of [".btn-attach", ".btn-mic", ".btn-audio-reply"]) {
    assert.ok(
      new RegExp(`\\.composer\\.collapsed\\s+\\${cls}`).test(css),
      `${cls} must be hidden by the collapsed composer`,
    );
  }
});

test("the chevron exists and is a 44px target on phones", () => {
  assert.match(html, /id="btnComposerExpand"/);
  const mobileRule = css.match(/\.btn-attach,[^{]*\.btn-send\s*\{[^}]*\}/);
  assert.ok(
    mobileRule && mobileRule[0].includes(".btn-composer-expand"),
    "the chevron must be in the mobile 44px touch-target rule",
  );
});

test("collapse is phone-only, draft-driven, and never hides a live mic", () => {
  const fn = app.match(/function updateComposerCollapse\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "updateComposerCollapse missing from app.js");
  assert.match(fn[0], /composerPhoneQuery\.matches/, "must be gated on the phone media query");
  assert.match(fn[0], /value\.length > 0/, "must collapse only while a draft exists");
  assert.match(
    fn[0],
    /recording/,
    "must never collapse while recording — that would hide a live microphone",
  );
});

test("every draft-changing path reaches the collapse via autosizeComposer", () => {
  const fn = app.match(/function autosizeComposer\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn && fn[0].includes("updateComposerCollapse()"),
    "autosizeComposer must call updateComposerCollapse — it is the choke point " +
    "every draft mutation (typing, tab switch, send-clear) already flows through");
});

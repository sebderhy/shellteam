// Regression pin for a cockpit bug reported 2026-07-06:
//   SHE-53 — report links opened in a new window after a tab switch.
// (SHE-54 and SHE-55 were about the header folder pickers, gone with SHE-188:
// a chat's folder is its project now.)
//
// Run: node --test 'computer/ai-chat/test/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const appSrc = read("../public/app.js");

test("SHE-53: report links are handled by delegation on #messages, not per-link listeners", () => {
  // A per-link click listener is lost when switchSessionTab restores a tab's DOM
  // via innerHTML, so restored reports fell through to target="_blank".
  assert.ok(!/a\.addEventListener\(\s*['"]click['"]/.test(appSrc),
    "no per-link click listener may remain in scanMessage");
  // The delegated handler keys off isBoxReport so it fires for restored + unmarked links.
  assert.match(appSrc, /E\.messages\?\.addEventListener\(\s*['"]click['"][\s\S]*?ReportPanel\.isBoxReport\(a\.href\)[\s\S]*?ReportPanel\.show\(a\.href\)/,
    "a delegated #messages click handler must open box reports in the panel");
});


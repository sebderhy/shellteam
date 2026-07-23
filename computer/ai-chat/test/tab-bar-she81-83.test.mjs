/**
 * Tab-bar regressions from the feedback relay:
 *   SHE-83/85 — the "+" new-tab button was shoved to the far-right edge,
 *               detached from the tabs and hard to find.
 *   SHE-81    — the running/generating dot was suppressed on the ACTIVE tab, so
 *               you couldn't tell which of two tabs was live.
 *
 * These are the source-level contracts behind those fixes; a markup/CSS refactor
 * that reverts either would fail here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(DIR, "../public/app.js"), "utf8");
const STYLES = readFileSync(join(DIR, "../public/styles.css"), "utf8");

test("SHE-83/85: the tab list sizes to its tabs so the + button sits beside them", () => {
  const rule = STYLES.match(/\.session-tab-list\s*\{([\s\S]*?)\}/);
  assert.ok(rule, ".session-tab-list rule exists");
  const body = rule[1];
  // flex:1 stretched the list across the whole bar and pushed the sibling +
  // button to the far right. It must shrink-to-content instead.
  assert.ok(/flex:\s*0\s+1\s+auto/.test(body), `expected flex:0 1 auto, got: ${body.trim()}`);
  assert.ok(!/flex:\s*1\s*;/.test(body), "must not stretch the list with flex:1");
});

test("SHE-81: the running dot shows on every generating tab, including the active one", () => {
  const line = APP_JS.match(/const generating = [^\n]*;/);
  assert.ok(line, "generating-class assignment exists in renderSessionTabs");
  // The old guard hid the dot on the tab you were viewing.
  assert.ok(
    !/slot\.id !== activeSlotId/.test(line[0]),
    `active-tab exclusion must be gone: ${line[0]}`,
  );
  assert.ok(/slot\.isGenerating/.test(line[0]), "dot is still driven by isGenerating");
  // The CSS dot itself is unchanged and animated.
  assert.ok(/\.session-tab\.generating::before/.test(STYLES), "generating dot rule present");
});

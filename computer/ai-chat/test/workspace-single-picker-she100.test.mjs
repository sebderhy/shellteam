/**
 * SHE-100 — the header workspace field was a second, worse picker: a free-text
 * combo with its own dropdown, blur-timing dance, and path expansion that
 * could disagree with the modal picker in the model menu ("it seems to work
 * better when I choose the workspace through the model's menu").
 *
 * Decision (Seb, 2026-08-21): keep the workspace visible AND clickable in the
 * top bar, but drive the exact same code path — the header element is now a
 * button into openWorkspacePicker(), and the combo machinery is gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "public/app.js"), "utf8");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const css = readFileSync(join(root, "public/styles.css"), "utf8");

test("the header workspace element opens the one modal picker", () => {
  const el = html.match(/<button[^>]*id="workspaceSelect"[^>]*>/);
  assert.ok(el, "header workspace element must be a button, not a free-text input");
  assert.match(el[0], /openWorkspacePicker\(\)/, "it must open the same picker as the model menu");
});

test("the second picker's machinery is gone", () => {
  for (const relic of [
    "workspaceDropdown", "selectWorkspace", "onWorkspaceInput",
    "showWorkspaceDropdown", "handleDirectoriesList", "_workspaceDropVisible",
  ]) {
    assert.ok(!app.includes(relic), `app.js must not keep combo relic "${relic}"`);
    assert.ok(!html.includes(relic), `index.html must not keep combo relic "${relic}"`);
  }
  assert.ok(!css.includes(".workspace-dropdown"), "dropdown CSS must be gone");
});

test("a new tab still inherits the displayed workspace before any slot has one", () => {
  // The combo's input.value used to be the fallback cwd for the first slot;
  // that job moved to _displayedCwd, kept by setWorkspaceDisplay.
  assert.match(app, /_displayedCwd = path \|\| null/, "setWorkspaceDisplay must record the cwd");
  assert.match(app, /config\.cwd \|\| _displayedCwd \|\| null/,
    "defaultSlotConfig must fall back to the displayed cwd");
});

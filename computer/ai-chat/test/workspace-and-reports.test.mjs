// Regression pins for three cockpit bugs reported 2026-07-06:
//   SHE-53 — report links opened in a new window after a tab switch.
//   SHE-54 — the header workspace combo and the AI-menu Workspace row diverged.
//   SHE-55 — a plain folder (~/avsv, not a git repo / under ~/projects) couldn't
//            be reached from the modal workspace picker.
//
// Run: node --test 'computer/ai-chat/test/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const appSrc = read("../public/app.js");
const serverSrc = read("../server.mjs");

test("SHE-53: report links are handled by delegation on #messages, not per-link listeners", () => {
  // A per-link click listener is lost when switchSessionTab restores a tab's DOM
  // via innerHTML, so restored reports fell through to target="_blank".
  assert.ok(!/a\.addEventListener\(\s*['"]click['"]/.test(appSrc),
    "no per-link click listener may remain in scanMessage");
  // The delegated handler keys off isBoxReport so it fires for restored + unmarked links.
  assert.match(appSrc, /E\.messages\?\.addEventListener\(\s*['"]click['"][\s\S]*?ReportPanel\.isBoxReport\(a\.href\)[\s\S]*?ReportPanel\.show\(a\.href\)/,
    "a delegated #messages click handler must open box reports in the panel");
});

test("SHE-54: changing the workspace updates every surface at once", () => {
  // Optimistically stamp the active slot's cwd so combo, AI menu and Info agree.
  assert.match(appSrc, /function changeWorkspace\(cwd\)\s*\{[\s\S]*?slot\.config\.cwd = cwd[\s\S]*?renderAIMenuValues\(\)/,
    "changeWorkspace must set slot.config.cwd and refresh the AI menu");
  // cwd_changed from the server also refreshes the AI menu row.
  assert.match(appSrc, /cwd_changed[\s\S]*?setWorkspaceDisplay\(msg\.cwd\)[\s\S]*?renderAIMenuValues\(\)/,
    "cwd_changed must refresh the AI menu Workspace row");
  // Blur snaps the combo back to the real cwd so no stale typed text lingers.
  assert.match(appSrc, /addEventListener\(\s*['"]blur['"][\s\S]*?setWorkspaceDisplay\(currentCwd\(\)\)/,
    "the workspace combo must revert uncommitted text to the real cwd on blur");
});

test("SHE-55: the modal workspace picker live-searches real directories", () => {
  for (const fn of ["renderWorkspacePickerList", "onWorkspacePickerInput", "workspacePickerVisible"]) {
    assert.match(appSrc, new RegExp(`function ${fn}\\(`), `${fn}() must be defined`);
  }
  // Typing sends list_directories for the typed path's parent…
  assert.match(appSrc, /onWorkspacePickerInput[\s\S]*?type: 'list_directories', prefix: parent/,
    "the picker input must query list_directories for the parent dir");
  // …and directories_list is routed to the picker while it's open.
  assert.match(appSrc, /directories_list[\s\S]*?workspacePickerVisible\(\)[\s\S]*?_pickerDirs = msg\.dirs/,
    "directories_list must feed the picker when it is visible");
  // A "Switch to <typed path>" row makes any real folder one click (not Enter-only),
  // and it routes through jsArg (XSS pin carried from the SHE-13 review).
  assert.match(appSrc, /pickWorkspace\('\$\{jsArg\(typed\)\}'\)[\s\S]*?Switch to \$\{escHtml\(shortPath\(typed\)\)\}/,
    "the picker must offer a jsArg-escaped click row for the exact typed path");
});

test("server list_directories still backs the picker search", () => {
  assert.match(serverSrc, /case "list_directories"/, "server must handle list_directories");
});

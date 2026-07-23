// Pins for the grouped header controls (AI / Info / System menus).
//
// The mobile redesign replaced the 7 inline desktop buttons + flat kebab with
// three grouped menus present at every width, and replaced the inline
// <select id="modelSelect"> with a modal model picker. These tests pin the
// wiring so a refactor can't silently resurrect the old dual-surface layout
// or leave a dangling modelSelect reference (every one of those would be a
// runtime TypeError on load).
//
// Run: node --test 'computer/ai-chat/test/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const html = read("../public/index.html");
const appSrc = read("../public/app.js");
const dropdownSrc = read("../public/dropdown.js");
const editorSrc = read("../../file-editor.html");

function loadPathLinkHarness() {
  const end = appSrc.indexOf("// --- Path \u2192 URL linkification");
  assert.ok(end > 0, "app.js path-link section marker must exist");
  const src = appSrc
    .slice(0, end)
    // Browser global-name semantics make `window.App` visible as `App`; Node's
    // VM does not, so model that explicitly for the partial frontend harness.
    .replace("window.App =", "var App = window.App =");
  const context = {
    console,
    window: {},
    document: { getElementById: () => ({ value: "" }) },
    location: {
      protocol: "https:",
      hostname: "owner-3456.example.com",
      host: "owner-3456.example.com",
    },
    setTimeout,
    clearTimeout,
    expandPath: () => null,
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

test("index.html carries the three grouped header menus", () => {
  for (const id of ["aiMenu", "infoPanel", "sysMenu", "actionsBackdrop"]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} must exist in the header`);
  }
  // Second-level pickers behind the AI menu
  for (const id of ["modelPicker", "workspacePicker"]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} modal must exist`);
  }
});

test("the old inline model <select> is gone — no dangling references", () => {
  assert.ok(!html.includes('id="modelSelect"'), "index.html must not ship the old <select>");
  assert.ok(!appSrc.includes("getElementById('modelSelect')"),
    "app.js must not reference the removed #modelSelect (would TypeError at runtime)");
});

test("app.js defines the menu renderers dropdown.js dispatches to", () => {
  for (const fn of ["renderInfoPanel", "renderAIMenuValues", "openModelPicker",
                    "openWorkspacePicker", "setModelDisplay", "updateInfoWarning"]) {
    assert.match(appSrc, new RegExp(`function ${fn}\\(`), `${fn}() must be defined`);
  }
  for (const hook of ["renderInfoPanel", "renderAIMenuValues"]) {
    assert.ok(dropdownSrc.includes(hook), `Menus.toggle must render ${hook} on open`);
  }
});

test("ActionsMenu compat shim survives (session actions call ActionsMenu.hide())", () => {
  assert.match(dropdownSrc, /window\.ActionsMenu\s*=/,
    "ActionsMenu must remain defined — newSession/compactSession/terminal.js call it");
});

test("the Cost row qualifies the figure by billing mode (never reads as a bill on subscription)", () => {
  // Agents report API-list cost even on subscription; the panel must say the
  // money was not actually charged.
  assert.match(appSrc, /covered by your subscription, nothing billed/,
    "subscription cost note missing");
  assert.match(appSrc, /billed to your API key/, "apikey cost note missing");
});

test("inline-handler args go through jsArg, not bare escHtml", () => {
  // escHtml alone cannot protect onclick="fn('…')": the browser decodes
  // &#39; back to a raw ' before the JS parser sees the attribute, so a
  // workspace path like ~/it's-mine would terminate the JS string. jsArg
  // JS-escapes first, then HTML-escapes.
  assert.match(appSrc, /function jsArg\(/, "jsArg() must be defined");
  for (const site of ["pickModel('${jsArg(", "pickWorkspace('${jsArg(",
                      "selectWorkspace('${jsArg(", "resumeSession('${jsArg("]) {
    assert.ok(appSrc.includes(site), `${site}…)')" must use jsArg`);
  }
  // No inline handler may interpolate into a JS string without it.
  const bare = appSrc.match(/on[a-z]+="[^"]*'\$\{(?!jsArg\()[^}]*\}/g) || [];
  assert.deepEqual(bare, [], "inline handlers interpolating non-jsArg values");
});

test("bare filenames are not auto-linked as editor paths", () => {
  // `models.json` in prose/code is often just a basename. The cockpit used to
  // resolve it against the active cwd and emit dead links like
  // /_editor/shellteam/models.json when the real file was elsewhere.
  const { editorLink } = loadPathLinkHarness();
  assert.equal(editorLink("models.json"), null, "bare basenames must not become editor links");
  assert.match(editorLink("config/models.json"), /\/_editor\/config\/models\.json$/,
    "explicit relative paths with a directory segment should still link");
});

test("editor deep links normalize native absolute home paths", () => {
  assert.match(editorSrc, /filePath\.replace\(\s*\/\^home\\\/\[\^\/\]\+\\\//,
    "the editor must strip /home/<user>/, not only /home/user/");
});

test("aiMenu items carry unique mnemonic keys that match their underlined letter", () => {
  // Each AI-menu row has a data-key; pressing that letter while the menu is open
  // activates the row (dropdown.js). The letter must also be the one underlined
  // in the label (<span class="actions-mn">X</span>) so the hint matches the key,
  // and no two rows may share a key.
  const menu = html.match(/id="aiMenu"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(menu, "aiMenu block must be found");
  const items = menu[0].match(/<button class="actions-item"[^>]*data-key="[^"]*"[\s\S]*?<\/button>/g) || [];
  assert.ok(items.length >= 7, `expected >=7 keyed items, got ${items.length}`);
  const seen = new Set();
  for (const item of items) {
    const key = item.match(/data-key="([a-z])"/)?.[1];
    const mn = item.match(/class="actions-mn">([A-Za-z])</)?.[1];
    assert.ok(key, `item missing data-key: ${item.slice(0, 60)}`);
    assert.ok(mn, `item ${key} missing an .actions-mn underline`);
    assert.equal(mn.toLowerCase(), key, `mnemonic "${mn}" must match data-key "${key}"`);
    assert.ok(!seen.has(key), `duplicate mnemonic key "${key}"`);
    seen.add(key);
  }
  // Rewind + Compact are the examples the user asked for by name.
  assert.ok(seen.has("r") && seen.has("c"), "r (Rewind) and c (Compact) must be mapped");
});

test("dropdown.js activates the open menu's item by matching data-key", () => {
  // The keydown handler must scope to the open menu, ignore modifier combos, and
  // click the item whose data-key equals the pressed letter.
  assert.match(dropdownSrc, /data-key="\$\{[^}]*\}"/, "must query items by data-key");
  assert.match(dropdownSrc, /metaKey \|\| e\.ctrlKey \|\| e\.altKey/, "must ignore modifier combos");
  assert.match(dropdownSrc, /this\._openId/, "must scope to the currently open menu");
});

test("dropdown.js gives the open menu full keyboard navigation", () => {
  // Arrow/Home/End move a .kbd-active highlight over native menuitem buttons;
  // Enter activates one. Separators are skipped by their distinct role.
  for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"]) {
    assert.ok(dropdownSrc.includes(`'${k}'`), `dropdown.js must handle ${k}`);
  }
  assert.match(dropdownSrc, /kbd-active/, "must toggle a .kbd-active highlight");
  assert.match(dropdownSrc, /querySelectorAll\('\[role="menuitem"\]'\)/, "must collect semantic rows to navigate");
  const css = read("../public/styles.css");
  assert.match(css, /\.actions-item\.kbd-active/, "styles.css must style the keyboard highlight");
});

test("menu actions are native buttons with menuitem semantics", () => {
  const genericActions = html.match(/<div class="actions-item"/g) || [];
  assert.deepEqual(genericActions, [], "interactive menu rows must not be generic divs");
  const menuitems = html.match(/<button class="actions-item"[^>]*role="menuitem"[^>]*tabindex="-1"/g) || [];
  assert.ok(menuitems.length >= 10, `expected at least 10 semantic menu actions, got ${menuitems.length}`);
  for (const id of ["btnAI", "btnInfo", "btnSys"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-controls="[^"]+"[^>]*aria-expanded="false"`),
      `${id} must expose controlled and expanded state`);
  }
});

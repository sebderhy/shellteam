// Pins for the chat header (docs/plans/active/cockpit-map/prd.md).
//
// The header holds four controls, each opening one kind of thing: the chat's
// title (the chat menu), this chat's reports, the agent and model (the model
// list and nothing else), and the usage ring. The model button used to hold
// eight unrelated things, next to an Info button and a gear; these tests pin
// the map so a refactor can't put them back, or leave a dangling reference to
// a removed element (every one of those would be a runtime TypeError on load).
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
const projectsSrc = read("../public/projects.js");
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

test("the header holds four controls, each opening one kind of thing (U4)", () => {
  for (const id of ["pjTitle", "chatMenu", "btnAI", "quotaMeter", "quotaPanel", "infoPanel", "actionsBackdrop", "modelPicker"]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} must exist`);
  }
  // The model button opens the model list directly: no menu in between.
  assert.match(html, /id="btnAI"[^>]*onclick="openModelPicker\(\)"/);
  // Gone from the header: the 8-item AI menu, the Info button, the gear, the
  // help button, the folder switcher. Their actions live in the chat menu,
  // the jump box and Settings.
  for (const id of ["aiMenu", "btnInfo", "btnSys", "sysMenu", "btnHelp", "workspaceCombo", "workspacePicker", "contextMeter"]) {
    assert.ok(!html.includes(`id="${id}"`), `#${id} must be gone from the header`);
    assert.ok(!appSrc.includes(`getElementById('${id}')`), `app.js must not reference the removed #${id}`);
  }
});

test("nothing is lost (U8): what left the header is in the chat menu, the jump box and Settings", () => {
  const rows = projectsSrc.match(/\n    function chatMenuRows\(\) \{[\s\S]*?\n    \}\n/)[0];
  for (const run of ["beginRenameOn", "openMoveDialog", "setTabUnread", "openModelPicker", "compactSession", "forkSession",
                     "rewindSession", "newSession", "showSessionPicker", "closeSessionTab", "Menus.toggle('reportsMenu')",
                     "togglePanel", "Menus.toggle('infoPanel')"]) {
    assert.ok(rows.includes(run), `the chat menu must offer ${run}`);
  }
  const jump = projectsSrc.match(/\n    function jumpItems\(\) \{[\s\S]*?\n    \}\n/)[0];
  for (const run of ["openAIConfig", "TerminalMode.toggle()", "showShortcutsHelp"]) {
    assert.ok(jump.includes(run), `the jump box must offer ${run}`);
  }
});

test("the old inline model <select> is gone — no dangling references", () => {
  assert.ok(!html.includes('id="modelSelect"'), "index.html must not ship the old <select>");
  assert.ok(!appSrc.includes("getElementById('modelSelect')"),
    "app.js must not reference the removed #modelSelect (would TypeError at runtime)");
});

test("the menu renderers dropdown.js dispatches to are defined", () => {
  for (const fn of ["renderInfoPanel", "renderQuotaPanel", "renderReportsMenu", "openModelPicker", "setModelDisplay", "updateInfoWarning"]) {
    assert.match(appSrc, new RegExp(`function ${fn}\\(`), `${fn}() must be defined`);
  }
  for (const hook of ["renderInfoPanel", "renderQuotaPanel", "renderReportsMenu", "renderChatMenu"]) {
    assert.ok(dropdownSrc.includes(hook), `Menus.toggle must render ${hook} on open`);
  }
  assert.match(projectsSrc, /function renderChatMenu\(\)/);
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
  for (const site of ["pickModel('${jsArg(", "resumeSession('${jsArg("]) {
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

test("chat menu rows carry unique mnemonic keys that are a letter of their label", () => {
  // Each row has a key; pressing that letter while the menu is open (also
  // after "/") runs the row (dropdown.js). The letter is underlined in the
  // label by renderChatMenu, so it must be in it, and no two rows share one.
  const rows = [...projectsSrc.matchAll(/row\('([a-z.-]+)', '([a-z]?)', '[a-z]+', ([^,]+),/g)];
  assert.ok(rows.length >= 12, `expected >=12 rows, got ${rows.length}`);
  const seen = new Set();
  for (const [, use, key, label] of rows) {
    if (!key) continue;
    assert.ok(!seen.has(key), `duplicate mnemonic key "${key}" (${use})`);
    seen.add(key);
    // A label that is a plain string must contain its key; computed labels
    // ("Mark as read/unread", "Move to...") are checked by their constant part.
    assert.ok(label.toLowerCase().includes(key), `"${label}" has no letter "${key}" (${use})`);
  }
  // Rewind + Compact are the examples the owner asked for by name; the old
  // AI-menu letters keep working.
  for (const k of ["m", "n", "s", "f", "r", "c"]) assert.ok(seen.has(k), `${k} must stay mapped`);
  assert.match(projectsSrc, /<span class="actions-mn">/, "the key's letter is underlined in the label");
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
  const generic = [...html.matchAll(/<div class="actions-item"/g), ...projectsSrc.matchAll(/<div class="actions-item"/g)];
  assert.deepEqual(generic, [], "interactive menu rows must not be generic divs");
  assert.match(projectsSrc, /<button class="actions-item" type="button" role="menuitem" tabindex="-1" data-row=/);
  for (const id of ["pjTitle", "quotaMeter"]) {
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]{0,200}?aria-controls="[^"]+"[\\s\\S]{0,40}?aria-expanded="false"`),
      `${id} must expose controlled and expanded state`);
  }
});

test("SHE-208: Rewind sits next to Compact in the usage panel, one click from the header", () => {
  // The owner, the day the header was redone: "Rewind has disappeared. It's a
  // critical feature, I use it all the time. It should be next to compact."
  // It had moved into the chat menu only, while Compact also got a button in
  // the usage ring's panel, which is where he looked.
  const panel = appSrc.match(/\nfunction renderQuotaPanel\(\) \{[\s\S]*?\n\}\n/)[0];
  const actions = panel.match(/<div class="quota-actions">[\s\S]*?<\/div>/);
  assert.ok(actions, "the two actions share one row");
  assert.match(actions[0], /data-use="chat\.compact\.ring" onclick="compactSession\(\)"/);
  assert.match(actions[0], /data-use="chat\.rewind\.ring" onclick="rewindSession\(\)"/);
  assert.ok(actions[0].indexOf("compactSession") < actions[0].indexOf("rewindSession"), "Compact, then Rewind");
  assert.match(actions[0], />Rewind<\/button>/);
  // Rewinding needs a conversation and an agent that is not mid-reply, like compacting.
  assert.equal((actions[0].match(/\$\{canCompact \? '' : 'disabled'\}/g) || []).length, 2);
  // It closes the panel it was clicked in, like Compact does.
  assert.match(appSrc, /function rewindSession\(\) \{[\s\S]{0,400}?ActionsMenu\.hide\(\)|function rewindSession\(\) \{[\s\S]{0,400}?Menus\.hide\(\)/);
  // And it is still in the chat menu, right under Compact.
  const rows = projectsSrc.match(/\n    function chatMenuRows\(\) \{[\s\S]*?\n    \}\n/)[0];
  assert.ok(rows.indexOf("'chat.compact'") < rows.indexOf("'chat.rewind'") && rows.indexOf("'chat.rewind'") < rows.indexOf("'chat.fork'"));
  const css = read("../public/projects.css");
  assert.match(css, /\.quota-actions \{ display: flex; gap: 8px;/);
  // Daily on a phone too: 44 px of touch.
  assert.match(css.slice(css.indexOf("@media (max-width: 720px)")), /\.quota-action \{ min-height: 44px;/);
});

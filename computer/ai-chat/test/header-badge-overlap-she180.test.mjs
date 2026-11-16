// SHE-180: with a report open in the side panel the chat header ran out of
// room and the "Included" badge sat on top of the model button. Since the
// cockpit map the header shows usage as one ring, which never shrinks, and a
// badge only when it says something to act on. The cost warning never hides:
// on a phone, where a badge has no room, the ring carries an amber dot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/${rel}`, import.meta.url)), "utf8");
const css = read("projects.css");
const app = read("app.js");

test("the usage ring never shrinks, whatever sits beside it", () => {
  assert.match(css, /\n\.subscription-monitor \{[^}]*flex: none;/);
  assert.match(css, /\n\.status-right \{[^}]*flex: none;/);
  assert.match(css, /\.use-ring \{ width: 22px; height: 22px; flex: none;/);
});

test("a subscription shows no badge; a key billed per use always says so", () => {
  assert.match(app, /el\.hidden = !spec \|\| spec\.cls === 'sub';/);
  // Phone: no room for the badge, so the ring's amber dot flags it.
  const phone = css.slice(css.indexOf("@media (max-width: 720px)"));
  assert.match(phone, /\.quota-meter \.auth-badge \{ display: none; \}/);
  const warn = app.match(/\nfunction updateInfoWarning\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(warn, /getElementById\('quotaMeter'\)/);
  assert.match(warn, /mode === 'apikey' \|\| mode === 'none'/);
  assert.match(css, /\.quota-meter\.warn::after \{/);
});

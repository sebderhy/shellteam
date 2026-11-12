// SHE-180: with a report open in the side panel the chat header ran out of
// room and the "Included" badge sat on top of the model button. The badge and
// its usage bar must never shrink; the quiet badges step aside in the narrow
// band where the column sits beside the chat. The cost warning never hides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../public/projects.css", import.meta.url)), "utf8");

test("the billing badge and its usage bar do not shrink in the projects layout", () => {
  assert.match(css, /html\.layout-projects \.subscription-monitor, html\.layout-projects \.quota-meter \{ flex-shrink: 0; \}/);
});

test("the quiet badges hide only between the phone breakpoint and 860px, never the metered one", () => {
  const band = css.match(/@media \(min-width: 721px\) and \(max-width: 860px\) \{([\s\S]*?)\n\}/);
  assert.ok(band, "narrow band rule found");
  assert.match(band[1], /#authBadge\.inc/);
  assert.match(band[1], /#authBadge\.sub/);
  assert.doesNotMatch(band[1], /#authBadge\.api/);
  assert.doesNotMatch(band[1], /#authBadge\.off/);
});

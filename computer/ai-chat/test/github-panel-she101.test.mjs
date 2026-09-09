/**
 * SHE-101 — the GitHub card in dashboard Settings was framed at a fixed 300px
 * while its connected state (repo list + clone button) is ~600px tall: the
 * card's top clipped (flex centering) and the iframe stacked a second
 * scrollbar on the repo list's. The card now reports its height and the
 * dashboard sizes the frame to fit; the card safe-centers via margin:auto.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cockpit = join(dirname(fileURLToPath(import.meta.url)), "..");
const github = readFileSync(join(cockpit, "public/github.html"), "utf8");
const frontend = join(cockpit, "..", "..", "frontend");
const dashboard = readFileSync(join(frontend, "dashboard.html"), "utf8");
const apps = readFileSync(join(frontend, "apps.html"), "utf8");
// The height listener + frame mount moved into one shared script when the
// card gained a second embedder (the Apps tab); both shells must load it.
const mount = readFileSync(join(frontend, "static/github-frame.js"), "utf8");

test("the card reports its height to the embedder", () => {
  assert.match(github, /ResizeObserver/);
  assert.match(github, /shellteam:github-card-height/);
});

test("every embedder resizes the frame from the report", () => {
  assert.match(mount, /shellteam:github-card-height/);
  assert.match(mount, /data-github-card/);
  for (const shell of [dashboard, apps]) {
    assert.match(shell, /\/static\/github-frame\.js/);
    assert.match(shell, /mountGitHubFrame\(/);
  }
});

test("a card taller than the frame overflows evenly instead of clipping its top", () => {
  // Flex centering (align-items: center) clips overflow at the top; the card
  // must center with margin:auto instead.
  const bodyRule = github.match(/body \{[^}]*\}/);
  assert.ok(bodyRule && !/align-items:\s*center/.test(bodyRule[0]),
    "github.html body must not flex-center — that clips an overflowing card");
  assert.match(github, /\.card \{[^}]*margin: auto/, ".card must safe-center via margin:auto");
});

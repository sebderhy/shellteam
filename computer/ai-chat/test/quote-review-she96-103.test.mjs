/**
 * Quote-to-comment tray regressions.
 *
 * SHE-96 — a comment written into the tray came back as a clipped single line
 * after a tab switch: autosize() measured scrollHeight at render time, and a
 * tray rendered before layout measures 0. The fix removes JS measurement
 * entirely — a .qc-grow grid wrapper whose ::after mirrors the text sizes the
 * field in pure CSS.
 *
 * SHE-103 — merely hovering a comment chip scrolled the transcript to the
 * quoted source, yanking the view away while the user scrolls near the bottom
 * (the tray sits in the cursor's natural path). Hover may only flash; scrolling
 * to the source must be an explicit click.
 *
 * Static contract tests in the style of composer-collapse: they pin wiring a
 * headless suite cannot exercise via real layout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const js = readFileSync(join(root, "public/quote-review.js"), "utf8");
const css = readFileSync(join(root, "public/styles.css"), "utf8");

test("SHE-96: comment height comes from CSS, never from a scrollHeight measurement", () => {
  assert.ok(
    !/\.scrollHeight\b|style\.height\s*=/.test(js),
    "quote-review.js must not measure scrollHeight or set style.height — a " +
    "tray rendered before layout measures 0 and collapses filled comments",
  );
  assert.match(js, /class="qc-grow" data-rep=/, "textarea must be wrapped in the .qc-grow mirror");
  assert.match(js, /dataset\.rep = ta\.value/, "typing must keep the mirror in sync");
  const grow = css.match(/\.qc-grow::after\s*\{[^}]*\}/);
  assert.ok(grow, ".qc-grow::after sizing rule missing from styles.css");
  assert.match(grow[0], /content:\s*attr\(data-rep\)/, "::after must mirror the comment text");
});

test("SHE-96: mirror and textarea share one grid cell with identical metrics", () => {
  const shared = css.match(/\.qc-grow::after,\s*\.qc-comment\s*\{[^}]*\}/);
  assert.ok(shared, "shared ::after + .qc-comment rule missing");
  for (const prop of ["grid-area", "font-size", "line-height", "padding", "max-height"]) {
    assert.match(shared[0], new RegExp(prop), `shared rule must pin ${prop}`);
  }
});

test("SHE-103: hover flashes, only an explicit click scrolls the transcript", () => {
  // scrollIntoView may appear only inside click handlers, never in mouseenter.
  const enterBlocks = [...js.matchAll(/addEventListener\('mouseenter',[\s\S]*?\n\s*\}\);/g)];
  assert.ok(enterBlocks.length > 0, "chip mouseenter handler missing");
  for (const b of enterBlocks) {
    assert.ok(
      !/scrollIntoView/.test(b[0]),
      "mouseenter must not scroll the transcript — that is the SHE-103 yank",
    );
  }
  const clickScroll = /\.qc-quote'\)\?\.addEventListener\('click'[\s\S]*?scrollIntoView/;
  assert.match(js, clickScroll, "clicking the quote row must scroll to the source");
});

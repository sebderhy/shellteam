/**
 * Review by pointing (docs/decisions/20260920-report-review-picker.md).
 *
 * The owner clicks an element of the HTML file shown in the side panel; the
 * dashboard relays {path, selector, text} to the cockpit, which stacks it in
 * the quote tray and sends it in the owner's "> quote / --> comment" convention
 * with a file › selector pointer line on top. These tests pin:
 *   - the relay only accepts messages from the parent frame;
 *   - the assembled message carries path, selector and the quoted text;
 *   - refs survive the per-tab getQuotes()/setQuotes() round trip;
 *   - the picker itself never talks to anything but its parent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const js = readFileSync(join(root, "public/quote-review.js"), "utf8");
const appJs = readFileSync(join(root, "public/app.js"), "utf8");
const pickerJs = readFileSync(join(root, "../../frontend/review-picker.js"), "utf8");
const dashboard = readFileSync(join(root, "../../frontend/dashboard.html"), "utf8");

// Minimal DOM double: enough for init() to bind and for render() to run.
function fakeEl() {
  const el = {
    innerHTML: "", classList: { add() {}, remove() {}, contains: () => false },
    style: {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  };
  return el;
}
function loadTray() {
  const els = { messages: fakeEl(), quoteTray: fakeEl(), quoteSelPill: fakeEl() };
  const window = { addEventListener() {}, getSelection: () => null };
  const document = { getElementById: (id) => els[id], addEventListener() {} };
  const fn = new Function("window", "document", `${js}\nreturn window.QuoteReview;`);
  const QR = fn(window, document);
  QR.init();
  return { QR, els };
}

test("a report pick assembles as a path › selector pointer plus the quoted text", () => {
  const { QR } = loadTray();
  QR.addFromReport({ path: "reports/deck.html", selector: "section#pricing > p.lead", text: "Starter plan", comment: "" });
  assert.equal(QR.assemble(), '> reports/deck.html › section#pricing > p.lead\n> "Starter plan"');
  assert.ok(QR.hasContent());
});

test("a relayed comment (edit fallback) is sent as the --> line", () => {
  const { QR } = loadTray();
  QR.addFromReport({ path: "reports/deck.html", selector: "h1", text: "Deck", comment: 'Replace this text with: "Pitch"' });
  assert.equal(QR.assemble(), '> reports/deck.html › h1\n> "Deck"\n--> Replace this text with: "Pitch"');
});

test("the tray render shows the file and selector on a report pick", () => {
  const { QR, els } = loadTray();
  QR.addFromReport({ path: "reports/deck.html", selector: "p.lead", text: "Hello" });
  assert.match(els.quoteTray.innerHTML, /qc-ref/);
  assert.match(els.quoteTray.innerHTML, /deck\.html › p\.lead/);
  assert.match(els.quoteTray.innerHTML, /on the document/);
});

test("refs survive the per-tab getQuotes/setQuotes round trip", () => {
  const { QR } = loadTray();
  QR.addFromReport({ path: "reports/deck.html", selector: "h1", text: "Deck" });
  const saved = JSON.parse(JSON.stringify(QR.getQuotes()));
  QR.clear();
  assert.equal(QR.assemble(), "");
  QR.setQuotes(saved);
  assert.equal(QR.assemble(), '> reports/deck.html › h1\n> "Deck"');
});

test("malformed relays are ignored", () => {
  const { QR } = loadTray();
  QR.addFromReport({ selector: "h1", text: "x" });          // no path
  QR.addFromReport({ path: "reports/a.html", text: "x" });   // no selector
  assert.ok(!QR.hasContent());
});

test("the cockpit accepts report comments from its parent frame only", () => {
  const block = appJs.match(/window\.addEventListener\('message', \(e\) => \{[\s\S]*?report-comment[\s\S]*?\n\}\);/);
  assert.ok(block, "report-comment relay listener missing from app.js");
  assert.match(block[0], /e\.source !== window\.parent/, "must refuse messages not sent by the parent");
  assert.match(block[0], /d\.source !== 'shellteam-dashboard'/);
});

test("the picker is inert outside a frame and never reaches the API itself", () => {
  assert.match(pickerJs, /if \(window\.parent === window\) return;/);
  assert.ok(!/fetch\(|XMLHttpRequest|\/_api\//.test(pickerJs), "picker must only postMessage to its parent");
  assert.match(pickerJs, /e\.source !== window\.parent/, "mode changes accepted from the parent only");
});

test("the dashboard relays picks from the report frame only and saves edits through the origin-gated route", () => {
  assert.match(dashboard, /d\.source === 'shellteam-report' && e\.source === frame\.contentWindow/);
  assert.match(dashboard, /fetch\('\/api\/computers\/reports\/edit'/);
  // A refused (409) save must go to the agent, not vanish.
  assert.match(dashboard, /r\.status === 409[\s\S]*?sendToChat\(/);
  for (const id of ["reportCommentBtn", "reportEditBtn"]) {
    assert.match(dashboard, new RegExp(`id="${id}" hidden`), `${id} must start hidden until the picker reports in`);
  }
});

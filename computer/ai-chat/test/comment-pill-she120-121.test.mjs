// The Comment pill on selected reply text (Seb, 2026-10-24).
// SHE-121: triple-click a reply's last paragraph and the selection ends at the
// start of whatever follows the reply, so the pill never appeared.
// SHE-120: on a phone the pill sat right above the selection, under Android's
// own Copy/Share toolbar, and only updated on touchend, which dragging the
// native selection handles never fires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const src = readFileSync(fileURLToPath(new URL("../public/quote-review.js", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");

function replyRangeFn() {
  const line = src.match(/ {4}const replyOf = .*\n/)[0];
  const start = src.indexOf("    function replyRange(sel) {");
  const fn = src.slice(start, src.indexOf("\n    }\n", start) + 6);
  const ctx = { Node: { ELEMENT_NODE: 1 } };
  vm.createContext(ctx);
  return vm.runInContext(`${line}${fn}; replyRange`, ctx);
}

// A tiny DOM: elements know which reply content they sit in.
const content = { nodeType: 1, childNodes: [1, 2], closest: () => content };
const para = { nodeType: 1, closest: () => content };
const text = { nodeType: 3, parentElement: para };
const userMsg = { nodeType: 1, closest: () => null };
function selection(startContainer, endContainer) {
  const range = { startContainer, endContainer, setEnd(n, o) { this.endContainer = n; this.endOffset = o; } };
  return { getRangeAt: () => ({ cloneRange: () => ({ ...range }) }) };
}

test("SHE-121: a triple-click that spills into the next message ends at the end of the reply", () => {
  const replyRange = replyRangeFn();
  const r = replyRange(selection(text, userMsg));
  assert.equal(r.endContainer, content);
  assert.equal(r.endOffset, 2);
});

test("SHE-121: a selection ending on an element inside the reply is kept as is", () => {
  const replyRange = replyRangeFn();
  assert.equal(replyRange(selection(text, para)).endContainer, para);
  assert.equal(replyRange(selection(userMsg, text)), null, "a selection starting outside replies gets no pill");
});

test("SHE-120: on touch screens the pill follows selectionchange and is pinned clear of the phone toolbar", () => {
  assert.match(src, /addEventListener\('selectionchange'[\s\S]*?touchScreen\(\)[\s\S]*?showPillForSelection/);
  assert.match(src, /matchMedia\('\(pointer: coarse\)'\)/);
  assert.match(src, /pill\.classList\.add\('pinned'\)/);
  assert.doesNotMatch(src, /addEventListener\('touchend'/, "touchend never fires for native handle drags");
  assert.match(css, /\.quote-sel-pill\.pinned \{[^}]*min-height: 44px/, "a phone-size tap target");
});

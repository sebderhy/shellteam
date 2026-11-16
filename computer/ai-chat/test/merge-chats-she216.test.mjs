// SHE-216: merging chats broke in the projects column (cockpit map, 15 Nov).
// The tab bar it replaced merged a tab dropped on the middle of another and
// reordered on its edges (SHE-128); the column only reordered. Its menu
// offered the first 6 chats of the project in creation order, so a newer chat,
// the likely target, was never offered ("SovereignAI" into "SovereignAI2").
//
// Run: node --test computer/ai-chat/test/merge-chats-she216.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const projects = read("../public/projects.js");
const css = read("../public/projects.css");

test("the chat menu offers every chat of the project as a merge target, in the column's order", () => {
  const menu = projects.slice(projects.indexOf("function agentMenu("), projects.indexOf("function projectMenu("));
  assert.doesNotMatch(menu, /siblings\.slice\(/, "no cut-off: every chat of the project");
  assert.match(menu, /visibleOrder\(\)/, "ordered as the column shows them, newest activity first");
  assert.match(menu, /Merge into "\$\{slotDisplayLabel\(other\)\}"/);
});

test("dropping a chat on the middle of another chat of the project merges it; the edges reorder", () => {
  const drag = projects.slice(projects.indexOf("// Drag an agent"), projects.indexOf("side.addEventListener('dragend'"));
  assert.match(drag, /merge-target/, "the drop target shows it will merge");
  assert.match(drag, /mergeZone\(/, "the middle half of a row is the merge zone");
  assert.match(drag, /mergeTabs\(id, Number\(target\.dataset\.slot\)\)/, "a drop there merges");
  assert.match(drag, /commitTabReorder\(/, "the edges still reorder");
  assert.match(css, /\.pj-ag\.merge-target\s*\{/, "styled");
});

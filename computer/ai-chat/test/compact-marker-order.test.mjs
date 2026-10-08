/**
 * "Context compacted" must sit between what happened before and after the
 * compaction. Bug: tool calls kept going into the assistant bubble opened
 * BEFORE the marker, so the marker showed up after actions that happened
 * after it. Fix: the marker closes the open bubble.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const chat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public/chat.js"), "utf8");

test("a compacted marker closes the open assistant bubble", () => {
  const m = chat.match(/_handleSessionEvent\(msg\) \{\n\s+if \(msg\.event === 'compacted'\) \{[\s\S]*?\n        \} else if/);
  assert.ok(m, "compacted branch missing from chat.js");
  const body = m[0].replace(/\} else if$/, "").replace(/^_handleSessionEvent\(msg\) \{/, "");

  const appended = [];
  const App = { el: { messages: { appendChild: (e) => appended.push(e) } } };
  const document = { getElementById: () => null, createElement: () => ({}) };
  const setStatus = () => {};
  const scrollToBottom = () => {};
  const chatObj = { currentAssistantEl: { open: true }, currentTextEl: { open: true } };
  new Function("App", "document", "setStatus", "scrollToBottom", "msg", `${body} }`).call(
    chatObj, App, document, setStatus, scrollToBottom, { event: "compacted" });

  assert.equal(appended.length, 1, "marker appended");
  assert.equal(chatObj.currentAssistantEl, null, "next tool call must open a bubble below the marker");
  assert.equal(chatObj.currentTextEl, null);
});

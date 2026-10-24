// Reports in a long tab (Seb, 2026-10-24): "reports built after a compact are
// forgotten (not accessible via the button anymore)". The reports list counts
// the links on screen, and a long tab only shows its first 20 and last 480
// messages: in his main tab the list showed 0 of 8 reports. A live compaction
// was worse, cutting the tab down to its last 3 messages on every device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-long-reports-"));
const { capHistory } = await import("../lib/history.mjs");

const REPORT = "https://seb.example.com/reports/landscape.html";
const filler = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ type: "text_done", text: `chunk ${from + i}` }));

test("the elided middle keeps the links it held, on the marker", () => {
  const msgs = [...filler(100), { type: "text_done", text: `Here: [the report](${REPORT}).` }, ...filler(600, 100)];
  const capped = capHistory(msgs);
  const marker = capped.find((m) => m.event === "truncated");
  assert.ok(capped.length <= 501);
  assert.deepEqual(marker.links, [REPORT], "markdown punctuation is not part of the link");
});

test("capping again folds into the existing marker instead of losing its links", () => {
  let h = capHistory([...filler(100), { type: "text_done", text: `See ${REPORT}` }, ...filler(600, 100)]);
  for (const m of filler(300, 700)) h = capHistory([...h, m]);
  const markers = h.filter((m) => m.event === "truncated");
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0].links, [REPORT]);
  assert.equal(markers[0].count, 1001 - 500, "every hidden message is counted once");
});

test("a live compaction keeps the conversation before it", async () => {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}`);
  sm.setBroadcast(() => {});
  sm.createSlot(930001, { model: "claude-opus-5" });
  const agent = new (class extends EventEmitter { stop() {} interrupt() {} })();
  sm._testInjectAgent(930001, agent);
  agent.emit("text_done", { text: `Built it: ${REPORT}` });
  for (let i = 0; i < 5; i++) agent.emit("text_done", { text: `step ${i}` });
  agent.emit("session_event", { event: "compacted" });
  const history = sm.getHistory(930001);
  assert.equal(history[0].text, `Built it: ${REPORT}`, "was trimmed to the last 3 messages");
  assert.equal(history.at(-1).event, "compacted");
});

test("the reports list reads the marker's links, oldest first", () => {
  const src = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");
  const start = src.indexOf("    listIn(container) {");
  const body = src.slice(start, src.indexOf("\n    },", start) + 7);
  const ctx = { location: new URL("https://seb-3456.example.com/"), URL };
  vm.createContext(ctx);
  const panel = vm.runInContext(`({ ${body} isBoxReport: (h) => h.endsWith(".html"), describe: (u) => ({ name: u.split("/").pop() }) })`, ctx);
  const newer = "https://seb.example.com/reports/newer.html";
  const container = { querySelectorAll: () => [
    { dataset: { links: JSON.stringify([REPORT, "https://github.com/x"]) } },
    { dataset: {}, href: newer },
  ] };
  assert.deepEqual([...panel.listIn(container).map((r) => r.url)], [REPORT, newer]);
  assert.match(readFileSync(fileURLToPath(new URL("../public/chat.js", import.meta.url)), "utf8"), /marker\.dataset\.links = JSON\.stringify\(msg\.links\)/);
});

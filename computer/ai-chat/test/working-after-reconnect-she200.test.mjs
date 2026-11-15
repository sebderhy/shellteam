// SHE-200 (Seb, 2026-11-14, on his phone): "The tab shows that it's still
// working even though it seems to be finished."
//
// Cause: sending marks the tab in flight on the page (pendingSend, SHE-90)
// until the turn's turn_done arrives. The phone's connection dropped while the
// reply was being written; the reply's turn_done went to the dead connection.
// After the reconnect the history showed the whole answer, the server's
// snapshot said the tab was idle, but the page kept the in-flight flag because
// only "the server says it is running" retired it. "Working..." never ended.
//
// The rule now: a send made on an earlier connection is settled by the
// server's snapshot, whatever it says. A send on the current connection still
// survives an "idle" snapshot that raced it (SHE-90).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const appSrc = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

function pick(name) {
  const start = appSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in app.js`);
  return appSrc.slice(start, appSrc.indexOf("\n}\n", start) + 2);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(pick("settlePendingSend"), ctx);
const settle = (local, server, connection) => vm.runInContext("settlePendingSend", ctx)(local, server, connection);

test("a send from before the reconnect ends when the server says the tab is idle", () => {
  const tab = { pendingSend: true, pendingSendOn: 1 };
  settle(tab, { isGenerating: false }, 2);
  assert.equal(tab.pendingSend, false, "the reply finished while offline: no endless Working");
});

test("a send on this connection survives an idle snapshot that raced it (SHE-90)", () => {
  const tab = { pendingSend: true, pendingSendOn: 2 };
  settle(tab, { isGenerating: false }, 2);
  assert.equal(tab.pendingSend, true, "the Stop button stays until the agent answers");
});

test("the server reporting the turn running retires the guard, as before", () => {
  const tab = { pendingSend: true, pendingSendOn: 2 };
  settle(tab, { isGenerating: true }, 2);
  assert.equal(tab.pendingSend, false);
});

test("the send records its connection and the status snapshot settles every tab through the rule", () => {
  assert.match(appSrc, /activeSlot\.pendingSend = true; activeSlot\.pendingSendOn = _connectCount;/);
  assert.match(appSrc, /settlePendingSend\(local, serverSlot, _connectCount\)/);
});

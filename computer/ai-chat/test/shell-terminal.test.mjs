import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { shellAvailable, attachShellSocket } from "../lib/shell-terminal.mjs";

// A fake WebSocket: captures sends, lets the test inject client frames.
class FakeWS extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closed = false; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; this.readyState = 3; }
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error("timed out waiting"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("each socket gets its own live shell; close kills it", { skip: !shellAvailable() }, async () => {
  const ws = new FakeWS();
  const proc = attachShellSocket(ws);
  assert.ok(proc, "a pty was spawned");

  // Echo through the real pty round-trip.
  ws.emit("message", JSON.stringify({ type: "terminal_data", data: "echo shellteam-$((20+3))\r" }));
  await waitFor(() => ws.sent.some((m) => m.type === "terminal_data" && m.data.includes("shellteam-23")));

  // Two sockets → two independent ptys.
  const ws2 = new FakeWS();
  const proc2 = attachShellSocket(ws2);
  assert.ok(proc2 && proc2.pid !== proc.pid, "second connection gets its own pty");

  // Resize is honoured, malformed frames are dropped silently.
  ws.emit("message", JSON.stringify({ type: "terminal_resize", cols: 120, rows: 40 }));
  ws.emit("message", "not-json");

  // Closing the socket kills the shell (no orphan ptys).
  ws.emit("close");
  ws2.emit("close");
  await waitFor(() => {
    try { process.kill(proc.pid, 0); return false; } catch { return true; }
  });
});

test("without node-pty the socket gets a loud error, not a hang", { skip: shellAvailable() }, () => {
  const ws = new FakeWS();
  const proc = attachShellSocket(ws);
  assert.equal(proc, null);
  assert.equal(ws.sent[0].type, "terminal_error");
  assert.ok(ws.closed);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { startCodexDeviceAuth, getPendingCodexAuth } from "../lib/session.mjs";

// Regression: an employee container that ships no `codex` CLI froze the cockpit
// on "Connecting…". `spawn("codex", …)` emits 'error' (ENOENT), not 'close';
// with no 'error' handler Node throws AND the caller polls getPendingCodexAuth()
// forever. The handler must instead surface a clean auth failure and clear the
// pending state — never hang, never crash the server.
test("Codex device auth fails loudly when the codex binary is missing", async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent-shellteam-test";  // guarantees codex ENOENT
  try {
    const err = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onError never fired — the UI would hang")), 5000);
      startCodexDeviceAuth(
        () => { clearTimeout(timer); reject(new Error("unexpected success without a codex binary")); },
        (message) => { clearTimeout(timer); resolve(message); },
      );
    });
    assert.match(err, /Codex/i);
    assert.equal(getPendingCodexAuth(), null, "pending auth must be cleared after the failure");
  } finally {
    process.env.PATH = savedPath;
  }
});

// Feature-keys liveness pins (Settings → Feature keys, 2026-07-12):
//   1. The status payload's key-gated flags (hasOpenCode, sttAvailable) come
//      from the control plane's live /internal/ai/status, not this process's
//      spawn-time env — a key saved in the dashboard flips them w/o restart.
//   2. The control-plane fetch failing falls back LOUDLY (console.warn) to
//      process env / the last good answer — status building never crashes.
//   3. The OpenCode setup copy points at Settings → Feature keys; no surface
//      tells the user to edit .env and restart anymore.
//
// Run: node --test 'computer/ai-chat/test/*.test.mjs'
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  aiAvailability,
  refreshAiAvailability,
  _resetAiAvailabilityCache,
} from "../lib/ai-availability.mjs";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const okFetch = (flags) => async () => ({ ok: true, json: async () => flags });
const failFetch = async () => { throw new Error("ECONNREFUSED"); };

function captureWarn(fn) {
  const calls = [];
  const orig = console.warn;
  console.warn = (...args) => calls.push(args.join(" "));
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, calls }))
    .finally(() => { console.warn = orig; });
}

beforeEach(() => {
  _resetAiAvailabilityCache();
  delete process.env.FIREWORKS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  process.env.SHELLTEAM_AI_TOKEN = "test-secret";
});

test("before any fetch, availability falls back to process env", () => {
  assert.deepEqual(aiAvailability(), { opencode: false, stt: false });
  process.env.FIREWORKS_API_KEY = "fk";
  assert.deepEqual(aiAvailability(), { opencode: true, stt: false });
});

test("a successful refresh overrides stale process env with the live answer", async () => {
  process.env.FIREWORKS_API_KEY = "stale-spawn-time-key"; // env says yes…
  const fresh = await refreshAiAvailability({ fetchImpl: okFetch({ opencode: false, stt: true }) });
  assert.deepEqual(fresh, { opencode: false, stt: true }); // …control plane wins
  assert.deepEqual(aiAvailability(), { opencode: false, stt: true });
});

test("a failed refresh warns loudly and falls back to process env", async () => {
  process.env.ELEVENLABS_API_KEY = "el";
  const { result, calls } = await captureWarn(() =>
    refreshAiAvailability({ fetchImpl: failFetch }));
  assert.equal(result, null, "failure must be signalled, never a fake answer");
  assert.equal(calls.length, 1, "the fallback must be logged");
  assert.match(calls[0], /\[ai-availability\].*failed.*process env/);
  assert.deepEqual(aiAvailability(), { opencode: false, stt: true });
});

test("a failed refresh keeps the last good control-plane answer", async () => {
  await refreshAiAvailability({ fetchImpl: okFetch({ opencode: true, stt: true }) });
  const { calls } = await captureWarn(() => refreshAiAvailability({ fetchImpl: failFetch }));
  assert.match(calls[0], /last good answer/);
  assert.deepEqual(aiAvailability(), { opencode: true, stt: true });
});

test("a non-200 from the control plane is a failure, not a blank answer", async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const { result, calls } = await captureWarn(() =>
    refreshAiAvailability({ fetchImpl: http500 }));
  assert.equal(result, null);
  assert.match(calls[0], /HTTP 500/);
});

test("status payload wires hasOpenCode + sttAvailable through aiAvailability()", () => {
  const src = read("../server.mjs");
  assert.match(src, /const ai = aiAvailability\(\)/,
    "authFlags must read the live control-plane availability");
  assert.match(src, /hasOpenCode: ai\.opencode/,
    "hasOpenCode must come from the live answer, not process.env");
  assert.match(src, /sttAvailable: ai\.stt/,
    "the status payload must carry sttAvailable for the mic button");
  assert.doesNotMatch(src, /hasOpenCode: !!process\.env\.FIREWORKS_API_KEY/,
    "the stale process-env read must be gone");
  assert.match(src, /startAiAvailabilityPolling\(\{ onChange: \(\) => broadcast\(buildStatus\(\)\) \}\)/,
    "a capability change must push a fresh status to connected clients");
});

test("the client hides the mic when the server says sttAvailable === false", () => {
  const appSrc = read("../public/app.js");
  assert.match(appSrc, /msg\.sttAvailable !== undefined/,
    "an older server that never sends the field must keep today's behavior");
  assert.match(appSrc, /Voice input needs an ElevenLabs key — add it in Settings/,
    "the hidden mic must explain itself via the title/hint copy");
});

test("no OpenCode setup surface tells the user to edit .env anymore", () => {
  for (const rel of ["../public/app.js", "../public/index.html", "../../../frontend/dashboard.html"]) {
    const src = read(rel);
    for (const m of src.matchAll(/[^\n]*OpenCode[^\n]*/g)) {
      assert.doesNotMatch(m[0], /\.env/,
        `${rel}: OpenCode copy must point at Settings → Feature keys, not .env: ${m[0].trim().slice(0, 120)}`);
    }
    assert.match(src, /Feature keys/,
      `${rel} must point users at Settings → Feature keys`);
  }
});

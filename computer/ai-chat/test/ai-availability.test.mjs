// Feature-keys liveness pins (Settings → Secrets; Feature keys until 2026-11-15):
//   1. The status payload's key-gated flags (hasPi, sttAvailable) come
//      from the control plane's live /internal/ai/status, not this process's
//      spawn-time env — a key saved in the dashboard flips them w/o restart.
//   2. The control-plane fetch failing falls back LOUDLY (console.warn) to
//      process env / the last good answer — status building never crashes.
//   3. The Pi setup copy points at Settings → Secrets; no surface
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
  assert.deepEqual(aiAvailability(), { pi: false, stt: false, tts: false });
  process.env.FIREWORKS_API_KEY = "fk";
  assert.deepEqual(aiAvailability(), { pi: true, stt: false, tts: false });
});

test("a managed box with only a relay token still gets the mic (env fallback)", () => {
  _resetAiAvailabilityCache();
  process.env.SHELLTEAM_RELAY_URL = "https://relay.example.com/relay";
  process.env.SHELLTEAM_RELAY_TOKEN = "strelay_abc";
  try {
    assert.equal(aiAvailability().stt, true);
    assert.equal(aiAvailability().tts, false, "the relay has no /tts");
  } finally {
    delete process.env.SHELLTEAM_RELAY_URL;
    delete process.env.SHELLTEAM_RELAY_TOKEN;
  }
});

test("a guest cockpit with only a voice-input token is offered no voice output", () => {
  // Employee cockpits hold SHELLTEAM_STT_TOKEN, never the master token, and the
  // control plane accepts it on /stt alone. Showing them a speak button would
  // promise a capability that 401s on first use.
  delete process.env.SHELLTEAM_AI_TOKEN;
  process.env.ELEVENLABS_API_KEY = "el";
  assert.deepEqual(aiAvailability(), { pi: false, stt: true, tts: false });
});

test("a successful refresh overrides stale process env with the live answer", async () => {
  process.env.FIREWORKS_API_KEY = "stale-spawn-time-key"; // env says yes…
  const fresh = await refreshAiAvailability({ fetchImpl: okFetch({ pi: false, stt: true, tts: true }) });
  assert.deepEqual(fresh, { pi: false, stt: true, tts: true }); // …control plane wins
  assert.deepEqual(aiAvailability(), { pi: false, stt: true, tts: true });
});

test("a failed refresh warns loudly and falls back to process env", async () => {
  process.env.ELEVENLABS_API_KEY = "el";
  const { result, calls } = await captureWarn(() =>
    refreshAiAvailability({ fetchImpl: failFetch }));
  assert.equal(result, null, "failure must be signalled, never a fake answer");
  assert.equal(calls.length, 1, "the fallback must be logged");
  assert.match(calls[0], /\[ai-availability\].*failed.*process env/);
  // The env fallback grants tts too: this box holds the key AND the master token.
  assert.deepEqual(aiAvailability(), { pi: false, stt: true, tts: true });
});

test("a failed refresh keeps the last good control-plane answer", async () => {
  await refreshAiAvailability({ fetchImpl: okFetch({ pi: true, stt: true, tts: true }) });
  const { calls } = await captureWarn(() => refreshAiAvailability({ fetchImpl: failFetch }));
  assert.match(calls[0], /last good answer/);
  assert.deepEqual(aiAvailability(), { pi: true, stt: true, tts: true });
});

test("a non-200 from the control plane is a failure, not a blank answer", async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const { result, calls } = await captureWarn(() =>
    refreshAiAvailability({ fetchImpl: http500 }));
  assert.equal(result, null);
  assert.match(calls[0], /HTTP 500/);
});

test("status payload wires hasPi + sttAvailable through aiAvailability()", () => {
  const src = read("../server.mjs");
  assert.match(src, /const ai = aiAvailability\(\)/,
    "authFlags must read the live control-plane availability");
  assert.match(src, /hasPi: ai\.pi/,
    "hasPi must come from the live answer, not process.env");
  assert.match(src, /sttAvailable: ai\.stt/,
    "the status payload must carry sttAvailable for the mic button");
  assert.doesNotMatch(src, /hasPi: !!process\.env\.FIREWORKS_API_KEY/,
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

test("no Pi setup surface tells the user to edit .env anymore", () => {
  for (const rel of ["../public/app.js", "../public/index.html", "../../../frontend/dashboard.html"]) {
    const src = read(rel);
    for (const m of src.matchAll(/[^\n]*\bPi\b[^\n]*/g)) {
      assert.doesNotMatch(m[0], /\.env/,
        `${rel}: Pi copy must point at Settings → Secrets, not .env: ${m[0].trim().slice(0, 120)}`);
    }
    assert.match(src, /Settings → Secrets/,
      `${rel} must point users at Settings → Secrets`);
  }
});

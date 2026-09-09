/**
 * Quota meter — a provider that reports NO quota data must not be re-probed
 * every cycle.
 *
 * Seen on a fresh minimal install with a business Codex subscription: the
 * plan hides rate limits, so every 5-minute auto-poll re-spawned the Codex
 * probes and animated "Checking…" over the meter, forever, only to land back
 * on "Not reported". The meter should settle on the gray bar and leave the
 * provider alone; a transient failure still self-heals via a slow hourly
 * re-check, and opening the quota panel always forces a fresh check.
 *
 * app.js is a DOM-coupled monolith; as with SHE-89/90/92 we pin the gating at
 * the source level so a refactor that reverts to unconditional polling fails
 * loudly here.
 *
 * Run: node --test computer/ai-chat/test/quota-unavailable-backoff.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(DIR, "../public/app.js"), "utf8");

test("quotaAutoRefreshDue backs off unavailable providers to the hourly retry", () => {
  const fn = APP_JS.match(/function quotaAutoRefreshDue\(\)\s*{[\s\S]*?\n}/);
  assert.ok(fn, "quotaAutoRefreshDue exists");
  assert.ok(
    /status !== 'unavailable'/.test(fn[0]),
    "quotaAutoRefreshDue must special-case status 'unavailable'",
  );
  assert.ok(
    /QUOTA_UNAVAILABLE_RETRY_MS/.test(fn[0]),
    "the unavailable branch must use the slow retry interval, not stop forever",
  );
});

test("the unavailable retry interval is much longer than the live-poll interval", () => {
  const live = APP_JS.match(/QUOTA_REFRESH_INTERVAL_MS = ([\d* ]+);/);
  const backoff = APP_JS.match(/QUOTA_UNAVAILABLE_RETRY_MS = ([\d* ]+);/);
  assert.ok(live && backoff, "both intervals are defined");
  const evalMs = (expr) => expr.split("*").reduce((a, b) => a * Number(b.trim()), 1);
  assert.ok(
    evalMs(backoff[1]) >= 6 * evalMs(live[1]),
    "unavailable backoff must be at least 6x the normal poll interval",
  );
});

test("every auto-refresh path is gated on quotaAutoRefreshDue, not bare staleness", () => {
  // The three automatic triggers: the poll interval, the ensureQuotaPolling
  // kick, and visibilitychange. The panel-open click handler is deliberately
  // exempt — a user gesture always gets a real re-check.
  const autoCalls = APP_JS.match(/quotaAutoRefreshDue\(\)\) refreshSubscriptionQuota\(\)/g) || [];
  assert.equal(autoCalls.length, 3, "interval, polling kick, and visibilitychange all use the gate");
  assert.ok(
    !/quotaIsStale\(\)\) refreshSubscriptionQuota\(\);/.test(APP_JS),
    "no auto path may call refreshSubscriptionQuota on staleness alone",
  );
});

test("opening the quota panel still forces a fresh check", () => {
  assert.ok(
    /open && quotaIsStale\(\)\) refreshSubscriptionQuota\(\{ force: true \}\)/.test(APP_JS),
    "the click-to-open path keeps its force refresh — that is the manual retry",
  );
});

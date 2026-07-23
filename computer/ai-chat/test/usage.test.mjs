import assert from "node:assert/strict";
import { test } from "node:test";
import {
  antigravityNeedsSetup,
  parseAntigravity,
  parseCodexRateLimits,
} from "../lib/usage.mjs";

test("Codex app-server rate limits normalize into determinate quota windows", () => {
  const parsed = parseCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_783_712_924 },
      secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_784_299_724 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "pro",
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_783_712_924 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_784_299_724 },
      },
      codex_spark: {
        limitId: "codex_spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_783_714_379 },
        secondary: { usedPercent: 1, windowDurationMins: 10_080, resetsAt: 1_784_301_179 },
      },
    },
    rateLimitResetCredits: {
      availableCount: 4,
      credits: [{ id: "must-never-reach-the-browser" }],
    },
  });

  assert.equal(parsed.plan_tier, "pro");
  assert.equal(parsed.resets_available, 4);
  assert.equal(parsed.credits_remaining, null, "a zero balance without credits is not a quota balance");
  assert.equal(parsed.windows.length, 4, "the duplicate codex bucket is deduplicated");
  assert.deepEqual(parsed.windows[0], {
    name: "Codex · 5-hour",
    used_percent: 37,
    remaining_percent: 63,
    resets_at: "2026-07-10T19:48:44.000Z",
  });
  assert.ok(!JSON.stringify(parsed).includes("must-never-reach-the-browser"));
});

test("Antigravity credits and percentage windows normalize without raw terminal output", () => {
  const parsed = parseAntigravity([
    "Plan: Ultra",
    "AI Credits remaining: 1,250",
    "Five-hour quota: 28% used · resets 2026-07-11T13:00:00Z",
    "Weekly quota: 80% remaining",
  ].join("\n"));

  assert.equal(parsed.plan_tier, "Ultra");
  assert.equal(parsed.credits_remaining, 1250);
  assert.deepEqual(parsed.windows, [
    {
      name: "Five-hour quota",
      used_percent: 28,
      remaining_percent: 72,
      resets_at: "2026-07-11T13:00:00Z",
    },
    {
      name: "Weekly quota",
      used_percent: 20,
      remaining_percent: 80,
      resets_at: null,
    },
  ]);
  assert.equal(Object.hasOwn(parsed, "raw"), false);
});

test("Antigravity onboarding is distinguished from an empty quota response", () => {
  assert.equal(antigravityNeedsSetup("Welcome to the Antigravity CLI. You are currently not signed in."), true);
  assert.equal(antigravityNeedsSetup("AI Credits remaining: 32"), false);
});

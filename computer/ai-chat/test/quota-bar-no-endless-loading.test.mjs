// "The subscription panel seems to be loading forever" (Seb, office VDI,
// 2026-09-27). The bar under the Subscription badge scanned left to right
// forever. The scanning animation was reused for FINISHED checks that report
// no percentage (a Codex reset count, a credit balance) and for a check that
// never ran, so a box whose provider never reports a percentage looked stuck
// loading. The bar now scans only while a request is in flight, and the
// request itself is bounded so a proxy holding it open ends in the error state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_JS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js"), "utf8");

function lift(name) {
  const m = APP_JS.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
  assert.ok(m, `${name} missing from app.js`);
  return m[0];
}

// Run the real quotaSummary + renderQuotaMeter against a fake DOM and a given
// provider/loading state; return whether the bar is scanning.
function barFor({ provider, loading }) {
  const el = () => ({ hidden: false, className: "", style: {}, title: "", setAttribute() {}, removeAttribute() {}, classList: { toggle() {} } });
  const nodes = { subscriptionMonitor: el(), quotaMeter: el(), quotaMeterTrack: el(), quotaMeterFill: el() };
  const env = {
    S: { currentModel: "gpt-6-luna", quotaLoading: loading, quotaError: null },
    document: { getElementById: (id) => nodes[id], querySelector: () => null },
    window: {},
    agentIdForModel: () => "codex",
    billingModeForModel: () => "subscription",
    billingBadgeForModel: () => ({ label: "Subscription", title: "" }),
    quotaProviderForCurrentModel: () => provider,
    quotaWindows: (p) => p.windows || [],
    shortQuotaReset: () => "",
    PROVIDER_LABEL: { codex: "Codex" },
  };
  const fn = new Function(...Object.keys(env), `${lift("quotaSummary")}${lift("renderQuotaMeter")}; renderQuotaMeter();`);
  fn(...Object.values(env));
  return nodes.quotaMeterTrack.className.includes("indeterminate");
}

const resetsOnly = { label: "Codex", status: "live", windows: [], credits_remaining: null, resets_available: 2 };
const creditsOnly = { label: "Codex", status: "live", windows: [], credits_remaining: 40, resets_available: null };
const withWindow = { label: "Codex", status: "live", windows: [{ name: "5h", used_percent: 30 }] };

test("a finished check with only a reset count does not scan forever", () => {
  assert.equal(barFor({ provider: resetsOnly, loading: false }), false);
});

test("a finished check with only a credit balance does not scan forever", () => {
  assert.equal(barFor({ provider: creditsOnly, loading: false }), false);
});

test("no data and no check in flight is a static stub, not a loading bar", () => {
  assert.equal(barFor({ provider: null, loading: false }), false);
});

test("the bar scans while a check is actually in flight", () => {
  assert.equal(barFor({ provider: null, loading: true }), true);
  assert.equal(barFor({ provider: resetsOnly, loading: true }), true);
});

test("a known percentage is shown, not replaced by scanning, during a refresh", () => {
  assert.equal(barFor({ provider: withWindow, loading: true }), false);
});

test("the usage request is bounded so a held-open proxy ends in the error state", () => {
  assert.match(APP_JS, /fetch\('\/api\/usage', \{\s*signal: AbortSignal\.timeout\(QUOTA_FETCH_TIMEOUT_MS\)/);
});

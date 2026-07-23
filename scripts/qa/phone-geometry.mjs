#!/usr/bin/env node
// Release-QA browser geometry gate (audit P1-02/P2-05): first-party pages must
// have ZERO intrinsic horizontal overflow at phone widths, and their primary
// actions must sit inside the viewport. Static source tests cannot catch
// intrinsic layout width — the Knowledge header shipped with a ~434px minimum
// that clipped "Dream now" off-screen at every phone width while all suites
// stayed green. This script is the executable layer of that gate.
//
// Usage (any Chrome with a debugging port — CI's preinstalled one works):
//   google-chrome --headless=new --remote-debugging-port=9222 &
//   BASE_URL=http://127.0.0.1:8000 AUTH_BEARER=$OWNER_TOKEN \
//     node scripts/qa/phone-geometry.mjs
//
// Talks raw CDP over Node's built-in fetch + WebSocket — no dependencies.
// Exit 0 = every page/width passed; non-zero lists each violation.

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const BEARER = process.env.AUTH_BEARER || "";
const WIDTHS = [320, 360, 375, 390];
// Vertical position matters too: short phones are where an autofocused control
// at the bottom of a modal drags the opening scroll past the title (round-6
// audit P1-01) — width-only emulation reported green through exactly that.
const SHORT_PHONES = [[320, 568], [360, 640], [375, 667], [320, 780], [390, 844]];

// Page → the actions that must be inside the viewport there. Hidden actions
// are skipped by default (e.g. #report-link only exists once a dream report
// does); `requiredActions: true` makes hidden a failure too — for pages whose
// primary actions must ALWAYS be usable, unreachable-because-hidden is the
// same defect as unreachable-because-clipped.
// Optional fields: `viewports` ([w,h] pairs; default = WIDTHS × 780), `setup`
// (expression run after load, e.g. to open the first-run wizard the way the
// product opens it), `probe` (expression returning an array of failure strings
// — the page-specific vertical/behavioral assertions).
const PAGES = [
  { path: "/knowledge", actions: ["#dream-now", "#report-link"] },
  { path: "/", actions: [] },
  // The first-run wizard, opened via the REAL product path (wizardMaybeShow →
  // setWizardOpen → showWizardStep) on a wizard-naive box: the accept-checkbox
  // autofocus used to scroll short phones straight past "Welcome to ShellTeam"
  // and half the risk text a stranger is asked to accept.
  {
    path: "/", label: "/ (first-run wizard)", actions: [], viewports: SHORT_PHONES,
    setup: `localStorage.removeItem('shellteam_wizard_done');
            aiStatus = { hasApiKey: false };
            wizardMaybeShow();`,
    probe: `(() => {
      const fails = [];
      const w = document.getElementById('wizard');
      if (!w.classList.contains('show')) return ['wizard did not open'];
      if (w.scrollTop !== 0) fails.push('modal opens pre-scrolled: scrollTop=' + w.scrollTop);
      const r = document.getElementById('wizard-title').getBoundingClientRect();
      if (!(r.top >= 0 && r.bottom <= innerHeight && r.height > 0))
        fails.push('title off-screen on open (top=' + Math.round(r.top) + ')');
      // First-run controls carry the project's 44px phone tap bar (audit
      // P2-01). Only meaningful when the coarse-pointer media query is live.
      if (matchMedia('(pointer: coarse)').matches) {
        for (const sel of ['.wizard-accept', '#wizard-next']) {
          const el = document.querySelector(sel);
          const h = el ? el.getBoundingClientRect().height : 0;
          if (h < 44) fails.push(sel + ' tap height ' + Math.round(h) + 'px < 44px');
        }
      } else {
        fails.push('pointer:coarse not emulated — tap-size checks did not run');
      }
      return fails;
    })()`,
  },
  // The Files editor SPA — its toolbar made New File/Folder/Delete unusable
  // at 320px while every static suite stayed green (round-4 audit: a stale
  // staged copy shipped exactly that). The deliberately-nonexistent path
  // still renders the full toolbar and needs no fixture file on the box.
  { path: "/_editor/phone-geometry-qa-probe.txt", requiredActions: true, actions: [
    'button[aria-label="Save file"]', 'button[aria-label="Upload files"]',
    'a[aria-label="Browse files"]', 'button[aria-label="New file"]',
    'button[aria-label="New folder"]', 'button[aria-label="Delete current file"]',
  ] },
];

const { webSocketDebuggerUrl } = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function cdp(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res, rej) => pending.set(id, (m) => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
}

const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
await cdp("Page.enable", {}, sessionId);
await cdp("Runtime.enable", {}, sessionId);
if (BEARER) {
  await cdp("Network.enable", {}, sessionId);
  await cdp("Network.setExtraHTTPHeaders", { headers: { Authorization: `Bearer ${BEARER}` } }, sessionId);
}

async function evaluate(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  return r.result.value;
}

// Phone emulation includes touch: the 44px tap-target rules live behind
// (pointer: coarse), which follows touch emulation, not viewport size.
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);

let failures = 0;
for (const page of PAGES) {
  const name = page.label || page.path;
  for (const [width, height] of page.viewports || WIDTHS.map((w) => [w, 780])) {
    await cdp("Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: true }, sessionId);
    await cdp("Page.navigate", { url: `${BASE}${page.path}` }, sessionId);
    // Settle: navigation completion signals vary per page; poll readyState.
    for (let i = 0; i < 50; i++) {
      if (await evaluate("document.readyState") === "complete") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
    if (page.setup) {
      await evaluate(page.setup);
      await new Promise((r) => setTimeout(r, 300));  // focus runs in a rAF
    }
    const probeFails = page.probe ? await evaluate(page.probe) : [];

    const geo = await evaluate(`(() => {
      const de = document.documentElement;
      const actions = ${JSON.stringify(page.actions)}.map((sel) => {
        const el = document.querySelector(sel);
        if (!el || el.offsetParent === null) return { sel, hidden: true };
        const r = el.getBoundingClientRect();
        return { sel, right: Math.round(r.right), inView: r.right <= innerWidth && r.left >= 0 && r.width > 0 };
      });
      return { sw: de.scrollWidth, cw: de.clientWidth, actions };
    })()`);

    const overflow = geo.sw > geo.cw;
    const clipped = geo.actions.filter((a) => !a.hidden && !a.inView);
    const missing = page.requiredActions ? geo.actions.filter((a) => a.hidden) : [];
    const ok = !overflow && clipped.length === 0 && missing.length === 0 && probeFails.length === 0;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} @${width}×${height}  scroll=${geo.sw} client=${geo.cw}` +
      (clipped.length ? `  clipped: ${clipped.map((a) => `${a.sel}(right=${a.right})`).join(", ")}` : "") +
      (missing.length ? `  hidden required: ${missing.map((a) => a.sel).join(", ")}` : "") +
      (probeFails.length ? `  ${probeFails.join("; ")}` : ""));
  }
}

await cdp("Target.closeTarget", { targetId });
ws.close();
if (failures) { console.error(`\n${failures} geometry violation(s)`); process.exit(1); }
console.log("\nAll pages fit every phone width.");

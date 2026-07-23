/**
 * SHE-90 / SHE-88 / SHE-89 — the Stop button (and the running-tab dot) vanished
 * mid-request, worst with slow-to-first-token agents (GPT-5.6 / Codex).
 *
 * Root cause: the server only flipped slot.isGenerating true on the agent's
 * FIRST event (init / text_delta / tool_start). Between "user sent" and that
 * first event, the flag stayed false — so any buildStatus() broadcast in the gap
 * (the 30s availability poll, another tab's model/cost event, a reconnect)
 * reconciled the active slot to idle on the client and tore down the live Stop
 * button. Reasoning agents sit in that gap for seconds, which is why Seb saw it
 * "with GPT 5.6."
 *
 * Contract pinned here (server, behavioral): dispatching a message marks the
 * slot generating IMMEDIATELY — before any agent event — and only turn_done
 * clears it. This is the exact flag the client's status reconciliation trusts,
 * so keeping it honest keeps the Stop button alive for the whole turn.
 *
 * The client half (the optimistic pendingSend guard that survives a racing
 * status snapshot) is a source-level contract at the bottom of this file, in the
 * same style as tab-bar-she81-83.
 *
 * Run: node --test computer/ai-chat/test/stop-button-generating-she90.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Redirect HOME before importing anything — constants.mjs resolves paths at import.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-stop-btn-"));

const sm = await import("../lib/session-manager.mjs");
const { HOME } = await import("../lib/constants.mjs");

// A mock agent that records its event handlers so the test can drive the turn
// lifecycle by hand. Its sendMessage() emits NOTHING — that is the whole point:
// it models the slow-first-token window the real bug lived in.
function makeMockAgent(created) {
  const handlers = new Map();
  const agent = {
    constructor: { name: "MockAgent" },
    on(event, cb) { handlers.set(event, cb); },
    start() {},
    stop() {},
    sendMessage() {},
    interrupt() {},
    emit(event, data) { handlers.get(event)?.(data); },
  };
  created.push(agent);
  return agent;
}

let nextSlot = 500;

async function liveSlot(created) {
  const id = nextSlot++;
  sm._testSetAgentFactory(() => makeMockAgent(created));
  sm.createSlot(id, { model: "gpt-5.6-luna", cwd: HOME });
  await sm.startAgent(id);
  return id;
}

test("SHE-90: dispatch marks the slot generating before any agent event", async () => {
  const created = [];
  const id = await liveSlot(created);
  assert.equal(sm.getIsGenerating(id), false, "idle before the user sends");

  await sm.sendMessage(id, "build me a status page");
  // The mock emitted no init / text_delta / tool_start. Pre-fix this stayed
  // false, so a status broadcast would clear the Stop button mid-request.
  assert.equal(
    sm.getIsGenerating(id),
    true,
    "generating the instant the message is dispatched, not only on first token",
  );
});

test("SHE-90: the slot snapshot the client reconciles reports the in-flight flag", async () => {
  const created = [];
  const id = await liveSlot(created);
  await sm.sendMessage(id, "hi");

  const snap = sm.listSlots().find((s) => s.id === id);
  assert.equal(
    snap.isGenerating,
    true,
    "buildStatus() carries isGenerating:true during the first-token gap",
  );
});

test("SHE-90: turn_done is what clears the generating flag", async () => {
  const created = [];
  const id = await liveSlot(created);
  await sm.sendMessage(id, "hi");
  assert.equal(sm.getIsGenerating(id), true);

  created[0].emit("turn_done", { cost: 0 });
  assert.equal(sm.getIsGenerating(id), false, "cleared on turn_done, not before");
});

test("SHE-90: an interrupt (Stop) ends the turn and clears the flag", async () => {
  const created = [];
  const id = await liveSlot(created);
  await sm.sendMessage(id, "hi");
  assert.equal(sm.getIsGenerating(id), true);

  // The real adapters emit turn_done on SIGINT; the mock stands in for that.
  sm.interruptAgent(id);
  created[0].emit("turn_done", { subtype: "interrupted" });
  assert.equal(sm.getIsGenerating(id), false, "Stop actually stops");
});

// --- Client half: the optimistic pendingSend guard (source-level contract) ---
// app.js is a DOM-coupled monolith; like tab-bar-she81-83 we pin the guard at
// the source level so a refactor that drops it fails loudly here.

const DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(DIR, "../public/app.js"), "utf8");

test("SHE-90 (client): the active-tab generating derive honours pendingSend", () => {
  // Both places that decide whether to show the streaming indicator (Stop
  // button) for the active slot must treat a pending send as generating.
  const derives = APP_JS.match(
    /isGenerating\s*\|\|\s*[A-Za-z]*\??\.?pendingSend/g,
  ) || [];
  assert.ok(
    derives.length >= 3,
    `expected the derive + tab-dot + drawer to OR in pendingSend, found ${derives.length}`,
  );
});

test("SHE-90 (client): handleSend sets pendingSend and every resolve path clears it", () => {
  assert.ok(
    /activeSlot\.pendingSend = true/.test(APP_JS),
    "handleSend must mark the slot pending on send",
  );
  // turn_done (active + background) and reset must clear it, or the button
  // would stick after the turn ends.
  const clears = (APP_JS.match(/pendingSend = false/g) || []).length;
  assert.ok(clears >= 3, `expected >=3 pendingSend clears, found ${clears}`);
});

test("SHE-89 (client): the running-tab dot lights from pendingSend too", () => {
  const line = APP_JS.match(/const generating = [^\n]*;/);
  assert.ok(line, "generating-class assignment exists in renderSessionTabs");
  assert.ok(
    /pendingSend/.test(line[0]),
    `the dot must light on a just-sent tab: ${line[0]}`,
  );
});

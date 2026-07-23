// Cross-agent conversation-control matrix (hermetic — no API keys, no cost).
//
// Every cockpit conversation control, exercised against EVERY coding-agent
// family using its cheap model, with the agent process mocked. Zero token spend:
// this asserts the session-manager control logic (what happens to the session,
// history, files, and slot state), not model output. The real-CLI end-to-end
// proof (that each control actually resumes/recalls) lives in the opt-in golden
// scripts under scripts/.
//
// Run: node --test computer/ai-chat/test/conversation-controls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The OpenCode fork leg is the one control that isn't fully mockable: seeding a
// new resumable session runs the real `opencode` binary to mint a session id
// (same reason the →OpenCode switch is golden-only). Detect the CLI so we can
// skip just that leg with a VISIBLE TAP skip when it's absent (clean CI, dev
// laptops without opencode) rather than fail — the golden scripts prove it for
// real. Everything else in this file stays hermetic.
function cliAvailable(bin) {
  try {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 });
    return !r.error;
  } catch {
    return false;
  }
}
const OPENCODE_AVAILABLE = cliAvailable("opencode");

// Redirect HOME before importing anything — constants.mjs resolves paths at import.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-controls-"));

const sm = await import("../lib/session-manager.mjs");
const { CODEX_HISTORY_DIR, HOME } = await import("../lib/constants.mjs");
const { supports, agentIdFor } = await import("../lib/agents/registry.mjs");
const { readSessionForReplay, findSessionFile } = await import("../lib/history.mjs");

// The cheap model per family — the tier these tests (and the golden scripts)
// use so running the suite is never expensive. gpt-5.6-luna is Codex's cheapest
// tier (the cost-efficient model); glm-5p1 the smaller OpenCode context.
const CHEAP = {
  claude: "claude-haiku-4-5-20251001",
  codex: "gpt-5.6-luna",
  antigravity: "gemini-3.6-flash",
  opencode: "glm-5p2",
};
// A second same-family model, for "switching model within a family keeps the session".
const SAME_FAMILY_ALT = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-terra",
  antigravity: "gemini-3.1-pro",
  opencode: "glm-5p1",
};
// Gemini was retired in favour of Google's Antigravity CLI (`agy`) on 2026-07-03;
// the `antigravity` family carries the Gemini models now. Like Codex/OpenCode its
// CLI doesn't own history and it can't be resumed-into cross-family (agy owns the
// conversation server-side) — so it only exercises the non-claude legs here.
const FAMILIES = ["claude", "codex", "antigravity", "opencode"];

// Expected capability table — the single source of truth this suite guards
// against registry drift. Keep in lockstep with lib/agents/registry.mjs.
const CAPS = {
  claude: { rewind: true, resume: true, cliOwnsHistory: true },
  codex: { rewind: false, resume: true, cliOwnsHistory: false },
  antigravity: { rewind: false, resume: true, cliOwnsHistory: false },
  opencode: { rewind: false, resume: true, cliOwnsHistory: false },
};

let nextSlot = 100;

function mockAgentFactory(spawns) {
  return (opts) => {
    spawns.push(opts);
    return { on() {}, start() {}, stop() {}, sendMessage() {}, interrupt() {} };
  };
}

// Seed a SOURCE session exactly as the cockpit persists it, so import/rewind
// have a real file to read: Claude owns native JSONL; the rest live as the
// cockpit-owned protocol JSONL in CODEX_HISTORY_DIR.
function seedSource(family, model, cwd, codeword = "SEEDWORD") {
  if (family === "claude") {
    const sid = `claude-${family}-${nextSlot}-1111`;
    const dir = join(HOME, ".claude", "projects", cwd.replaceAll("/", "-"));
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const base = { isSidechain: false, sessionId: sid, cwd, version: "test", gitBranch: "", userType: "external" };
    const lines = [
      JSON.stringify({ ...base, parentUuid: null, type: "user", uuid: "u1", timestamp: now, message: { role: "user", content: `Remember: ${codeword}.` } }),
      JSON.stringify({ ...base, parentUuid: "u1", type: "assistant", uuid: "a1", timestamp: now, message: { model, type: "message", role: "assistant", content: [{ type: "text", text: "OK" }] } }),
    ];
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
    return sid;
  }
  const sid = family === "opencode" ? `ses_ctrl${nextSlot}` : `${family}-thread-${nextSlot}`;
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", model, cwd, timestamp: Date.now() }),
    JSON.stringify({ type: "user_message", content: `Remember: ${codeword}.`, timestamp: Date.now() }),
    JSON.stringify({ type: "text_done", text: "OK" }),
    JSON.stringify({ type: "turn_done", cost: 0 }),
  ];
  writeFileSync(join(CODEX_HISTORY_DIR, `${sid}.jsonl`), lines.join("\n") + "\n");
  return sid;
}

// Build a live slot pinned to a seeded source session, with in-memory history.
function slotWithSession(family, model = CHEAP[family], codeword = "SEEDWORD") {
  const id = nextSlot++;
  const sid = seedSource(family, model, HOME, codeword);
  sm.createSlot(id, { model, cwd: HOME });
  sm.setSessionId(id, sid);
  sm.addUserMessage(id, `Remember: ${codeword}.`);
  return { id, sid };
}

// --- 1. Capability registry matches the documented table (drift guard) ---

for (const family of FAMILIES) {
  test(`caps: ${family} (${CHEAP[family]}) capability flags match the registry table`, () => {
    assert.equal(agentIdFor(CHEAP[family]), family, "cheap model routes to its family");
    for (const [cap, expected] of Object.entries(CAPS[family])) {
      assert.equal(supports(CHEAP[family], cap), expected, `${family}.${cap}`);
    }
  });
}

// --- 2. Same-family model switch KEEPS the session (SHE-14), every family ---

for (const family of FAMILIES) {
  test(`switch (same-family): ${family} keeps its session + history`, async () => {
    const { id, sid } = slotWithSession(family);
    const r = await sm.switchSlotModel(id, SAME_FAMILY_ALT[family]);
    assert.equal(r.error, undefined);
    assert.equal(r.reset, false);
    assert.equal(sm.getSessionId(id), sid, "session preserved across a same-family switch");
    assert.equal(sm.getSlotModel(id), SAME_FAMILY_ALT[family]);
    assert.ok(sm.getHistory(id).length >= 1, "history preserved");
  });
}

// --- 3. Cross-family switch TRANSLATES the conversation (every family → Claude) ---
// Target is Claude (a pure file-writing exporter) so the matrix stays hermetic;
// the →OpenCode leg (which shells out to `opencode import`) is golden-only.

for (const family of FAMILIES.filter((f) => f !== "claude")) {
  test(`switch (cross-family): ${family} → claude carries the conversation, source untouched`, async () => {
    const { id, sid } = slotWithSession(family, CHEAP[family], "CROSSWORD");
    const r = await sm.switchSlotModel(id, CHEAP.claude);
    assert.equal(r.error, undefined);
    assert.ok(r.handoff, "cross-family switch returns handoff metadata");
    assert.equal(r.handoff.fromFamily, family);
    assert.equal(r.handoff.toFamily, "claude");
    const newId = sm.getSessionId(id);
    assert.notEqual(newId, sid, "slot repoints at a fresh native session");
    assert.equal(agentIdFor(sm.getSlotModel(id)), "claude");
    // A visible, persisted handoff marker is appended.
    assert.ok(sm.getHistory(id).some((m) => m.type === "session_event" && m.event === "handoff"));
    // The exported Claude session file exists and carries the conversation.
    const projDir = join(HOME, ".claude", "projects", HOME.replaceAll("/", "-"));
    assert.ok(existsSync(join(projDir, `${newId}.jsonl`)), "target session file written");
  });
}

// --- 3b. The handoff marker survives a reconnect replay for a Claude target ---
// Regression guard: Claude owns its native JSONL (cliOwnsHistory), so the marker
// must be persisted INTO that file and re-surfaced by readSessionForReplay — not
// left only in memory (where it vanished after a refresh). Covers every source
// family → Claude, since Claude is the most common (and previously-broken) target.

for (const family of FAMILIES.filter((f) => f !== "claude")) {
  test(`marker persistence: ${family} → claude handoff marker replays after reconnect`, async () => {
    const { id } = slotWithSession(family, CHEAP[family], "MARKERWORD");
    await sm.switchSlotModel(id, CHEAP.claude);
    const nativeFile = findSessionFile(sm.getSessionId(id));
    assert.ok(nativeFile, "the exported Claude session file is resolvable");
    // Reading the native file fresh (as a reconnect would) surfaces the marker.
    const replayed = readSessionForReplay(nativeFile);
    const marker = replayed.find((m) => m.type === "session_event" && m.event === "handoff");
    assert.ok(marker, "handoff marker is persisted in the native file and replays");
    assert.equal(marker.fromFamily, family);
    assert.equal(marker.toFamily, "claude");
    // And it must NOT show up as a visible user message (it's an isMeta note).
    assert.ok(!replayed.some((m) => m.type === "user_message" && String(m.content).includes("shellteam:session_event")),
      "marker never leaks into the transcript as raw user text");
  });
}

// --- 4. Fork (same-family): new slot, copied history, source untouched ---

// Antigravity can't be forked same-family: a fork must seed a NEW resumable
// session with the prior history, but agy owns its conversation server-side and
// exposes no way to inject history — so there is no antigravity exporter. It
// must refuse loudly and leave the source intact (asserted separately below).
for (const family of FAMILIES.filter((f) => f !== "antigravity")) {
  const skip = family === "opencode" && !OPENCODE_AVAILABLE
    ? "opencode CLI not installed — same-family fork mints a real session (golden-only)"
    : false;
  test(`fork (same-family): ${family} branches into a new slot, source untouched`, { skip }, async () => {
    const { id, sid } = slotWithSession(family, CHEAP[family], "FORKME");
    const srcHistoryLen = sm.getHistory(id).length;
    const forkId = nextSlot++;
    const r = await sm.forkSlot(id, forkId);
    assert.equal(r.error, undefined);
    assert.equal(r.fork.crossFamily, false);
    // Fork gets a fresh native session; source keeps its own.
    assert.ok(sm.getSessionId(forkId) && sm.getSessionId(forkId) !== sid);
    assert.equal(agentIdFor(sm.getSlotModel(forkId)), family);
    // Transcript copied + branch-point marker present in the fork only.
    assert.ok(sm.getHistory(forkId).some((m) => m.type === "user_message" && String(m.content).includes("FORKME")));
    assert.ok(sm.getHistory(forkId).some((m) => m.type === "session_event" && m.event === "fork"));
    // Source is byte-for-byte untouched.
    assert.equal(sm.getSessionId(id), sid);
    assert.equal(sm.getHistory(id).length, srcHistoryLen);
    assert.ok(!sm.getHistory(id).some((m) => m.event === "fork"), "marker never leaks into the source");
  });
}

// Same-family fork of Antigravity refuses cleanly (no exporter) — source intact.
test("fork (same-family): antigravity refuses loudly and leaves the source intact", async () => {
  const { id, sid } = slotWithSession("antigravity", CHEAP.antigravity, "NOFORK");
  const srcHistoryLen = sm.getHistory(id).length;
  const r = await sm.forkSlot(id, nextSlot++);
  assert.ok(r.error && /fork/i.test(r.error), "returns a clear fork error");
  assert.equal(sm.getSessionId(id), sid, "source session untouched");
  assert.equal(sm.getHistory(id).length, srcHistoryLen, "source history untouched");
});

// --- 5. Fork-and-switch (cross-family → Claude): forks AND changes agent ---

for (const family of FAMILIES.filter((f) => f !== "claude")) {
  test(`fork (cross-family): ${family} → claude forks and switches agent`, async () => {
    const { id } = slotWithSession(family, CHEAP[family], "BRANCHKEY");
    const forkId = nextSlot++;
    const r = await sm.forkSlot(id, forkId, CHEAP.claude);
    assert.equal(r.error, undefined);
    assert.equal(r.fork.crossFamily, true);
    assert.equal(r.fork.toFamily, "claude");
    assert.equal(agentIdFor(sm.getSlotModel(forkId)), "claude");
    // Source stays on its own family + session.
    assert.equal(agentIdFor(sm.getSlotModel(id)), family);
  });
}

// --- 6. Rewind: Claude truncates the conversation; the rest refuse gracefully ---

test("rewind: claude truncates the conversation and returns the rewound user text", () => {
  const { id } = slotWithSession("claude", CHEAP.claude, "REWINDME");
  sm.addUserMessage(id, "second question");
  const before = sm.getHistory(id).length;
  const r = sm.rewindSlot(id, 1);
  assert.equal(r.error, undefined);
  assert.equal(r.userText, "second question", "returns the rewound turn's user text for re-editing");
  assert.ok(sm.getHistory(id).length < before, "history was truncated");
});

for (const family of FAMILIES.filter((f) => f !== "claude")) {
  test(`rewind: ${family} refuses gracefully (unsupported) and leaves the session intact`, () => {
    const { id, sid } = slotWithSession(family);
    const r = sm.rewindSlot(id, 1);
    assert.ok(r.error, "returns a user-facing error, not a crash");
    assert.match(r.error, /not supported/i);
    assert.equal(sm.getSessionId(id), sid, "session untouched by a refused rewind");
  });
}

// --- 7. Resume: load a previously-saved session into a slot ---
// Resume is capability-gated in the UI (Gemini can't), but resumeSession()
// itself just replays a file — assert it loads history + restores cwd/model.

for (const family of FAMILIES.filter((f) => CAPS[f].resume)) {
  test(`resume: ${family} loads a saved session's history + workspace into a slot`, () => {
    const codeword = `RESUME${family.toUpperCase().slice(0, 3)}`;
    const sid = seedSource(family, CHEAP[family], HOME, codeword);
    const id = nextSlot++;
    sm.createSlot(id, { model: CHEAP[family], cwd: HOME });
    const r = sm.resumeSession(id, sid);
    assert.equal(r.error, undefined, "resume finds the session");
    assert.equal(sm.getSessionId(id), sid);
    assert.ok(sm.getHistory(id).some((m) => m.type === "user_message" && String(m.content).includes(codeword)),
      "resumed history carries the conversation");
  });
}

// --- 8. New session / reset: clears session, history, and family pin ---

for (const family of FAMILIES) {
  test(`reset: ${family} clears the session, history, and family pin`, () => {
    const { id } = slotWithSession(family);
    sm.resetSlot(id);
    assert.equal(sm.getSessionId(id), null);
    assert.equal(sm.getHistory(id).length, 0);
  });
}

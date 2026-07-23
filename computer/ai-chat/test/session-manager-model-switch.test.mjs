// Regression tests for SHE-14: switching a slot's model must only reset the
// conversation when the new model belongs to a DIFFERENT agent family.
//
// Bug: setSlotModel invalidated the session on ANY model change (and server.mjs
// additionally called resetSlot), so an Opus→Sonnet switch lost the whole
// conversation even though `claude --resume <id> --model sonnet` works fine.
// A second bug hid underneath: familyOfSession() classified every cockpit-owned
// history file as "codex" (Gemini histories live in the same dir), so the
// startAgent backstop dropped preserved Gemini sessions as "cross-family".
//
// Run: node --test computer/ai-chat/test/
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect HOME before importing anything — constants.mjs resolves paths at import.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-model-switch-"));

const sm = await import("../lib/session-manager.mjs");
const { familyOfSession } = await import("../lib/history.mjs");
const { CODEX_HISTORY_DIR, HOME } = await import("../lib/constants.mjs");

const CLAUDE_A = "claude-opus-4-8";
const CLAUDE_B = "claude-sonnet-5";
const CODEX = "gpt-5.5";

function mockAgentFactory(spawns) {
  return (opts) => {
    spawns.push(opts);
    return { on() {}, start() {}, stop() {}, sendMessage() {}, interrupt() {} };
  };
}

before(() => {
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
});

let nextSlot = 10;
function freshSlot(model, sessionId) {
  const id = nextSlot++;
  sm.createSlot(id, { model, cwd: HOME });
  if (sessionId) sm.setSessionId(id, sessionId);
  sm.addUserMessage(id, "hello");
  return id;
}

test("same-family model switch keeps session and history", () => {
  const id = freshSlot(CLAUDE_A, "11111111-1111-1111-1111-111111111111");
  const { reset } = sm.setSlotModel(id, CLAUDE_B);
  assert.equal(reset, false);
  assert.equal(sm.getSessionId(id), "11111111-1111-1111-1111-111111111111");
  assert.equal(sm.getHistory(id).length, 1, "history preserved");
  assert.equal(sm.getSlotModel(id), CLAUDE_B);
});

test("cross-family model switch resets session and history", () => {
  const id = freshSlot(CLAUDE_A, "22222222-2222-2222-2222-222222222222");
  const { reset } = sm.setSlotModel(id, CODEX);
  assert.equal(reset, true);
  assert.equal(sm.getSessionId(id), null);
  assert.equal(sm.getHistory(id).length, 0);
  assert.equal(sm.getSlotModel(id), CODEX);
});

test("re-selecting the same model is a no-op", () => {
  const id = freshSlot(CLAUDE_A, "33333333-3333-3333-3333-333333333333");
  const { reset } = sm.setSlotModel(id, CLAUDE_A);
  assert.equal(reset, false);
  assert.equal(sm.getSessionId(id), "33333333-3333-3333-3333-333333333333");
});

test("cross-family switch with no session does not report a reset", () => {
  const id = freshSlot(CLAUDE_A, null);
  const { reset } = sm.setSlotModel(id, CODEX);
  assert.equal(reset, false);
});

// --- familyOfSession: cockpit-owned histories are per-model, not all codex ---

function writeCockpitHistory(sessionId, meta) {
  const lines = meta ? [JSON.stringify({ type: "session_meta", ...meta })] : [];
  lines.push(JSON.stringify({ type: "user_message", content: "hi" }));
  writeFileSync(join(CODEX_HISTORY_DIR, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

test("familyOfSession reads the owning family from session_meta", () => {
  writeCockpitHistory("cdx-thread-1", { model: CODEX, cwd: HOME });
  writeCockpitHistory("legacy-thread-1", null); // pre-session_meta file
  assert.equal(familyOfSession("cdx-thread-1"), "codex");
  assert.equal(familyOfSession("legacy-thread-1"), "codex", "legacy files default to codex");
  assert.equal(familyOfSession("ses_abc123"), "opencode");
  assert.equal(familyOfSession("no-such-session"), null);
});

test("familyOfSession classifies Claude project files as claude", () => {
  const projDir = join(HOME, ".claude", "projects", HOME.replaceAll("/", "-"));
  mkdirSync(projDir, { recursive: true });
  const sid = "44444444-4444-4444-4444-444444444444";
  writeFileSync(join(projDir, `${sid}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(familyOfSession(sid), "claude");
});

// --- startAgent backstop: preserved same-family sessions must survive it ---

test("startAgent resumes a same-family session after a model switch", async () => {
  const spawns = [];
  sm._testSetAgentFactory(mockAgentFactory(spawns));
  writeCockpitHistory("cdx-thread-resume", { model: CODEX, cwd: HOME });
  const id = freshSlot(CODEX, "cdx-thread-resume");
  await sm.startAgent(id);
  assert.equal(spawns[0].sessionId, "cdx-thread-resume", "same-family session must not be dropped as cross-family");
  sm._testSetAgentFactory(null);
});

test("startAgent drops a session whose family mismatches the model", async () => {
  const spawns = [];
  sm._testSetAgentFactory(mockAgentFactory(spawns));
  writeCockpitHistory("cdx-thread-2", { model: CODEX, cwd: HOME });
  const id = freshSlot(CLAUDE_A, "cdx-thread-2");
  await sm.startAgent(id);
  assert.equal(spawns[0].sessionId, null, "orphaned cross-family session must be dropped");
  assert.equal(sm.getSessionId(id), null);
  sm._testSetAgentFactory(null);
});

// --- switchSlotModel: the portable-sessions entry point (B1) ---

function writeCockpitCodeword(sessionId, model, cwd, codeword) {
  const lines = [
    JSON.stringify({ type: "session_meta", model, cwd, timestamp: Date.now() }),
    JSON.stringify({ type: "user_message", content: `Remember the codeword: ${codeword}.` }),
    JSON.stringify({ type: "text_done", text: "OK" }),
    JSON.stringify({ type: "turn_done", cost: 0 }),
  ];
  writeFileSync(join(CODEX_HISTORY_DIR, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

test("switchSlotModel: fresh slot (no session) is a plain config change", async () => {
  const id = nextSlot++;
  sm.createSlot(id, { model: CLAUDE_A, cwd: HOME });
  const r = await sm.switchSlotModel(id, CODEX);
  assert.equal(r.reset, false);
  assert.equal(r.handoff, undefined);
  assert.equal(sm.getSlotModel(id), CODEX);
});

test("switchSlotModel: same-family switch keeps the session (SHE-14 semantics)", async () => {
  const id = freshSlot(CLAUDE_A, "55555555-5555-5555-5555-555555555555");
  const r = await sm.switchSlotModel(id, CLAUDE_B);
  assert.equal(r.reset, false);
  assert.equal(sm.getSessionId(id), "55555555-5555-5555-5555-555555555555");
});

test("switchSlotModel: cross-family switch translates the conversation (Codex→Claude)", async () => {
  // Seed a real Codex cockpit source session in the temp HOME.
  const srcId = "cdx-src-1";
  writeCockpitCodeword(srcId, CODEX, HOME, "CROSSWORD");
  const id = nextSlot++;
  sm.createSlot(id, { model: CODEX, cwd: HOME });
  sm.setSessionId(id, srcId);
  sm.addUserMessage(id, "Remember the codeword: CROSSWORD.");

  const r = await sm.switchSlotModel(id, CLAUDE_A);
  assert.equal(r.reset, false);
  assert.ok(r.handoff, "a cross-family switch returns handoff metadata");
  assert.equal(r.handoff.fromFamily, "codex");
  assert.equal(r.handoff.toFamily, "claude");

  // Slot repoints at a NEW native session id (source untouched).
  const newId = sm.getSessionId(id);
  assert.notEqual(newId, srcId);
  assert.equal(sm.getSlotModel(id), CLAUDE_A);

  // The exported Claude session file exists and carries the codeword.
  const projDir = join(HOME, ".claude", "projects", HOME.replaceAll("/", "-"));
  const raw = readFileSync(join(projDir, `${newId}.jsonl`), "utf8");
  assert.ok(raw.includes("CROSSWORD"), "translated session carries the conversation");

  // A visible, persisted handoff marker is appended to history.
  assert.ok(sm.getHistory(id).some((m) => m.type === "session_event" && m.event === "handoff"));
});

test("switchSlotModel: a failed handoff reverts the model and leaves the source intact (no silent fallback)", async () => {
  // Claude owns its own history, so no cockpit JSONL is written; pointing the
  // slot at a Claude session id with no file on disk makes the import throw.
  const missing = "99999999-9999-9999-9999-999999999999";
  const id = nextSlot++;
  sm.createSlot(id, { model: CLAUDE_A, cwd: HOME });
  sm.setSessionId(id, missing);
  sm.addUserMessage(id, "hi");

  const r = await sm.switchSlotModel(id, CODEX);
  assert.ok(r.error, "returns a user-facing error");
  assert.match(r.error, /untouched/i);
  // Invariants 7/8: model unchanged, source session still pinned.
  assert.equal(sm.getSlotModel(id), CLAUDE_A);
  assert.equal(sm.getSessionId(id), missing);
});

// --- forkSlot: branch a conversation into a new slot (B1 fast-follow) ---

test("forkSlot: same-family fork copies history into a new slot, source untouched", async () => {
  const srcId = "cdx-fork-src";
  writeCockpitCodeword(srcId, CODEX, HOME, "FORKWORD");
  const src = nextSlot++;
  sm.createSlot(src, { model: CODEX, cwd: HOME });
  sm.setSessionId(src, srcId);
  sm.addUserMessage(src, "Remember the codeword: FORKWORD.");
  const srcHistoryLen = sm.getHistory(src).length;

  const forkId = nextSlot++;
  const r = await sm.forkSlot(src, forkId);
  assert.equal(r.error, undefined);
  assert.equal(r.newSlotId, forkId);
  assert.equal(r.fork.crossFamily, false);

  // The fork is a NEW native session (source id never reused).
  const forkSession = sm.getSessionId(forkId);
  assert.ok(forkSession && forkSession !== srcId, "fork gets a fresh native session id");
  assert.equal(sm.getSlotModel(forkId), CODEX);

  // The shared transcript is copied, and a fork marker records the branch point.
  const forkHistory = sm.getHistory(forkId);
  assert.ok(forkHistory.some((m) => m.type === "user_message" && String(m.content).includes("FORKWORD")));
  assert.ok(forkHistory.some((m) => m.type === "session_event" && m.event === "fork"));

  // The source slot is byte-for-byte untouched.
  assert.equal(sm.getSessionId(src), srcId);
  assert.equal(sm.getHistory(src).length, srcHistoryLen, "source history not mutated");
  assert.ok(!sm.getHistory(src).some((m) => m.event === "fork"), "no marker leaked into the source");
});

test("forkSlot: fork-and-switch carries the conversation into another family (Codex→Claude)", async () => {
  const srcId = "cdx-fork-src-2";
  writeCockpitCodeword(srcId, CODEX, HOME, "BRANCHKEY");
  const src = nextSlot++;
  sm.createSlot(src, { model: CODEX, cwd: HOME });
  sm.setSessionId(src, srcId);
  sm.addUserMessage(src, "Remember the codeword: BRANCHKEY.");

  const forkId = nextSlot++;
  const r = await sm.forkSlot(src, forkId, CLAUDE_A);
  assert.equal(r.error, undefined);
  assert.equal(r.fork.crossFamily, true);
  assert.equal(r.fork.toFamily, "claude");
  assert.equal(sm.getSlotModel(forkId), CLAUDE_A);

  // The exported Claude session file exists and carries the conversation.
  const newId = sm.getSessionId(forkId);
  const projDir = join(HOME, ".claude", "projects", HOME.replaceAll("/", "-"));
  const raw = readFileSync(join(projDir, `${newId}.jsonl`), "utf8");
  assert.ok(raw.includes("BRANCHKEY"), "forked Claude session carries the conversation");

  // Source stays on Codex with its own session.
  assert.equal(sm.getSlotModel(src), CODEX);
  assert.equal(sm.getSessionId(src), srcId);
});

test("forkSlot: forking a slot with no session errors and creates nothing", async () => {
  const src = nextSlot++;
  sm.createSlot(src, { model: CLAUDE_A, cwd: HOME }); // no session set
  const forkId = nextSlot++;
  const r = await sm.forkSlot(src, forkId);
  assert.ok(r.error, "returns a user-facing error");
  assert.match(r.error, /start the conversation/i);
  assert.ok(!sm.listSlots().some((s) => s.id === forkId), "no fork slot was created");
});

test("forkSlot: forking into an existing slot id is refused", async () => {
  const srcId = "cdx-fork-src-3";
  writeCockpitCodeword(srcId, CODEX, HOME, "DUPE");
  const src = nextSlot++;
  sm.createSlot(src, { model: CODEX, cwd: HOME });
  sm.setSessionId(src, srcId);
  sm.addUserMessage(src, "hi");

  const r = await sm.forkSlot(src, src); // target == an existing slot
  assert.ok(r.error, "returns a user-facing error");
  assert.match(r.error, /already exists/i);
});

// Regression: a reconnect (or a second device) re-issues create_tab for every
// tab with its own possibly-stale config. That must NOT clobber a workspace the
// user deliberately set on an existing slot — even before the first message is
// sent (no sessionId yet). Bug symptom: user picks ~/homefinder, a reconnect
// pushes the old cwd, and the agent spawns in the stale folder.
test("createSlot: reconnect re-push does not clobber an existing slot's cwd (no session yet)", () => {
  const id = nextSlot++;
  const chosen = join(HOME, "homefinder");
  // Initial creation from the client, then the user sets the workspace.
  sm.createSlot(id, { model: CLAUDE_A, cwd: HOME });
  sm.setCwd(id, chosen);
  assert.equal(sm.getCwd(id), chosen);

  // A reconnect (this or another device) re-pushes create_tab with a STALE cwd
  // and no sessionId on the slot. The deliberately-set workspace must survive.
  sm.createSlot(id, { model: CLAUDE_A, cwd: join(HOME, "tmp", "st-qa") });
  assert.equal(sm.getCwd(id), chosen, "reconnect create_tab must not overwrite a set cwd");
  assert.equal(sm.getSessionId(id), null, "guard holds even with no session yet");
});

test("createSlot: a brand-new slot still adopts the client's config", () => {
  const id = nextSlot++;
  const cwd = join(HOME, "projects", "app");
  sm.createSlot(id, { model: CODEX, cwd });
  assert.equal(sm.getCwd(id), cwd, "new slot takes the client-provided cwd");
  assert.equal(sm.getSlotModel(id), CODEX);
});

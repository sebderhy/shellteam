// Workspace lock — pin every session of an ai-chat process inside one directory.
//
// A guest's cockpit runs as a separate ai-chat process with
// SHELLTEAM_WORKSPACE_LOCK=<dir> (+ SHELLTEAM_GUEST_NAME): every session must
// be pinned inside the locked directory, un-leaveably. All cwd write paths in
// session-manager funnel through ONE helper, clampToWorkspaceLock(); these
// tests pin its semantics — including path-SEGMENT safety (/x/acme-project-evil
// must NOT pass a /x/acme-project lock) — and the purity guarantee that with no
// lock the dir passes through untouched (zero behavior change on normal
// boxes; the other 100+ tests in this suite run lock-free in their own
// processes and double as the purity pin).
//
// WORKSPACE_LOCK is read once by lib/constants.mjs at import, so the env must
// be set BEFORE the first (dynamic) import — same pattern as
// purity-contract.test.mjs.
//
// Run: node --test computer/ai-chat/test/workspace-lock.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "st-workspace-lock-"));
const LOCK = join(FAKE_HOME, "acme-project");
const INSIDE = join(LOCK, "api");
const SIBLING_ATTACK = LOCK + "-evil"; // shares the lock's string prefix, is NOT inside it
mkdirSync(INSIDE, { recursive: true });
mkdirSync(SIBLING_ATTACK, { recursive: true });

process.env.HOME = FAKE_HOME;
process.env.SHELLTEAM_WORKSPACE_LOCK = LOCK;
process.env.SHELLTEAM_GUEST_NAME = "alex";

const { WORKSPACE_LOCK, GUEST_NAME, HOME } = await import("../lib/constants.mjs");
const sm = await import("../lib/session-manager.mjs");
const { clampToWorkspaceLock } = sm;

process.on("exit", () => rmSync(FAKE_HOME, { recursive: true, force: true }));

test("constants: lock + guest name are read (resolved) from the env", () => {
  assert.equal(WORKSPACE_LOCK, LOCK);
  assert.equal(GUEST_NAME, "alex");
  assert.equal(HOME, FAKE_HOME);
});

test("clamp: the lock itself and dirs inside it pass unchanged", () => {
  assert.equal(clampToWorkspaceLock(LOCK), LOCK);
  assert.equal(clampToWorkspaceLock(INSIDE), INSIDE);
  assert.equal(clampToWorkspaceLock(join(INSIDE, "deep/nested")), join(INSIDE, "deep/nested"));
});

test("clamp: a dir outside the lock is pinned to the lock", () => {
  assert.equal(clampToWorkspaceLock(FAKE_HOME), LOCK);
  assert.equal(clampToWorkspaceLock("/etc"), LOCK);
  assert.equal(clampToWorkspaceLock(join(FAKE_HOME, "other-project")), LOCK);
});

test("clamp: sibling-prefix attack — /x/acme-project-evil does NOT pass a /x/acme-project lock", () => {
  assert.equal(clampToWorkspaceLock(SIBLING_ATTACK), LOCK);
  assert.equal(clampToWorkspaceLock(join(SIBLING_ATTACK, "sub")), LOCK);
});

test("clamp: relative and traversal input is resolved before the check", () => {
  // Resolved against process.cwd() (the repo, outside the lock) → pinned.
  assert.equal(clampToWorkspaceLock("acme-project"), LOCK);
  assert.equal(clampToWorkspaceLock("../../../etc"), LOCK);
  // Traversal that lands back inside the lock is fine — and normalized.
  assert.equal(clampToWorkspaceLock(join(LOCK, "api", "..", "api")), INSIDE);
  // Traversal escaping through the lock is pinned.
  assert.equal(clampToWorkspaceLock(join(LOCK, "..", "acme-project-evil")), LOCK);
});

test("clamp: falsy dir under a lock yields the lock (never null/undefined cwd)", () => {
  assert.equal(clampToWorkspaceLock(null), LOCK);
  assert.equal(clampToWorkspaceLock(undefined), LOCK);
});

test("purity: with no lock the dir passes through UNTOUCHED (zero behavior change)", () => {
  // Explicit null lock = the unlocked code path every normal box takes.
  assert.equal(clampToWorkspaceLock("/anywhere/at/all", null), "/anywhere/at/all");
  assert.equal(clampToWorkspaceLock(FAKE_HOME, null), FAKE_HOME);
  assert.equal(clampToWorkspaceLock(SIBLING_ATTACK, null), SIBLING_ATTACK);
  // Not even resolved/normalized — byte-identical passthrough.
  assert.equal(clampToWorkspaceLock("relative/dir", null), "relative/dir");
  assert.equal(clampToWorkspaceLock(null, null), null);
});

test("defaultConfig honors the lock: slot 0 is born inside the locked workspace, not HOME", () => {
  // Slot 0 is created at module import via ensureSlot(0) → defaultConfig().
  assert.equal(sm.getCwd(0), LOCK);
});

test("setCwd is clamped: an outside dir lands on the lock, an inside dir sticks", () => {
  sm.createSlot(11);
  sm.setCwd(11, FAKE_HOME);
  assert.equal(sm.getCwd(11), LOCK);
  sm.setCwd(11, INSIDE);
  assert.equal(sm.getCwd(11), INSIDE);
  sm.setCwd(11, SIBLING_ATTACK);
  assert.equal(sm.getCwd(11), LOCK);
});

test("createSlot's cwd override is clamped (the create_tab path)", () => {
  sm.createSlot(12, { cwd: join(FAKE_HOME, "other-project") });
  assert.equal(sm.getCwd(12), LOCK);
  sm.createSlot(13, { cwd: INSIDE });
  assert.equal(sm.getCwd(13), INSIDE);
});

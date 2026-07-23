// Round-4 release-audit P1: concurrent forks must not collapse into one slot.
//
// forkSlot's creation spans an await (the portable-session export): the id was
// checked against slot EXISTENCE synchronously but only materialized after the
// export. A second fork arriving mid-export saw the id as free, was granted
// the same allocation, and both forks reported success while only one server
// slot existed — the second silently replaced the first's session pointer,
// orphaning it. Audit repro: allocated [1,1], slots [0,10,1], two distinct
// native sessions, one visible tab.
//
// The fix: allocateSlotId + forkSlot share a reservation set. The id is
// reserved synchronously before the first await and released in a finally, so
// allocation is atomic across the async boundary and a failed export leaves
// no ghost.
//
// Run: node --test computer/ai-chat/test/
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect HOME before importing anything — constants.mjs resolves paths at import.
process.env.HOME = mkdtempSync(join(tmpdir(), "st-fork-race-"));

const sm = await import("../lib/session-manager.mjs");
const { CODEX_HISTORY_DIR, HOME } = await import("../lib/constants.mjs");

const CODEX = "gpt-5.5";
const CLAUDE = "claude-opus-4-8";

before(() => {
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
});

let nextSlot = 100;

/** A forkable Codex slot backed by a real cockpit-owned history file. */
function codexSource(codeword) {
  const sessionId = `cdx-race-${nextSlot}`;
  writeFileSync(join(CODEX_HISTORY_DIR, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "session_meta", model: CODEX, cwd: HOME, timestamp: Date.now() }),
    JSON.stringify({ type: "user_message", content: `Remember the codeword: ${codeword}.` }),
    JSON.stringify({ type: "text_done", text: "OK" }),
    JSON.stringify({ type: "turn_done", cost: 0 }),
  ].join("\n") + "\n");
  const id = nextSlot++;
  sm.createSlot(id, { model: CODEX, cwd: HOME });
  sm.setSessionId(id, sessionId);
  sm.addUserMessage(id, `Remember the codeword: ${codeword}.`);
  return id;
}

test("two concurrent forks racing the SAME id: exactly one wins, the other is refused", async () => {
  const src = codexSource("SAMEID");
  const forkId = nextSlot++;

  // Neither awaited before the other starts — the audit's exact interleaving.
  const p1 = sm.forkSlot(src, forkId);
  const p2 = sm.forkSlot(src, forkId);
  const [r1, r2] = await Promise.all([p1, p2]);

  const winners = [r1, r2].filter((r) => !r.error);
  const losers = [r1, r2].filter((r) => r.error);
  assert.equal(winners.length, 1, "exactly one fork may claim the id");
  assert.equal(losers.length, 1, "the raced duplicate must be refused, not silently merged");
  assert.match(losers[0].error, /already exists/);
  assert.equal(sm.getSessionId(forkId), winners[0].sessionId, "the slot holds the winner's session");
});

test("allocateSlotId treats an in-flight fork's id as taken", async () => {
  const src = codexSource("ALLOC");
  const forkId = nextSlot++;

  const p1 = sm.forkSlot(src, forkId); // reserves forkId synchronously
  const granted = sm.allocateSlotId(forkId);
  assert.notEqual(granted, forkId, "a reserved id must not be granted to a concurrent create");

  const r1 = await p1;
  assert.equal(r1.error, undefined);
  assert.notEqual(sm.allocateSlotId(forkId), forkId,
    "after materialization the id stays unavailable via existence");
});

test("the server path end-to-end: same hint, two forks, two visible slots, two native sessions", async () => {
  const src = codexSource("TWOFORKS");
  const hint = nextSlot++; // both devices compute the same next id

  // Exactly what the fork_slot handler does, twice, without awaiting between.
  const id1 = sm.allocateSlotId(hint);
  const p1 = sm.forkSlot(src, id1);
  const id2 = sm.allocateSlotId(hint);
  const p2 = sm.forkSlot(src, id2);
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.notEqual(id1, id2, "the second fork must get a distinct canonical id");
  assert.equal(r1.error, undefined);
  assert.equal(r2.error, undefined);
  assert.ok(sm.hasSlot(id1) && sm.hasSlot(id2), "both forks are visible slots");
  assert.notEqual(sm.getSessionId(id1), sm.getSessionId(id2), "each fork owns its own native session");
  assert.notEqual(sm.getSessionId(id1), sm.getSessionId(src));
  assert.notEqual(sm.getSessionId(id2), sm.getSessionId(src));
});

test("a failed fork releases its reservation and leaves no ghost slot", async () => {
  // Claude owns its own history; a Claude session id with no file on disk
  // makes the export throw — the deterministic failure path.
  // Ids jump past anything allocateSlotId may have materialized above:
  // createSlot on an EXISTING id keeps its config, so a collision here would
  // silently reuse a codex fork instead of creating the claude source.
  nextSlot = 500;
  const src = nextSlot++;
  sm.createSlot(src, { model: CLAUDE, cwd: HOME });
  sm.setSessionId(src, "99999999-9999-9999-9999-999999999999");
  sm.addUserMessage(src, "hi");
  const forkId = nextSlot++;

  const r = await sm.forkSlot(src, forkId);
  assert.ok(r.error, "the failed export surfaces a user-facing error");
  assert.equal(sm.hasSlot(forkId), false, "no ghost slot");
  assert.equal(sm.allocateSlotId(forkId), forkId, "the reservation is released — the id is allocatable again");

  // And the id is genuinely reusable: a good source can fork into it.
  const good = codexSource("REUSE");
  const r2 = await sm.forkSlot(good, forkId);
  assert.equal(r2.error, undefined);
  assert.equal(r2.newSlotId, forkId);
});

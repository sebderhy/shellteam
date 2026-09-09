#!/usr/bin/env node
// Release-QA behavioral gate for the fork-id race (round-4 audit P1): two
// devices forking the SAME source slot with the SAME hinted id at the same
// moment must land on DISTINCT slots, with distinct native sessions, and both
// must be visible in the server's authoritative snapshot.
//
// Why this exists next to test/fork-id-race.test.mjs: that suite calls
// session-manager functions directly and emulates the server handler. It cannot
// catch a regression in the WebSocket wiring itself (a handler that stops
// calling allocateSlotId, a broadcast that drops the canonical id, a snapshot
// that omits a slot) — the exact layer where the bug was observed. This script
// drives the real server.mjs over real sockets.
//
// Self-contained: it spawns its own cockpit on a throwaway HOME and a free
// port, seeds one codex source session as a fixture, and cleans up. No live
// box, no CLI binaries, no network. Safe to run in CI.
//
//   node scripts/qa/fork-race-ws.mjs
//
// Exit 0 = every check passed; non-zero lists the failures.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AI_CHAT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "computer", "ai-chat");
const SESSION_ID = "forkrace-fixture-0000-0000-000000000000";
const BOOT_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 60_000;

const hardStop = setTimeout(() => {
  console.error(`TIMEOUT: the scenario did not complete in ${SCENARIO_TIMEOUT_MS / 1000}s`);
  finish(3);
}, SCENARIO_TIMEOUT_MS);

// --- Throwaway box -------------------------------------------------------

/** A free loopback port, so parallel CI jobs never collide on a fixed one. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * A HOME containing exactly one restored slot whose codex session is
 * exportable — the minimum state a fork needs. The cockpit owns codex history
 * as protocol JSONL, so the fixture is that file plus the persisted tab.
 */
function seedHome() {
  const home = mkdtempSync(join(tmpdir(), "forkrace-home-"));
  mkdirSync(join(home, ".config", "shellteam", "codex-history"), { recursive: true });
  writeFileSync(
    join(home, ".config", "shellteam", "codex-history", `${SESSION_ID}.jsonl`),
    [
      { type: "session_meta", model: "gpt-5.6-sol-max", cwd: home, timestamp: 1_700_000_000_000 },
      { type: "user_message", content: "fork-race fixture: the source conversation" },
      { type: "text_done", content: "Acknowledged." },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n",
  );
  writeFileSync(
    join(home, ".claude-chat-tabs.json"),
    JSON.stringify([{
      id: 0, sessionId: SESSION_ID, sessionFamily: "codex", title: "source",
      createdAt: 1_700_000_000_000, lastUsedAt: 1_700_000_000_000,
      model: "gpt-5.6-sol-max", cwd: home,
    }]),
  );
  return home;
}

const HOME = seedHome();
const PORT = await freePort();
const serverLog = [];

let finishing = false;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: AI_CHAT,
  // A pristine env: the gate must never read or write the real owner's state.
  env: { PATH: process.env.PATH, HOME, PORT: String(PORT), AI_CHAT_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => serverLog.push(d.toString()));
server.stderr.on("data", (d) => serverLog.push(d.toString()));
let serverExited = false;
server.on("exit", (code) => {
  serverExited = true;
  if (!finishing && code !== null && code !== 0) {
    console.error(`server.mjs exited early with code ${code}:\n${serverLog.join("")}`);
    finish(3);
  }
});

/**
 * Stop the cockpit and delete its throwaway HOME. The wait is not politeness:
 * the cockpit flushes tab state on SIGTERM, so removing HOME while it is still
 * alive loses the race and leaves an ENOTEMPTY stack trace over a passing run.
 */
async function finish(code) {
  finishing = true;
  clearTimeout(hardStop);
  server.kill("SIGTERM");
  for (let i = 0; i < 100 && !serverExited; i++) await new Promise((r) => setTimeout(r, 50));
  if (!serverExited) server.kill("SIGKILL");
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  process.exit(code);
}
// Safety net for paths that bypass finish() (an uncaught throw, a SIGINT):
// never leave an orphaned cockpit behind, even if HOME survives.
process.on("exit", () => server.kill("SIGKILL"));

// --- WebSocket client ----------------------------------------------------

/** Connect, buffering messages so a `waitFor` can match ones already received. */
function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws._msgs = [];
    ws._waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      const w = ws._waiters.find((x) => x.pred(msg));
      if (w) { ws._waiters.splice(ws._waiters.indexOf(w), 1); w.res(msg); }
      else ws._msgs.push(msg);
    };
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });
}

function waitFor(ws, pred) {
  const i = ws._msgs.findIndex(pred);
  if (i !== -1) return Promise.resolve(ws._msgs.splice(i, 1)[0]);
  return new Promise((res) => ws._waiters.push({ pred, res }));
}

const isStatus = (m) => m.type === "status" && Array.isArray(m.slots);

/** The server's authoritative view, as a freshly-connected client sees it. */
async function snapshotSlotIds() {
  const probe = await connect();
  const st = await waitFor(probe, isStatus);
  probe.close();
  return st.slots.map((s) => s.id).sort((a, b) => a - b);
}

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const ws = await connect();
      await waitFor(ws, isStatus);
      ws.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.error(`server.mjs did not accept a WebSocket within ${BOOT_TIMEOUT_MS / 1000}s:\n${serverLog.join("")}`);
  await finish(3);
}

// --- The scenario --------------------------------------------------------

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

await waitForBoot();

const A = await connect();
const B = await connect();
const stA = await waitFor(A, isStatus);
await waitFor(B, isStatus);
check(String(stA.slots.map((s) => s.id)) === "0",
  `setup: the box starts with only the seeded source slot (got [${stA.slots.map((s) => s.id)}])`);

// Both devices see the same tab list, so both compute the same "next" id (1)
// and fork at the same instant. The hint is a hint — the server allocates.
A.send(JSON.stringify({ type: "fork_slot", slot: 0, newSlot: 1, nonce: "race-A" }));
B.send(JSON.stringify({ type: "fork_slot", slot: 0, newSlot: 1, nonce: "race-B" }));

const forkA = await waitFor(A, (m) => m.type === "slot_forked" && m.nonce === "race-A");
const forkB = await waitFor(B, (m) => m.type === "slot_forked" && m.nonce === "race-B");

check(forkA.slot !== forkB.slot,
  `distinct canonical slot ids: A→${forkA.slot}, B→${forkB.slot}`);
check(Boolean(forkA.sessionId) && Boolean(forkB.sessionId) && forkA.sessionId !== forkB.sessionId,
  `distinct native sessions: ${String(forkA.sessionId).slice(0, 12)}… vs ${String(forkB.sessionId).slice(0, 12)}…`);

const ids = await snapshotSlotIds();
check(ids.length === 3 && ids.includes(0) && ids.includes(forkA.slot) && ids.includes(forkB.slot),
  `a fresh client sees source + both forks: [${ids}]`);

A.close();
B.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nFork race gate passed.");
await finish(failures ? 1 : 0);

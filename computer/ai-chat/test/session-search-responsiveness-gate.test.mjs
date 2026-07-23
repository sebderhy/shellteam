/**
 * Round-7 P1-01 release gate: a full-history session search must NOT freeze the
 * shared cockpit event loop.
 *
 * The regression: search_sessions handled a query by synchronously readFileSync
 * + toLowerCase-ing every transcript inside the WebSocket callback. On a mature
 * history (640 MB) one no-match query blocked the Node event loop for ~5.3 s —
 * during which NO client could get heartbeats, status, or streamed agent output.
 * Green CI missed it because the unit test used tiny fixtures and the wire check
 * was a source-string assertion; neither started the real server.
 *
 * This gate is deliberately heavy and faithful: it spawns the REAL cockpit
 * server on a throwaway HOME seeded with a large corpus, drives a REAL WebSocket,
 * and — while a cold no-match search runs — pings the server on a tight interval
 * and measures the round-trip. If the search blocks the loop, those pings stall
 * and the max round-trip blows past the bar. It also proves latest-query-wins
 * cancellation: a second keystroke supersedes the first, which must not answer.
 *
 * MUST FAIL on the pre-fix code (public 50f95fa): verified by temporarily
 * restoring the synchronous searchSessions — the max round-trip jumped to the
 * seconds range and the assertion tripped. On the off-loop grep implementation
 * the loop stays responsive (round-trips in the tens of ms).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");

// Big enough that the OLD synchronous scan blocks the loop for far longer than
// the bar on any CI hardware (this dev box measured ~3.3 ms/MB → ~1 s here;
// GitHub runners are slower still), yet quick to write and grep. None of the
// filler contains the no-match search tokens.
const CORPUS_FILES = 12;
const FILE_MB = 25; // ~300 MB total
const MAX_ROUNDTRIP_MS = 250; // heartbeat bar: the shared loop must never stall this long
const DRAIN_MS = 400; // after the result, drain ping replies queued behind any block
const NO_MATCH = "qzxwvbup_no_such_token";

let HOME, port, child, logBuf = "";

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function seedCorpus(home) {
  // One representative Claude project dir full of large no-match transcripts.
  const projDir = join(home, ".claude", "projects", home.replaceAll("/", "-") + "-bigproj");
  mkdirSync(projDir, { recursive: true });
  // ~25 MB of valid JSONL lines with none of the search tokens in them.
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4-8", content: "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod" },
  }) + "\n";
  const block = line.repeat(Math.ceil((FILE_MB * 1024 * 1024) / line.length));
  for (let i = 0; i < CORPUS_FILES; i++) {
    writeFileSync(join(projDir, `0000000${i}-0000-0000-0000-00000000000${i}.jsonl`), block);
  }
}

function waitOpen(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(ws));
      ws.once("error", () => {
        ws.terminate();
        if (Date.now() > deadline) reject(new Error(`server never accepted a socket\n${logBuf}`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "she-search-gate-"));
  seedCorpus(HOME);
  port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOME, PORT: String(port), AI_CHAT_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logBuf += d; });
  child.stderr.on("data", (d) => { logBuf += d; });
});

after(() => {
  if (child) child.kill("SIGKILL");
  if (HOME) rmSync(HOME, { recursive: true, force: true });
});

/**
 * Drive one WebSocket: fire the given search queries (spaced by `gapMs`) while
 * pinging `list_workspaces` every `pingMs`, and measure the worst ping
 * round-trip observed. If the server blocks its loop on the scan, the pings the
 * client keeps sending (separate process — never blocked) queue behind the
 * block and their replies land all at once when it ends; a DRAIN window after
 * the target result lets those delayed replies surface so the stall is caught
 * (the search result itself arrives the instant the block ends).
 * Returns { maxRoundtrip, searchMs, results }.
 */
function driveSearch(ws, queries, { pingMs = 15, gapMs = 10, doneWhen } = {}) {
  return new Promise((resolve, reject) => {
    const sends = [];        // FIFO of ping send-times awaiting a workspaces_list
    const results = [];      // sessions_search_result echoes, in arrival order
    let maxRoundtrip = 0;
    let searchStart = 0, searchMs = 0;
    let finished = false;

    const pinger = setInterval(() => {
      sends.push(Date.now());
      ws.send(JSON.stringify({ type: "list_workspaces" }));
    }, pingMs);

    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearInterval(pinger);
      clearTimeout(bailout);
      clearTimeout(drain);
      ws.removeListener("message", onMsg);
      err ? reject(err) : resolve({ maxRoundtrip, searchMs, results });
    };
    let drain;

    function onMsg(data) {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.type === "workspaces_list") {
        const t = sends.shift();
        if (t !== undefined) maxRoundtrip = Math.max(maxRoundtrip, Date.now() - t);
      } else if (m.type === "sessions_search_result") {
        results.push(m);
        if (!searchMs) searchMs = Date.now() - searchStart;
        if ((doneWhen ? doneWhen(results) : true) && !drain) {
          drain = setTimeout(() => finish(), DRAIN_MS); // keep reading delayed pings
        }
      }
    }
    ws.on("message", onMsg);

    // Fire the queries spaced out; the pinger is already running.
    searchStart = Date.now();
    queries.forEach((q, i) => setTimeout(() => {
      ws.send(JSON.stringify({ type: "search_sessions", query: q }));
    }, i * gapMs));

    const bailout = setTimeout(() => finish(new Error(`search never returned; got ${results.length} results\n${logBuf}`)), 30000);
  });
}

test("a cold no-match search over a large history keeps the cockpit loop responsive", async () => {
  const ws = await waitOpen(`ws://127.0.0.1:${port}/ws`);
  try {
    const { maxRoundtrip, searchMs, results } = await driveSearch(ws, [NO_MATCH]);
    assert.equal(results.length, 1, "the search returned exactly one result");
    assert.equal(results[0].sessions.length, 0, "the no-match query matched nothing");
    assert.ok(
      maxRoundtrip < MAX_ROUNDTRIP_MS,
      `event loop stalled: worst ping round-trip ${maxRoundtrip} ms exceeds ${MAX_ROUNDTRIP_MS} ms bar (scan took ${searchMs} ms)`,
    );
  } finally {
    ws.close();
  }
});

test("a superseding keystroke cancels the in-flight scan (latest-query-wins)", async () => {
  const ws = await waitOpen(`ws://127.0.0.1:${port}/ws`);
  try {
    // Fire an immediate no-match query, then supersede it 10 ms later. The first
    // scan must be aborted: the client must never receive a stale answer for it
    // after the newer one, and two overlapping full scans must not stack up and
    // block the loop.
    const { maxRoundtrip, searchMs, results } = await driveSearch(
      ws,
      [NO_MATCH + "_a", NO_MATCH + "_b"],
      { doneWhen: (r) => r.some((x) => x.query === NO_MATCH + "_b") },
    );
    const last = results[results.length - 1];
    assert.equal(last.query, NO_MATCH + "_b", "the latest query owns the final answer");
    const bIdx = results.findIndex((r) => r.query === NO_MATCH + "_b");
    assert.ok(
      !results.slice(bIdx + 1).some((r) => r.query === NO_MATCH + "_a"),
      "a superseded query must not answer after the newer one",
    );
    assert.ok(
      maxRoundtrip < MAX_ROUNDTRIP_MS,
      `overlapping scans stalled the loop: worst round-trip ${maxRoundtrip} ms exceeds ${MAX_ROUNDTRIP_MS} ms (scan took ${searchMs} ms)`,
    );
  } finally {
    ws.close();
  }
});

#!/usr/bin/env node
// Release-QA behavioral gate: the cockpit's /internal/* endpoints must not be
// drivable by a webpage in the owner's browser.
//
// /internal/mirror/kickoff starts a coding agent from a caller-supplied prompt.
// As first written it checked only URL + method, and readBody() JSON-parses the
// body without inspecting Content-Type — so a cross-origin
// `fetch(url, {method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'}})`
// is a CORS-SAFELISTED SIMPLE REQUEST: no preflight, request delivered, response
// opaque but the side effect already landed. On a localhost/laptop install any
// site the owner visited could start `claude -p --dangerously-skip-permissions`
// with an attacker-authored prompt.
//
// A loopback-source check does NOT close this: the attacking browser runs on the
// box, so its connection IS from 127.0.0.1. The gate is a secret in a custom
// (non-safelisted) header, which forces a preflight this server never answers,
// plus refusing any request that carries an Origin at all.
//
// Why here and not only in test/internal-auth.test.mjs: that suite tests the
// helper in isolation and cannot catch a handler that forgets to call it, or a
// new /internal/* route added without the gate. This drives the real server.mjs
// over real HTTP, exactly as the exploit did.
//
// Self-contained: throwaway HOME, free port, no CLI binaries, no network.
//
//   node scripts/qa/internal-csrf.mjs
//
// Exit 0 = every check passed; non-zero lists the failures.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AI_CHAT = join(ROOT, "computer", "ai-chat");
const INTERNAL_SECRET = "gate-secret-not-a-real-token";
const BOOT_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 60_000;

const failures = [];
const ok = (msg) => console.log(`ok   ${msg}`);
const bad = (msg) => { failures.push(msg); console.error(`FAIL ${msg}`); };

const hardStop = setTimeout(() => {
  console.error(`TIMEOUT: the scenario did not complete in ${SCENARIO_TIMEOUT_MS / 1000}s`);
  finish(3);
}, SCENARIO_TIMEOUT_MS);

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

const HOME = mkdtempSync(join(tmpdir(), "csrfgate-home-"));
const PORT = await freePort();
const serverLog = [];

let finishing = false;
let serverExited = false;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: AI_CHAT,
  env: {
    PATH: process.env.PATH,
    HOME,
    PORT: String(PORT),
    AI_CHAT_HOST: "127.0.0.1",
    SHELLTEAM_AI_TOKEN: INTERNAL_SECRET,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => serverLog.push(d.toString()));
server.stderr.on("data", (d) => serverLog.push(d.toString()));
server.on("exit", (code) => {
  serverExited = true;
  if (!finishing && code !== null && code !== 0) {
    console.error(`server.mjs exited early with code ${code}:\n${serverLog.join("")}`);
    finish(3);
  }
});

async function finish(code) {
  finishing = true;
  clearTimeout(hardStop);
  server.kill("SIGTERM");
  for (let i = 0; i < 100 && !serverExited; i++) await new Promise((r) => setTimeout(r, 50));
  if (!serverExited) server.kill("SIGKILL");
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  process.exit(code);
}
process.on("exit", () => server.kill("SIGKILL"));

const base = `http://127.0.0.1:${PORT}`;

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/`, { method: "GET" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.error(`server did not boot in ${BOOT_TIMEOUT_MS / 1000}s:\n${serverLog.join("")}`);
  finish(3);
}

const post = (path, { headers = {}, body = {} } = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

/** Did the cockpit actually spawn an agent? Its own log is the ground truth. */
const spawnedAnAgent = () => serverLog.join("").includes("Spawning:");

await waitForBoot();

// --- The exploit, verbatim -----------------------------------------------
const KICKOFF = "/internal/mirror/kickoff";
const PROMPT = { prompt: "CSRF-PROOF run whoami", title: "csrf" };

let res = await post(KICKOFF, {
  headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: "https://evil.example" },
  body: PROMPT,
});
if (res.status === 200) bad(`${KICKOFF}: cross-origin simple request was ACCEPTED (${res.status})`);
else ok(`${KICKOFF}: cross-origin simple request refused (${res.status})`);

// --- No secret at all, no Origin (a non-browser attacker on the box) ------
res = await post(KICKOFF, { headers: { "Content-Type": "application/json" }, body: PROMPT });
if (res.status === 200) bad(`${KICKOFF}: unauthenticated request was ACCEPTED (${res.status})`);
else ok(`${KICKOFF}: unauthenticated request refused (${res.status})`);

// --- Right secret but a browser Origin present ---------------------------
res = await post(KICKOFF, {
  headers: { "x-shellteam-internal": INTERNAL_SECRET, Origin: "https://evil.example" },
  body: PROMPT,
});
if (res.status === 200) bad(`${KICKOFF}: request with an Origin was ACCEPTED (${res.status})`);
else ok(`${KICKOFF}: valid secret + browser Origin refused (${res.status})`);

// --- Wrong secret --------------------------------------------------------
res = await post(KICKOFF, { headers: { "x-shellteam-internal": "wrong" }, body: PROMPT });
if (res.status === 200) bad(`${KICKOFF}: wrong secret was ACCEPTED (${res.status})`);
else ok(`${KICKOFF}: wrong secret refused (${res.status})`);

// The whole point: none of the above may have started an agent.
if (spawnedAnAgent()) bad("an agent was SPAWNED by a refused request");
else ok("no agent process was spawned by any refused request");

// No tab may have been created either — a refused CSRF that still leaves a slot
// behind is a resource-exhaustion vector (allocateSlotId has no cap).
const tabsFile = readdirSync(HOME).includes(".claude-chat-tabs.json");
if (tabsFile) bad("a refused request created persisted tab state");
else ok("no tab state was created by any refused request");

// --- The legitimate in-box caller still works ----------------------------
// Same shape api/routers/mirror.py sends: custom secret header, no Origin.
res = await post("/internal/dream/prune-stale-tabs", {
  headers: { "x-shellteam-internal": INTERNAL_SECRET },
  body: { maxAgeDays: 30 },
});
if (res.status === 200) ok("in-box caller with the secret still passes (dream prune 200)");
else bad(`in-box caller with the secret was refused (${res.status}) — the gate is too tight`);

console.log("");
if (failures.length) {
  console.error(`Internal-CSRF gate FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  finish(1);
} else {
  console.log("Internal-CSRF gate passed.");
  finish(0);
}

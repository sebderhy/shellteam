#!/usr/bin/env node
// Behavioral release gate for the "suddenly using my API key" regression.
//
// Scenario: Claude starts on a subscription while an Anthropic API key is also
// configured. The CLI then rewrites its OAuth file with blank, expired tokens.
// The real cockpit server must broadcast that the subscription expired and that
// billing fell back to the metered key. A new OAuth credential must restore
// subscription mode live, with no service restart.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AI_CHAT = join(ROOT, "computer", "ai-chat");
const HOME = mkdtempSync(join(tmpdir(), "subscription-recovery-home-"));
const CREDENTIALS = join(HOME, ".claude", ".credentials.json");
const SCENARIO_TIMEOUT_MS = 30_000;

mkdirSync(dirname(CREDENTIALS), { recursive: true });

function writeClaudeOAuth(value) {
  writeFileSync(CREDENTIALS, JSON.stringify({ claudeAiOauth: value }));
}

writeClaudeOAuth({
  accessToken: "initial-valid-oauth",
  refreshToken: "initial-refresh",
  expiresAt: Date.now() + 3_600_000,
  refreshTokenExpiresAt: Date.now() + 86_400_000,
  subscriptionType: "max",
});

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const logs = [];
let finishing = false;
let serverExited = false;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: AI_CHAT,
  env: {
    PATH: process.env.PATH,
    HOME,
    PORT: String(PORT),
    AI_CHAT_HOST: "127.0.0.1",
    ANTHROPIC_API_KEY: "anthropic-metered-fixture-not-a-key",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => logs.push(chunk.toString()));
server.stderr.on("data", (chunk) => logs.push(chunk.toString()));
server.on("exit", (code) => {
  serverExited = true;
  if (!finishing && code !== 0) {
    console.error(`server.mjs exited early (${code}):\n${logs.join("")}`);
    finish(3);
  }
});

const timeout = setTimeout(() => {
  console.error(`TIMEOUT after ${SCENARIO_TIMEOUT_MS / 1000}s:\n${logs.join("")}`);
  finish(3);
}, SCENARIO_TIMEOUT_MS);

async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  server.kill("SIGTERM");
  for (let i = 0; i < 100 && !serverExited; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!serverExited) server.kill("SIGKILL");
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  process.exit(code);
}

process.on("exit", () => server.kill("SIGKILL"));

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    socket.messages = [];
    socket.waiters = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      const waiter = socket.waiters.find((candidate) => candidate.predicate(message));
      if (waiter) {
        socket.waiters.splice(socket.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        socket.messages.push(message);
      }
    };
    socket.onopen = () => resolve(socket);
    socket.onerror = reject;
  });
}

function waitFor(socket, predicate) {
  const index = socket.messages.findIndex(predicate);
  if (index !== -1) return Promise.resolve(socket.messages.splice(index, 1)[0]);
  return new Promise((resolve) => socket.waiters.push({ predicate, resolve }));
}

async function waitForBoot() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const socket = await connect();
      return socket;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  console.error(`Cockpit did not start:\n${logs.join("")}`);
  await finish(3);
}

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}`);
  if (!condition) failures++;
}

const socket = await waitForBoot();
const initial = await waitFor(socket, (message) => message.type === "status");
check(initial.subscriptionStatus?.claude === "connected", "starts with Claude subscription healthy");
check(initial.authMode?.claude === "subscription", "subscription wins over the ambient API key");

// This is the production failure shape observed on Jul 30: Claude retained
// subscription metadata but blanked both tokens after refresh failed.
writeClaudeOAuth({
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
  refreshTokenExpiresAt: 0,
  subscriptionType: "max",
});

const expired = await waitFor(socket, (message) =>
  message.type === "status"
  && message.subscriptionStatus?.claude === "expired"
  && message.authMode?.claude === "apikey"
);
check(expired.hasOAuth === false, "blank OAuth tokens no longer render as connected");
check(expired.authMode.claude === "apikey", "live status exposes the metered API-key fallback");

writeClaudeOAuth({
  accessToken: "reconnected-valid-oauth",
  refreshToken: "reconnected-refresh",
  expiresAt: Date.now() + 3_600_000,
  refreshTokenExpiresAt: Date.now() + 86_400_000,
  subscriptionType: "max",
});

const recovered = await waitFor(socket, (message) =>
  message.type === "status"
  && message.subscriptionStatus?.claude === "connected"
  && message.authMode?.claude === "subscription"
);
check(recovered.hasOAuth === true, "new OAuth credentials restore the connected state");
check(recovered.authMode.claude === "subscription", "billing returns to subscription without a restart");

socket.close();
console.log(failures ? `\n${failures} subscription recovery check(s) FAILED` : "\nSubscription recovery gate passed.");
await finish(failures ? 1 : 0);

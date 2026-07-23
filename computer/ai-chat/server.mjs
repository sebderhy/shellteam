import { createServer } from "node:http";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

import { PORT, HOST, HOME, PUBLIC_DIR, MIME_TYPES, WORKSPACE_LOCK, GUEST_NAME } from "./lib/constants.mjs";
import { listWorkspaces } from "./lib/workspaces.mjs";
import { installedAgents } from "./lib/agents/registry.mjs";
import { enabledModules } from "./lib/agent-layer.mjs";
import { proxyBrowserHttp, proxyBrowserUpgrade, browserProxyEnabled } from "./lib/browser-proxy.mjs";
import {
  listSessions,
  searchSessions,
  listFiles,
  expandFileReferences,
  safePath,
} from "./lib/history.mjs";
import {
  loadModel,
  saveModel,
  loadApiKey,
  saveApiKey,
  loadOpenAIApiKey,
  saveOpenAIApiKey,
  getCliEnv,
  authModeFor,
  startOAuth,
  completeOAuth,
  hasOAuthCredentials,
  hasCodexOAuthCredentials,
  startCodexDeviceAuth,
  cancelCodexAuth,
  getPendingCodexAuth,
  hasAntigravityOAuthCredentials,
  startAntigravityAuth,
  completeAntigravityAuth,
  cancelAntigravityAuth,
  getPendingAntigravityAuth,
  getPendingOAuth,
} from "./lib/session.mjs";
import {
  setBroadcast,
  restoreSlots,
  listSlots,
  createSlot,
  clientCreateSlot,
  allocateSlotId,
  hasSlot,
  flushTabs,
  deleteSlot,
  renameSlot,
  reorderSlots,
  startAgent,
  stopAgent,
  stopAllAgents,
  interruptAgent,
  sendMessage,
  resetSlot,
  resumeSession,
  rewindSlot,
  compactSlot,
  replayStateToSocket,
  addUserMessage,
  isQueryActive,
  getIsGenerating,
  getSessionId,
  setSessionId,
  getCwd,
  setCwd,
  setSlotModel,
  switchSlotModel,
  forkSlot,
  getSlotModel,
  getTotalCost,
  getApiKeySource,
  setApiKeySource,
  getHistory,
  refreshSlotFromDisk,
  pruneStaleSlots,
  markSlotUsed,
  clampToWorkspaceLock,
} from "./lib/session-manager.mjs";
import * as TerminalBridge from "./lib/terminal-bridge.mjs";
import { attachShellSocket } from "./lib/shell-terminal.mjs";
import { startDeviceFlow as startGitHubFlow, getStatus as getGitHubStatus, disconnect as disconnectGitHub } from "./lib/github-auth.mjs";
import { loadCatalog } from "./lib/model-catalog.mjs";
import {
  handleUpload as sharedHandleUpload,
  handleTranscribe as sharedHandleTranscribe,
  readBody as sharedReadBody,
  jsonResponse as sharedJsonResponse,
} from "../shared/media-handlers.mjs";
import { createLiveDelegationBroker } from "./lib/delegation-broker.mjs";
import { collectUsageCached } from "./lib/usage.mjs";
import { aiAvailability, startAiAvailabilityPolling } from "./lib/ai-availability.mjs";

// --- State ---
const browserSockets = new Set();
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

const delegationBroker = createLiveDelegationBroker({
  createSlot,
  setSlotModel,
  setCwd,
  resetSlot,
  resumeSession,
  addUserMessage,
  isQueryActive,
  startAgent,
  sendMessage,
  interruptAgent,
  log(level, message) {
    const prefix = `[delegation-broker] ${message}`;
    if (level === "warn") console.warn(prefix);
    else console.log(prefix);
  },
});

function isBrokerPayload(obj) {
  return obj?.slot !== undefined && delegationBroker.isBrokerSlot(obj.slot);
}

// Wire up broadcast
function broadcast(obj) {
  delegationBroker.handleWorkerEvent(obj).catch((err) => {
    console.error("[delegation-broker] Failed to handle worker event:", err.message);
  });
  const data = JSON.stringify(obj);
  for (const ws of browserSockets) {
    const wantsBroker = ws._clientType === "broker";
    if (isBrokerPayload(obj) && !wantsBroker) continue;
    if (isBrokerPayload(obj) && wantsBroker && !ws._brokerSlots?.has(obj.slot)) continue;
    if (ws.readyState === 1) ws.send(data);
  }
}
setBroadcast(broadcast);
restoreSlots();

// Keep key-gated capability flags (OpenCode, voice input) live: poll the
// control plane and push a fresh status to every connected client the moment
// a feature key is added/removed in the dashboard — no cockpit restart.
startAiAvailabilityPolling({ onChange: () => broadcast(buildStatus()) });

// --- Status builder ---

// The credential/provider flags every status payload carries. Single source of
// truth so the WS `buildStatus` and the HTTP `/api/status` can never drift (a
// missing `hasAntigravityOAuth` on one side once made the Settings dot flip).
function authFlags() {
  // Key-gated capabilities (OpenCode/Fireworks, voice input/ElevenLabs) come
  // from the control plane's LIVE /internal/ai/status — the dashboard's
  // Feature-keys settings change them at runtime, so this process's spawn-time
  // env would go stale. aiAvailability() falls back to process env only while
  // the control plane is unreachable.
  const ai = aiAvailability();
  return {
    hasApiKey: !!loadApiKey(),
    hasOpenAIKey: !!loadOpenAIApiKey(),
    hasOAuth: hasOAuthCredentials(),
    hasCodexOAuth: hasCodexOAuthCredentials(),
    hasAntigravityOAuth: hasAntigravityOAuthCredentials(),
    // OpenCode runs on the managed Fireworks proxy; it only works when the box
    // actually holds a Fireworks key. Surface that so the UI never treats
    // OpenCode as a universal fallback on a box that hasn't configured it.
    hasOpenCode: ai.opencode,
    // Voice input needs an ElevenLabs key on the control plane — the client
    // hides the mic button when this is false.
    sttAvailable: ai.stt,
    // Which agent CLIs exist on this box's PATH ({ claude: true, … }). The UI
    // hides setup tabs and model-picker groups for absent families — the
    // employee container only ships claude + codex.
    installedAgents: installedAgents(),
    apiKeySource: getApiKeySource(),
    // How each family will BILL: "subscription" (OAuth, on the user's plan),
    // "apikey" (pay-per-token — expensive), "included" (managed proxy), or "none".
    // Derived from the SAME authModeFor() that decides what getCliEnv() launches
    // with, so the UI badge can never disagree with what actually runs.
    authMode: {
      claude: authModeFor("claude"),
      codex: authModeFor("codex"),
      antigravity: authModeFor("antigravity"),
      opencode: authModeFor("opencode"),
    },
  };
}

function buildStatus(overrides = {}) {
  // The top-level cwd/sessionId/… are legacy slot-0 fields (the client derives
  // real per-slot state from `slots`). Read them from the lowest EXISTING slot,
  // never a hardcoded `getCwd(0)` — those getters call ensureSlot(0), which
  // RE-CREATES slot 0 as a read side effect. After the user closes slot 0
  // (SHE-50) the very next status broadcast would otherwise resurrect it (and
  // persist it back to TABS_FILE), reopening the exact bug. listSlots() never
  // creates, so the primary id is a real, present slot.
  const userSlots = listSlots().filter((s) => !delegationBroker.isBrokerSlot(s.id));
  const primaryId = userSlots[0]?.id ?? 0;
  return {
    type: "status",
    ...authFlags(),
    // Workspace lock (guest cockpit): both null on a normal box. When locked,
    // the client hides the workspace switcher and shows a lock badge —
    // enforcement itself is server-side (set_cwd guard + session-manager clamp).
    workspaceLock: WORKSPACE_LOCK,
    guestName: GUEST_NAME,
    model: loadModel(),
    cwd: getCwd(primaryId),
    sessionId: getSessionId(primaryId),
    totalCost: getTotalCost(primaryId),
    isGenerating: getIsGenerating(primaryId),
    slots: userSlots.map(s => ({
      ...s,
      totalCost: getTotalCost(s.id),
    })),
    ...overrides,
  };
}

// The wire shape the cockpit expects for one past session (list + search share it).
const sessionListRecord = (s) => ({
  sessionId: s.sessionId,
  firstMessage: s.firstMessage,
  mtime: s.mtime,
  project: s.project,
  cwd: s.cwd,
  model: s.model,
  turnCount: s.turnCount,
  provider: s.provider,
});

// --- File API helpers (readBody/jsonResponse from shared/media-handlers.mjs) ---

const readBody = sharedReadBody;
const jsonResponse = sharedJsonResponse;

function handleFileAPI(req, res) {
  const forwarded = req.headers["x-forwarded-by"];
  if (forwarded !== "nginx") {
    jsonResponse(res, 403, { error: "Direct access forbidden" });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  if (route === "/_api/zip" && req.method === "GET") {
    const zipPath = url.searchParams.get("path") || "";
    const abs = safePath(zipPath);
    if (!abs) return jsonResponse(res, 400, { error: "Invalid path" });
    if (!existsSync(abs)) return jsonResponse(res, 404, { error: "Not found" });
    const stat = statSync(abs);
    const name = abs.split("/").pop();

    if (stat.isDirectory()) {
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${name}.zip"`,
      });
      const proc = spawn("zip", ["-r", "-", "."], { cwd: abs, stdio: ["ignore", "pipe", "ignore"] });
      proc.stdout.pipe(res);
      proc.on("error", () => { res.end(); });
    } else {
      const parent = dirname(abs);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${name}.zip"`,
      });
      const proc = spawn("zip", ["-", name], { cwd: parent, stdio: ["ignore", "pipe", "ignore"] });
      proc.stdout.pipe(res);
      proc.on("error", () => { res.end(); });
    }
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "Method not allowed" });
    return;
  }

  if (route === "/_api/write") {
    readBody(req).then((body) => {
      const { path: filePath, content } = JSON.parse(body.toString());
      const abs = safePath(filePath);
      if (!abs) return jsonResponse(res, 400, { error: "Invalid path" });
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      jsonResponse(res, 200, { ok: true });
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (route === "/_api/upload") {
    const filePath = req.headers["x-file-path"];
    const abs = safePath(filePath);
    if (!abs) return jsonResponse(res, 400, { error: "Invalid path" });
    readBody(req).then((body) => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      jsonResponse(res, 200, { ok: true });
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (route === "/_api/mkdir") {
    readBody(req).then((body) => {
      const { path: dirPath } = JSON.parse(body.toString());
      const abs = safePath(dirPath);
      if (!abs) return jsonResponse(res, 400, { error: "Invalid path" });
      mkdirSync(abs, { recursive: true });
      jsonResponse(res, 200, { ok: true });
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (route === "/_api/delete") {
    readBody(req).then((body) => {
      const { path: delPath } = JSON.parse(body.toString());
      const abs = safePath(delPath);
      if (!abs) return jsonResponse(res, 400, { error: "Invalid path" });
      if (!existsSync(abs)) return jsonResponse(res, 404, { error: "Not found" });
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        rmSync(abs, { recursive: true });
      } else {
        unlinkSync(abs);
      }
      jsonResponse(res, 200, { ok: true });
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (route === "/_api/rename") {
    readBody(req).then((body) => {
      const { oldPath, newPath } = JSON.parse(body.toString());
      const absOld = safePath(oldPath);
      const absNew = safePath(newPath);
      if (!absOld || !absNew) return jsonResponse(res, 400, { error: "Invalid path" });
      if (!existsSync(absOld)) return jsonResponse(res, 404, { error: "Not found" });
      mkdirSync(dirname(absNew), { recursive: true });
      renameSync(absOld, absNew);
      jsonResponse(res, 200, { ok: true });
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  jsonResponse(res, 404, { error: "Unknown API route" });
}

// --- Voice/Upload handlers from shared module ---

const handleTranscribe = sharedHandleTranscribe;
const handleUpload = sharedHandleUpload;

// --- HTTP Server ---

const server = createServer((req, res) => {
  // Employee "Browser" tab: forward /ui/* + /v1/* to this employee's OWN Steel
  // sidecar (inert unless STEEL_BROWSER_URL is set — owner cockpit unaffected).
  if (proxyBrowserHttp(req, res)) return;

  if (req.url === "/upload" && req.method === "POST") {
    handleUpload(req, res).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (req.url === "/transcribe" && req.method === "POST") {
    handleTranscribe(req, res);
    return;
  }

  if (req.url === "/internal/dream/prune-stale-tabs" && req.method === "POST") {
    readBody(req).then((body) => {
      const { maxAgeDays } = JSON.parse(body.toString());
      jsonResponse(res, 200, pruneStaleSlots(maxAgeDays));
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  // --- HTTP API for OAuth + key management ---
  if (req.url === "/api/test-key" && req.method === "POST") {
    readBody(req).then(async (body) => {
      const { provider } = JSON.parse(body.toString());
      const start = Date.now();
      const username = process.env.SHELLTEAM_USERNAME || "user";

      if (provider === "claude") {
        if (!loadApiKey() && !hasOAuthCredentials()) {
          return jsonResponse(res, 200, { success: false, error: "No Claude key or OAuth credentials" });
        }
        const proc = spawn("claude", [
          "-p", `Hi, I'm ShellTeam user ${username}, testing that my Claude configuration works. Reply with just: ok`,
          "--model", "claude-haiku-4-5-20251001", "--max-turns", "1",
        ], { cwd: HOME, timeout: 20000, env: getCliEnv(), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => {
          const latency = Date.now() - start;
          if (code === 0 && stdout.trim()) {
            jsonResponse(res, 200, { success: true, latency_ms: latency });
          } else {
            const errMsg = stderr.trim().split("\n").pop() || stdout.trim() || `Exit code ${code}`;
            jsonResponse(res, 200, { success: false, error: errMsg });
          }
        });
        proc.on("error", (err) => {
          jsonResponse(res, 200, { success: false, error: err.message });
        });
      } else if (provider === "openai") {
        if (!loadOpenAIApiKey() && !hasCodexOAuthCredentials()) {
          return jsonResponse(res, 200, { success: false, error: "No OpenAI key or OAuth credentials" });
        }
        const proc = spawn("codex", [
          "exec", "--skip-git-repo-check",
          `Hi, I'm ShellTeam user ${username}, testing that my OpenAI configuration works. Reply with just: ok`,
        ], { cwd: HOME, timeout: 30000, env: getCliEnv(), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => {
          const latency = Date.now() - start;
          if (code === 0) {
            jsonResponse(res, 200, { success: true, latency_ms: latency });
          } else {
            const errMsg = stderr.trim().split("\n").pop() || stdout.trim() || `Exit code ${code}`;
            jsonResponse(res, 200, { success: false, error: errMsg });
          }
        });
        proc.on("error", (err) => {
          jsonResponse(res, 200, { success: false, error: err.message });
        });
      } else if (provider === "antigravity") {
        if (!hasAntigravityOAuthCredentials()) {
          return jsonResponse(res, 200, { success: false, error: "No Antigravity credentials — sign in with Google first" });
        }
        // agy's one-shot print mode. --print-timeout bounds agy's own wait; the
        // spawn timeout is the hard ceiling — both kept under the FastAPI proxy's
        // 30s so a hang comes back as a clean failure, not a proxy 500.
        const proc = spawn("agy", [
          "-p", `Hi, I'm ShellTeam user ${username}, testing that my Antigravity configuration works. Reply with just: ok`,
          "--print-timeout", "22s",
        ], { cwd: HOME, timeout: 28000, env: getCliEnv(), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => {
          const latency = Date.now() - start;
          if (code === 0 && stdout.trim()) {
            jsonResponse(res, 200, { success: true, latency_ms: latency });
          } else {
            const errMsg = stderr.trim().split("\n").pop() || stdout.trim().slice(0, 200) || `Exit code ${code}`;
            jsonResponse(res, 200, { success: false, error: errMsg });
          }
        });
        proc.on("error", (err) => {
          jsonResponse(res, 200, { success: false, error: err.message });
        });
      } else {
        jsonResponse(res, 400, { error: "Unknown provider. Use 'claude', 'openai', or 'antigravity'." });
      }
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (req.url === "/api/status") {
    jsonResponse(res, 200, authFlags());
    return;
  }

  const requestUrl = new URL(req.url, "http://localhost");
  if (requestUrl.pathname === "/api/usage") {
    const force = requestUrl.searchParams.get("refresh") === "1"
      || req.headers["x-shellteam-refresh"] === "1";
    collectUsageCached({ force })
      .then((usage) => jsonResponse(res, 200, usage))
      .catch((err) => {
        console.error("[ai-chat] Usage collection failed:", err);
        jsonResponse(res, 200, { error: "Usage information is temporarily unavailable" });
      });
    return;
  }

  // Box identity for the frontend: the real $HOME (path→URL linkification must
  // recognize /home/<user>/… — the old hardcoded /home/user was a Cloud-ism)
  // and where files get URLs (the dashboard origin serves ~/<path> directly).
  if (req.url === "/api/box") {
    jsonResponse(res, 200, {
      home: HOME,
      appDomain: process.env.APP_DOMAIN || "localhost",
      apiPort: Number(process.env.API_PORT || 8000),
      // Enabled modules (layer.json) — the frontend keeps first-run copy
      // honest: never promise a browser/apps the install doesn't have.
      modules: enabledModules(),
    });
    return;
  }

  // The model catalog (config/models.json) — the browser builds the model
  // dropdown + does model->agent routing from this. Single source of truth
  // shared with the Python control plane. Add a model there, restart, done.
  if (req.url === "/api/models") {
    jsonResponse(res, 200, loadCatalog());
    return;
  }

  if (req.url === "/api/activity") {
    const slots = listSlots();
    const activeQueries = slots.filter(s => s.isGenerating);
    jsonResponse(res, 200, {
      browserConnections: browserSockets.size,
      activeQueries: activeQueries.length,
      slots: slots.map(s => ({ id: s.id, model: s.model, isGenerating: s.isGenerating })),
    });
    return;
  }

  if (req.url === "/api/oauth/start" && req.method === "POST") {
    const url = startOAuth();
    jsonResponse(res, 200, { url });
    return;
  }

  if (req.url === "/api/oauth/complete" && req.method === "POST") {
    readBody(req).then(async (body) => {
      const { code } = JSON.parse(body.toString());
      await completeOAuth(code);
      stopAllAgents();
      broadcast(buildStatus());
      jsonResponse(res, 200, { success: true });
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (req.url === "/api/codex-oauth/start" && req.method === "POST") {
    const pending = getPendingCodexAuth();
    if (pending) {
      jsonResponse(res, 200, { userCode: pending.userCode, verificationUri: pending.verificationUri });
      return;
    }
    let done = false;
    const reply = (status, payload) => { if (!done) { done = true; jsonResponse(res, status, payload); } };
    startCodexDeviceAuth(
      () => { stopAllAgents(); broadcast(buildStatus()); },
      // Relay a definitive failure (missing codex binary, instant crash)
      // immediately — waiting out the poll for a generic 504 hides the reason.
      (error) => reply(502, { error }),
    );
    let attempts = 0;
    const poll = () => {
      if (done) return;
      const code = getPendingCodexAuth();
      if (code) {
        reply(200, { userCode: code.userCode, verificationUri: code.verificationUri });
      } else if (++attempts < 30) {
        setTimeout(poll, 200);
      } else {
        reply(504, { error: "Timed out waiting for device code" });
      }
    };
    setTimeout(poll, 200);
    return;
  }

  if (req.url === "/api/antigravity-oauth/start" && req.method === "POST") {
    const pending = getPendingAntigravityAuth();
    if (pending) { jsonResponse(res, 200, { url: pending.url }); return; }
    let done = false;
    const reply = (status, payload) => { if (!done) { done = true; jsonResponse(res, status, payload); } };
    // startAntigravityAuth owns the URL-phase timeout now: on a hang it kills the
    // PTY, clears the pending slot, restores the stashed token, and fires onError —
    // so this handler just relays the outcome (no separate, non-unwinding timer).
    startAntigravityAuth(
      (url) => reply(200, { url }),
      (error) => reply(504, { error }),
    );
    return;
  }

  if (req.url === "/api/antigravity-oauth/complete" && req.method === "POST") {
    readBody(req).then(async (body) => {
      const { code } = JSON.parse(body.toString());
      await completeAntigravityAuth(code);
      stopAllAgents();
      broadcast(buildStatus());
      jsonResponse(res, 200, { success: true });
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  // GitHub connect (gh device-flow) — one code path for the owner cockpit
  // (host) and employee cockpits (container); creds land in this HOME only.
  if (req.url === "/api/github/connect" && req.method === "POST") {
    startGitHubFlow()
      .then((flow) => jsonResponse(res, 200, flow))
      .catch((err) => { console.log(`[github-auth] connect failed: ${err.message}`); jsonResponse(res, 502, { error: err.message }); });
    return;
  }

  if (req.url === "/api/github/status" && req.method === "GET") {
    getGitHubStatus().then((status) => jsonResponse(res, 200, status));
    return;
  }

  if (req.url === "/api/github/disconnect" && req.method === "POST") {
    disconnectGitHub().then(() => jsonResponse(res, 200, { status: "disconnected" }));
    return;
  }

  if (req.url === "/api/key" && req.method === "POST") {
    readBody(req).then((body) => {
      const { key } = JSON.parse(body.toString());
      if (key.startsWith("sk-ant-")) {
        saveApiKey(key);
        broadcast(buildStatus());
        jsonResponse(res, 200, { success: true, provider: "claude" });
      } else if (key.startsWith("sk-")) {
        saveOpenAIApiKey(key);
        broadcast(buildStatus());
        jsonResponse(res, 200, { success: true, provider: "openai" });
      } else {
        jsonResponse(res, 400, { error: "Key must start with sk-ant- (Claude) or sk- (OpenAI)" });
      }
    }).catch((err) => jsonResponse(res, 400, { error: err.message }));
    return;
  }

  if (req.url.startsWith("/_api/")) {
    handleFileAPI(req, res);
    return;
  }

  // --- Static files ---
  let filePath = req.url.split("?")[0];
  if (filePath === "/" || filePath === "") filePath = "/index.html";

  const fullPath = join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR + "/") && fullPath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(fullPath)) {
    const indexPath = join(PUBLIC_DIR, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(readFileSync(indexPath));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(fullPath);
  const ct = MIME_TYPES[ext] || "application/octet-stream";
  // App shell/JS/CSS change with every deploy and carry no version in their URL,
  // and the cockpit runs inside the dashboard iframe — a stale app.js/styles.css
  // would resurrect old UI. Never cache those; vendored libs are immutable.
  const cacheControl = filePath.startsWith("/vendor/")
    ? "public, max-age=604800, immutable"
    : "no-store";
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": cacheControl });
  res.end(readFileSync(fullPath));
});

// --- WebSocket Servers ---

const chatWSS = new WebSocketServer({ noServer: true });
const terminalWSS = new WebSocketServer({ noServer: true });
const shellWSS = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/ws") {
    chatWSS.handleUpgrade(req, socket, head, (ws) => chatWSS.emit("connection", ws, req));
  } else if (url.pathname === "/ws/terminal") {
    terminalWSS.handleUpgrade(req, socket, head, (ws) => terminalWSS.emit("connection", ws, req));
  } else if (url.pathname === "/ws/shell") {
    // Plain per-connection bash console (shell.html) — one pty per socket.
    shellWSS.handleUpgrade(req, socket, head, (ws) => attachShellSocket(ws));
  } else if (proxyBrowserUpgrade(req, socket, head)) {
    // handled: Steel sidecar screencast WS (/v1/sessions/cast, …)
  } else {
    socket.destroy();
  }
});

// =============================================================
// Chat WebSocket — clean switch on msg.type → SessionManager
// =============================================================

chatWSS.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  ws._clientType = url.searchParams.get("client") === "ma" ? "broker" : "browser";
  ws._brokerSlots = new Set();
  console.log(`[ai-chat] Browser connected (${browserSockets.size + 1} total)`);
  ws._lastPong = Date.now();
  browserSockets.add(ws);

  // Send status + pending OAuth state
  const status = buildStatus({
    pendingOAuth: getPendingOAuth() ? { url: getPendingOAuth().url } : null,
    pendingCodexAuth: getPendingCodexAuth(),
    pendingAntigravityAuth: getPendingAntigravityAuth(),
  });
  ws.send(JSON.stringify(status));

  // Send history for all active slots
  for (const s of listSlots().filter((slot) => !delegationBroker.isBrokerSlot(slot.id) || ws._clientType === "broker")) {
    const messages = getHistory(s.id);
    if (messages.length > 0) {
      ws.send(JSON.stringify({ type: "history", messages, slot: s.id }));
    }
  }

  // Replay in-flight streaming text
  replayStateToSocket(ws, (slotId) => !delegationBroker.isBrokerSlot(slotId) || ws._clientType === "broker");

  // Central existence gate (SHE-52): the server owns which slots exist, so a
  // slot-scoped command for an unknown id — a stale client acting on a tab
  // another device closed — must NEVER create one as a side effect. Refuse,
  // tell that client its slot is gone (it removes the ghost tab; a `send`
  // echoes the content back so no typed text is lost), and re-broadcast the
  // authoritative state.
  const requireSlot = (slot, cmd, extra = {}) => {
    if (hasSlot(slot)) return true;
    console.warn(`[ai-chat] ${cmd} for unknown slot ${slot} refused — closed on another device? (SHE-52)`);
    ws.send(JSON.stringify({ type: "slot_gone", slot, cmd, ...extra }));
    broadcast(buildStatus());
    return false;
  };

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { console.warn(`[ws] Dropping unparseable frame (${e.message}): ${data.toString().slice(0, 120)}`); return; }

    switch (msg.type) {
      case "pong": {
        ws._lastPong = Date.now();
        break;
      }

      // --- Auth ---
      case "start_oauth": {
        const url = startOAuth();
        ws.send(JSON.stringify({ type: "oauth_url", url }));
        break;
      }

      case "complete_oauth": {
        try {
          await completeOAuth(msg.code);
          stopAllAgents();
          broadcast({ type: "oauth_success" });
          broadcast(buildStatus({ apiKeySource: "oauth" }));
        } catch (err) {
          console.error("[ai-chat] OAuth error:", err.message);
          ws.send(JSON.stringify({ type: "oauth_error", error: err.message }));
        }
        break;
      }

      case "start_codex_oauth": {
        const pending = getPendingCodexAuth();
        if (pending) {
          ws.send(JSON.stringify({
            type: "codex_device_code",
            userCode: pending.userCode, verificationUri: pending.verificationUri,
          }));
          break;
        }
        startCodexDeviceAuth(
          () => {
            stopAllAgents();
            broadcast({ type: "codex_oauth_success" });
            broadcast(buildStatus());
          },
          (error) => { broadcast({ type: "codex_oauth_error", error }); },
        );
        let pollAttempts = 0;
        const pollForCode = () => {
          const code = getPendingCodexAuth();
          if (code) {
            ws.send(JSON.stringify({
              type: "codex_device_code",
              userCode: code.userCode, verificationUri: code.verificationUri,
            }));
          } else if (++pollAttempts < 30) {
            setTimeout(pollForCode, 200);
          } else {
            ws.send(JSON.stringify({
              type: "codex_oauth_error",
              error: "Timed out waiting for device code from Codex",
            }));
          }
        };
        setTimeout(pollForCode, 500);
        break;
      }

      case "cancel_codex_oauth": {
        cancelCodexAuth();
        broadcast(buildStatus());
        break;
      }

      case "start_antigravity_oauth": {
        const pending = getPendingAntigravityAuth();
        if (pending) {
          ws.send(JSON.stringify({ type: "antigravity_oauth_url", url: pending.url }));
          break;
        }
        startAntigravityAuth(
          (url) => { ws.send(JSON.stringify({ type: "antigravity_oauth_url", url })); },
          (error) => { ws.send(JSON.stringify({ type: "antigravity_oauth_error", error })); },
        );
        break;
      }

      case "complete_antigravity_oauth": {
        try {
          await completeAntigravityAuth(msg.code);
          stopAllAgents();
          broadcast({ type: "antigravity_oauth_success" });
          broadcast(buildStatus());
        } catch (err) {
          console.error("[ai-chat] Antigravity OAuth error:", err.message);
          ws.send(JSON.stringify({ type: "antigravity_oauth_error", error: err.message }));
        }
        break;
      }

      case "cancel_antigravity_oauth": {
        cancelAntigravityAuth();
        broadcast(buildStatus());
        break;
      }

      case "set_api_key": {
        if (msg.key && msg.key.startsWith("sk-ant-")) {
          saveApiKey(msg.key);
          stopAllAgents();
          broadcast({ type: "api_key_saved", hasApiKey: true });
          broadcast(buildStatus({ apiKeySource: "env" }));
        } else if (msg.key && msg.key.startsWith("sk-")) {
          saveOpenAIApiKey(msg.key);
          stopAllAgents();
          broadcast({ type: "api_key_saved", hasOpenAIKey: true });
          broadcast(buildStatus());
        }
        break;
      }

      // --- Chat messages ---
      case "send": {
        const slot = msg.slot ?? 0;
        // Echo the content back on refusal — a message typed into a tab that
        // was just closed elsewhere must never be silently lost.
        if (!requireSlot(slot, "send", { content: msg.content })) break;
        let content = msg.content;

        // Build display text for history
        let historyContent = content;
        if (Array.isArray(content)) {
          const textParts = content.filter(b => b.type === "text").map(b => b.text);
          const imageCount = content.filter(b => b.type === "image").length;
          const prefix = imageCount > 0 ? `[${imageCount} image${imageCount > 1 ? "s" : ""}] ` : "";
          historyContent = prefix + textParts.join(" ");
        }
        addUserMessage(slot, historyContent);

        // Expand @file references
        if (typeof content === "string") {
          content = expandFileReferences(content);
        } else if (Array.isArray(content)) {
          content = content.map(block => {
            if (block.type === "text" && block.text) {
              return { ...block, text: expandFileReferences(block.text) };
            }
            return block;
          });
        }

        if (!isQueryActive(slot)) await startAgent(slot);
        await sendMessage(slot, content);
        break;
      }

      case "touch_slot": {
        const slot = msg.slot ?? 0;
        // markSlotUsed refuses unknown slots — a touch is a view action (tab
        // switch) and must never create one (SHE-78: switching to a tab another
        // device just closed resurrected it). The guard also keeps getHistory's
        // ensureSlot side effect from firing on a ghost id.
        if (!markSlotUsed(slot)) break;
        // A client that just materialized a slot mid-connection (opened on
        // another device / by an agent) missed the history streamed at connect.
        // Reply to just this client so its background tab shows the full thread.
        if (msg.wantHistory) {
          ws.send(JSON.stringify({ type: "history", messages: getHistory(slot), slot }));
        }
        break;
      }

      case "interrupt": {
        const iSlot = msg.slot ?? 0;
        // hasSlot first: isQueryActive's ensureSlot would CREATE a ghost slot
        // when a stale client interrupts a tab that was closed elsewhere.
        if (hasSlot(iSlot) && isQueryActive(iSlot)) {
          interruptAgent(iSlot);
        } else {
          // No agent running — force-clear generating state on frontend
          broadcast({ type: "turn_done", slot: iSlot });
        }
        break;
      }

      case "delegate_task": {
        try {
          const result = await delegationBroker.delegateTask(msg.task || {});
          if (result.slot_id !== undefined && result.slot_id !== null) {
            ws._brokerSlots.add(result.slot_id);
          }
          ws.send(JSON.stringify({ type: "task_status", ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message || "Failed to delegate task" }));
        }
        break;
      }

      case "list_tasks": {
        const ownerType = msg.ownerType || "ma";
        ws.send(JSON.stringify({ type: "tasks_list", tasks: delegationBroker.listTasks(ownerType) }));
        break;
      }

      case "interrupt_task": {
        try {
          const result = delegationBroker.interruptTask(msg.taskId);
          ws.send(JSON.stringify({ type: "task_status", ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message || "Failed to interrupt task" }));
        }
        break;
      }

      case "list_worker_status": {
        const ownerType = msg.ownerType || "ma";
        ws.send(JSON.stringify({ type: "worker_status_list", workers: delegationBroker.listWorkerStatus(ownerType) }));
        break;
      }

      case "new_session": {
        const nsSlot = msg.slot ?? 0;
        if (!requireSlot(nsSlot, "new_session")) break;
        resetSlot(nsSlot);
        broadcast(buildStatus());
        break;
      }

      case "set_model": {
        if (msg.model) {
          const slot = msg.slot ?? 0;
          if (!requireSlot(slot, "set_model")) break;
          const prevModel = getSlotModel(slot);
          // switchSlotModel decides what happens to the conversation:
          //  - same-family switch → keeps the session (SHE-14)
          //  - cross-family switch with a live session → portable handoff
          //    (translates the conversation into the target CLI's native format)
          //  - fresh slot → plain config change
          // On a handoff error it returns { error } WITHOUT changing the model,
          // and the source session stays intact (no silent fallback).
          const result = await switchSlotModel(slot, msg.model);
          if (result.error) {
            ws.send(JSON.stringify({ type: "error", slot, message: result.error }));
            // Revert the dropdown to the model that is actually still active.
            broadcast({ type: "model_changed", model: prevModel, slot, reset: false });
            break;
          }
          saveModel(msg.model);
          broadcast({ type: "model_changed", model: msg.model, slot, reset: result.reset, handoff: result.handoff || null });
        }
        break;
      }

      case "set_cwd": {
        if (msg.cwd) {
          const slot = msg.slot ?? 0;
          if (!requireSlot(slot, "set_cwd")) break;
          const abs = resolve(msg.cwd);
          if (!abs.startsWith(HOME)) {
            ws.send(JSON.stringify({ type: "error", slot, message: "Directory must be under home" }));
            break;
          }
          // Locked cockpit: refuse (don't silently clamp) a switch outside the
          // lock so the client gets a clear error instead of a surprise cwd.
          if (WORKSPACE_LOCK && clampToWorkspaceLock(abs) !== abs) {
            ws.send(JSON.stringify({ type: "error", slot, message: `This workspace is locked to ${WORKSPACE_LOCK} — can't switch outside it` }));
            break;
          }
          if (!existsSync(abs)) {
            ws.send(JSON.stringify({ type: "error", slot, message: "Directory not found" }));
            break;
          }
          setCwd(slot, abs);
          resetSlot(slot);
          broadcast({ type: "cwd_changed", cwd: abs, slot });
        }
        break;
      }

      case "list_workspaces": {
        ws.send(JSON.stringify({ type: "workspaces_list", workspaces: listWorkspaces() }));
        break;
      }

      case "list_directories": {
        // Locked cockpit: browsing roots at the lock and never escapes it
        // (segment-safe via the clamp); unlocked keeps the historic HOME check.
        const prefix = msg.prefix || WORKSPACE_LOCK || HOME;
        const abs = resolve(prefix);
        const outsideRoot = WORKSPACE_LOCK
          ? clampToWorkspaceLock(abs) !== abs
          : !abs.startsWith(HOME);
        if (outsideRoot) {
          ws.send(JSON.stringify({ type: "directories_list", dirs: [] }));
          break;
        }
        const dirs = [];
        try {
          const entries = readdirSync(abs, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
            if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
            dirs.push({ path: join(abs, entry.name), label: entry.name });
          }
        } catch { /* dir doesn't exist or not readable */ }
        ws.send(JSON.stringify({ type: "directories_list", dirs }));
        break;
      }

      // --- Session operations ---
      case "list_sessions": {
        ws.send(JSON.stringify({
          type: "sessions_list",
          sessions: listSessions().map(sessionListRecord),
        }));
        break;
      }

      // Content/path search across ALL sessions on disk (SHE-82) — the browser
      // only holds the newest 50, so a term in an older conversation, or the
      // folder it ran in (e.g. ~/avsv), is only findable server-side. The scan
      // runs off-loop in a grep subprocess (round-7 P1). Latest-query-wins: a
      // new keystroke aborts this connection's in-flight scan so a burst never
      // stacks overlapping full-corpus scans. Echo the query so the client can
      // also drop any stale response.
      case "search_sessions": {
        ws._searchAbort?.abort();
        const ac = new AbortController();
        ws._searchAbort = ac;
        const query = String(msg.query || "");
        const results = await searchSessions(query, { signal: ac.signal });
        // Superseded mid-flight (or aborted): stay silent — the newer search
        // owns the answer now; sending stale results would clobber it.
        if (ws._searchAbort !== ac || ac.signal.aborted) break;
        ws.send(JSON.stringify({
          type: "sessions_search_result",
          query,
          sessions: results.map(sessionListRecord),
        }));
        break;
      }

      case "resume_session": {
        const slot = msg.slot ?? 0;
        if (!msg.sessionId) break;
        if (!requireSlot(slot, "resume_session")) break;
        const result = resumeSession(slot, msg.sessionId);
        if (result.error) {
          ws.send(JSON.stringify({ type: "error", slot, message: result.error }));
          break;
        }
        if (result.cwd) {
          broadcast({ type: "cwd_changed", cwd: result.cwd, slot });
        }
        if (result.model) {
          broadcast({ type: "model_changed", model: result.model, slot });
        }
        broadcast({ type: "session_event", slot, event: "resumed", sessionId: msg.sessionId });
        broadcast({ type: "history", messages: getHistory(slot), slot });
        broadcast(buildStatus());
        break;
      }

      case "compact": {
        const slot = msg.slot ?? 0;
        if (!requireSlot(slot, "compact")) break;
        const result = await compactSlot(slot);
        if (result.error) {
          ws.send(JSON.stringify({ type: "error", slot, message: result.error }));
        }
        break;
      }

      case "rewind": {
        const slot = msg.slot ?? 0;
        if (!requireSlot(slot, "rewind")) break;
        const count = Math.max(1, parseInt(msg.count) || 1);
        const result = rewindSlot(slot, count);
        if (result.error) {
          ws.send(JSON.stringify({ type: "error", slot, message: result.error }));
          break;
        }
        broadcast({ type: "session_event", slot, event: "rewound", userText: result.userText });
        broadcast({ type: "history", messages: getHistory(slot), slot });
        broadcast(buildStatus());
        break;
      }

      // --- Tab management ---
      case "create_tab": {
        const hint = msg.slot;
        // A non-fresh create only makes sense for an EXISTING slot (the legacy
        // touch semantics); for an unknown id it is a stale client replaying
        // tabs closed elsewhere — refuse and re-sync (SHE-78).
        if (msg.fresh !== true) {
          if (hint === undefined || hint === null) break;
          if (!clientCreateSlot(hint, undefined, false)) {
            broadcast(buildStatus());
            break;
          }
          broadcast(buildStatus());
          break;
        }
        // Fresh create: the SERVER allocates the canonical id (SHE-52). The
        // client's id is only a hint — two browsers holding the same snapshot
        // compute the same next id, and honoring both raced creates verbatim
        // merged two users' tabs into one conversation. A missing hint is the
        // draft-recovery path: the reconciled tab gets a brand-new identity
        // instead of resurrecting the closed slot's. The targeted ack lets the
        // requesting client rename its optimistic local tab.
        const config = {};
        if (msg.model) config.model = msg.model;
        if (msg.cwd) config.cwd = msg.cwd;
        const allocated = allocateSlotId(hint, (id) => delegationBroker.isBrokerSlot(id));
        createSlot(allocated, config);
        ws.send(JSON.stringify({ type: "tab_created", nonce: msg.nonce ?? null, requested: hint ?? null, slot: allocated }));
        // Broadcast so every other device materializes the new tab NOW —
        // not on the next unrelated status event.
        broadcast(buildStatus());
        console.log(`[ai-chat] Created tab ${allocated}${hint !== allocated ? ` (hint ${hint} taken)` : ""}`);
        break;
      }

      case "reorder_tabs": {
        // Drag-reordered tab strip (SHE-75). Persist the new order server-side
        // (survives reload/restart) and broadcast so other devices re-lay their
        // strip to match. `order` is the full slot-id list top-to-bottom.
        if (!Array.isArray(msg.order)) break;
        reorderSlots(msg.order);
        broadcast(buildStatus());
        console.log(`[ai-chat] Reordered tabs -> ${msg.order.join(",")}`);
        break;
      }

      case "rename_slot": {
        // Custom tab title. Persist server-side (so it survives reload/restart)
        // and broadcast so other connected devices update their tab strip live.
        const slot = msg.slot;
        if (slot === undefined || slot === null) break;
        if (renameSlot(slot, msg.title)) {
          const title = (msg.title || "").trim().slice(0, 40) || null;
          broadcast({ type: "slot_renamed", slot, title });
          console.log(`[ai-chat] Renamed tab ${slot} -> ${title ?? "(auto)"}`);
        }
        break;
      }

      case "fork_slot": {
        // Branch the source slot's conversation into a brand-new slot. The
        // frontend allocates the new slot id (same as create_tab). An optional
        // model forks-and-switches agent in one step. On error nothing is
        // created and the source is untouched (no silent fallback).
        const sourceSlot = msg.slot ?? 0;
        if (!requireSlot(sourceSlot, "fork_slot")) break;
        // The client's newSlot is a hint; the server allocates the canonical
        // id (same rule as create_tab — two devices forking simultaneously
        // must land on distinct slots). The nonce lets the requesting client
        // rename its optimistic local tab.
        const newSlot = allocateSlotId(msg.newSlot, (id) => delegationBroker.isBrokerSlot(id));
        const result = await forkSlot(sourceSlot, newSlot, msg.model || null);
        if (result.error) {
          ws.send(JSON.stringify({ type: "error", slot: sourceSlot, message: result.error }));
          break;
        }
        broadcast({
          type: "slot_forked", sourceSlot, slot: newSlot, nonce: msg.nonce ?? null,
          requested: msg.newSlot ?? null,
          sessionId: result.sessionId, model: result.model, cwd: result.cwd, fork: result.fork,
        });
        broadcast({ type: "history", messages: result.history, slot: newSlot });
        console.log(`[ai-chat] Forked tab ${sourceSlot} → ${newSlot}`);
        break;
      }

      case "close_tab": {
        const slot = msg.slot;
        // Any tab is closable, INCLUDING slot 0, as long as one user-visible
        // slot survives. The old `slot !== 0` guard silently dropped a close of
        // slot 0: the client removed the tab locally but the server kept the
        // slot and re-materialized it on the next status broadcast — "I closed
        // it several times and it keeps coming back" (SHE-50). "Slot 0 always
        // exists" is only a cold-start default, not a runtime invariant.
        const userSlots = listSlots().filter((s) => !delegationBroker.isBrokerSlot(s.id));
        if (slot === undefined || slot === null) {
          console.warn(`[ai-chat] close_tab ignored: no slot id in payload`);
        } else if (userSlots.length <= 1) {
          // Backstop for a client/server count desync: never leave zero tabs.
          // Log it and re-broadcast status so the client that optimistically
          // dropped the tab re-materializes it, rather than silently diverging.
          console.warn(`[ai-chat] close_tab ${slot} refused: it is the last user slot`);
          broadcast(buildStatus());
        } else {
          deleteSlot(slot);
          broadcast({ type: "tab_closed", slot });
          console.log(`[ai-chat] Closed tab ${slot}`);
        }
        break;
      }

      // --- Console mode toggle ---
      case "toggle_console": {
        const slot = msg.slot ?? 0;
        if (!requireSlot(slot, "toggle_console")) break;
        if (msg.enable) {
          const sessionId = getSessionId(slot);
          if (!sessionId) {
            ws.send(JSON.stringify({ type: "error", slot, message: "Start a conversation first, then switch to console mode." }));
            break;
          }
          const model = getSlotModel(slot);
          const cwd = getCwd(slot);
          stopAgent(slot);
          const ok = TerminalBridge.spawn_(stopAllAgents, { sessionId, model, cwd });
          if (ok) {
            broadcast({ type: "console_mode", enabled: true, slot, sessionId });
          } else {
            ws.send(JSON.stringify({ type: "error", slot, message: "Terminal mode not available (node-pty not installed)" }));
          }
        } else {
          TerminalBridge.kill();
          // Refresh SessionManager state from disk — PTY turns are not in memory
          const freshMessages = refreshSlotFromDisk(slot);
          broadcast({ type: "console_mode", enabled: false, slot });
          broadcast({ type: "history", messages: freshMessages || getHistory(slot), slot });
          broadcast(buildStatus());
        }
        break;
      }

      // --- Files ---
      case "list_files": {
        const slot = msg.slot ?? 0;
        const cwd = getCwd(slot);
        ws.send(JSON.stringify({ type: "files_list", files: listFiles(cwd), cwd }));
        break;
      }
    }
  });

  ws.on("close", () => {
    browserSockets.delete(ws);
    console.log(`[ai-chat] Browser disconnected (${browserSockets.size} remaining)`);
  });
});

// --- Terminal WebSocket (unchanged) ---

terminalWSS.on("connection", (ws) => {
  console.log("[ai-chat] Terminal client connected");
  TerminalBridge.addSocket(ws);

  if (!TerminalBridge.isRunning()) {
    // If console mode already requested a spawn via toggle_console, the PTY
    // may not be up yet. Wait briefly for it, otherwise spawn a standalone one.
    let waited = 0;
    const waitForPty = () => {
      if (TerminalBridge.isRunning()) return; // spawned by toggle_console
      if (waited++ < 10) { setTimeout(waitForPty, 100); return; }
      // No PTY after 1s — spawn a standalone terminal (legacy path)
      const ok = TerminalBridge.spawn_(stopAllAgents);
      if (!ok) {
        ws.send(JSON.stringify({ type: "terminal_error", error: "Terminal mode not available (node-pty not installed)" }));
      }
    };
    waitForPty();
  }

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { console.warn(`[ws] Dropping unparseable frame (${e.message}): ${data.toString().slice(0, 120)}`); return; }
    TerminalBridge.handleMessage(ws, msg);
  });
});

// --- Graceful Shutdown ---

function shutdown() {
  clearInterval(heartbeatInterval);
  // A tab created/closed inside the 300 ms save debounce must survive the
  // restart — flush before exiting so clients never need to resurrect tabs.
  flushTabs();
  stopAllAgents();
  TerminalBridge.kill();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Heartbeat: detect dead browser connections ---
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  for (const ws of browserSockets) {
    if (now - ws._lastPong > HEARTBEAT_TIMEOUT_MS) {
      console.log("[ai-chat] Heartbeat timeout — terminating dead socket");
      browserSockets.delete(ws);
      ws.terminate();
      continue;
    }
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
  }
}, HEARTBEAT_INTERVAL_MS);

// --- Start ---
// No boot-time dotfile writes: creating/patching ~/.claude.json here would
// violate the additive-layer rule (docs/FOOTPRINT.md). The onboarding flag is
// only set inside the user-initiated OAuth login (session.mjs), where writing
// the user's Claude credentials is the requested outcome.
server.listen(PORT, HOST, () => {
  console.log(`[ai-chat] Listening on ${HOST}:${PORT}`);
  console.log(`[ai-chat] API key: ${!!loadApiKey()}, OAuth: ${hasOAuthCredentials()}`);
});

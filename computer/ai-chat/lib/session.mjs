import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { spawn as ptySpawn } from "node-pty";
import {
  HOME,
  API_KEY_FILE,
  OPENAI_API_KEY_FILE,
  MODEL_FILE,
  DEFAULT_MODEL,
  CREDENTIALS_FILE,
  CODEX_AUTH_FILE,
  ANTIGRAVITY_AUTH_FILE,
  CLAUDE_CONFIG_FILE,
  OAUTH_CLIENT_ID,
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES,
} from "./constants.mjs";
import { agentIdFor } from "./agents/registry.mjs";
import { opencodeConfigPath } from "./agent-layer.mjs";
// clearAllHistory removed — history is now managed by SessionManager

// --- State ---
let pendingOAuth = null;
let pendingCodexAuth = null; // { process, userCode, verificationUri }
let pendingAntigravityAuth = null; // { pty, url, done }

export function getPendingOAuth() { return pendingOAuth; }

// --- Model ---
export function loadModel() {
  if (existsSync(MODEL_FILE)) return readFileSync(MODEL_FILE, "utf8").trim();
  return DEFAULT_MODEL;
}

export function saveModel(model) {
  try {
    mkdirSync(dirname(MODEL_FILE), { recursive: true });
    writeFileSync(MODEL_FILE, model);
  } catch (err) {
    console.error(`[saveModel] Failed to persist model="${model}" to ${MODEL_FILE}: ${err.message}`);
  }
}

// Model-family helpers — delegate to the registry so the truth lives in one place.
export const isCodexModel    = (m) => agentIdFor(m) === "codex";
export const isOpenCodeModel = (m) => agentIdFor(m) === "opencode";

// Saving one auth method (API key or OAuth) clears the alternate so the CLI
// doesn't pick up a stale credential from a previous setup.
function clearAuthFile(path, label) {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
    console.log(`[ai-chat] Cleared stale ${label} at ${path} — alternate auth just saved`);
  } catch (err) {
    console.warn(`[ai-chat] Could not clear stale ${label} at ${path}: ${err.message}`);
  }
}

// --- API Key ---
// --- API key resolution (SHE-22) --------------------------------------------
// Two stores hold provider keys: the Settings UI writes ~/.config/shellteam/*
// (an explicit, interactive action), while .env / the environment carry the
// installer-managed default. The interactive file wins — but if BOTH are set
// and differ, that is exactly the silent-drift footgun this reconciles, so we
// warn loudly (once) instead of quietly shadowing the .env value.
const _keyDriftWarned = new Set();
function resolveProviderKey(fileValue, envValue, label) {
  if (fileValue && envValue && fileValue !== envValue && !_keyDriftWarned.has(label)) {
    _keyDriftWarned.add(label);
    console.warn(
      `[ai-chat] ${label}: set in BOTH ~/.config/shellteam (Settings) and the ` +
      `environment/.env, and they differ — using the Settings value. Clear one ` +
      `to silence this (Settings overrides .env by design).`
    );
  }
  return fileValue || envValue || null;
}

export function loadApiKey() {
  if (existsSync(API_KEY_FILE)) {
    return readFileSync(API_KEY_FILE, "utf8").trim();
  }
  return null;
}

export function saveApiKey(key) {
  const dir = dirname(API_KEY_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(API_KEY_FILE, key);
  clearAuthFile(CREDENTIALS_FILE, "Claude OAuth credentials");
}

// --- OpenAI API Key ---
export function loadOpenAIApiKey() {
  const fileValue = existsSync(OPENAI_API_KEY_FILE)
    ? readFileSync(OPENAI_API_KEY_FILE, "utf8").trim()
    : null;
  return resolveProviderKey(fileValue, process.env.OPENAI_API_KEY || null, "OpenAI API key");
}

export function saveOpenAIApiKey(key) {
  const dir = dirname(OPENAI_API_KEY_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(OPENAI_API_KEY_FILE, key);
  clearAuthFile(CODEX_AUTH_FILE, "Codex OAuth credentials");
  // The OpenAI-API provider is no longer written into ~/.codex/config.toml — the
  // cockpit adds it as a launch-time `-c` override when this key file exists
  // (see agent-layer.mjs codexLayerArgs). Keeps the user's ~/.codex untouched.
}

// --- Auth mode: subscription (OAuth) vs API key ---------------------------
// SINGLE source of truth for BOTH the launch env (getCliEnv, below) and the
// cockpit's UI badge, so what the indicator shows can never drift from what
// actually runs. Precedence is ALWAYS subscription-first: an API-key env var
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) silently overrides an OAuth login in
// every CLI, and API-key billing is pay-per-token — *far* more expensive. So
// whenever a subscription (OAuth) exists we IGNORE the key and strip its env
// var; we fall back to the API key only when there is no subscription to use.
// (An ambient ANTHROPIC_API_KEY leaking through the process env this way cost
// $575 before the subscription-first rule existed.)
function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(`[ai-chat] Could not parse ${path} as JSON: ${err.message}`);
    return null;
  }
}

// A Claude subscription = OAuth tokens in ~/.claude/.credentials.json.
function claudeHasSubscription() {
  return !!readJsonSafe(CREDENTIALS_FILE)?.claudeAiOauth?.accessToken;
}
// A Codex subscription = ChatGPT OAuth tokens in ~/.codex/auth.json (that file
// also exists for API-key logins, which carry no `tokens` — so parse, don't stat).
function codexHasSubscription() {
  return !!readJsonSafe(CODEX_AUTH_FILE)?.tokens?.access_token;
}
// Claude's API key can come from the cockpit's stored file OR an ambient env var.
function claudeApiKey() {
  return resolveProviderKey(loadApiKey(), process.env.ANTHROPIC_API_KEY || null, "Anthropic API key");
}

// Resolve a coding-agent family to how it will bill: "subscription" (OAuth,
// included in the user's plan), "apikey" (pay-per-token — expensive), "included"
// (server-side proxy, not user-billed), or "none" (not authenticated yet).
export function authModeFor(family) {
  switch (family) {
    case "claude":
      return claudeHasSubscription() ? "subscription" : claudeApiKey() ? "apikey" : "none";
    case "codex":
      return codexHasSubscription() ? "subscription" : loadOpenAIApiKey() ? "apikey" : "none";
    case "antigravity":
      // agy authenticates only via Google OAuth — there is no user-API-key path.
      // Validate the token (not bare file existence): agy can leave a partial/
      // corrupt token file during sign-in, which must NOT read as connected.
      return hasAntigravityOAuthCredentials() ? "subscription" : "none";
    case "opencode":
      return "included"; // server-side Fireworks proxy — never user-billed
    default:
      return null;
  }
}

// Apply an API key to its env var(s), or strip them when key is null. Stripping
// is the whole point in subscription mode: it removes any ambient/stale key that
// would otherwise hijack the OAuth login.
function applyKeyVars(env, vars, key) {
  for (const v of vars) {
    if (key) env[v] = key;
    else delete env[v];
  }
}

export function getCliEnv(cwd = HOME) {
  const env = { ...process.env, HOME };

  // Subscription-first (see authModeFor): pass a family's API key through ONLY in
  // genuine apikey mode; in subscription/none mode strip the var so an ambient or
  // stale key can't silently override — and out-bill — the user's subscription.
  const claudeMode = authModeFor("claude");
  const codexMode = authModeFor("codex");
  applyKeyVars(env, ["ANTHROPIC_API_KEY"], claudeMode === "apikey" ? claudeApiKey() : null);
  applyKeyVars(env, ["OPENAI_API_KEY"], codexMode === "apikey" ? loadOpenAIApiKey() : null);
  // Google/Antigravity: agy uses its own Google OAuth token; a GEMINI_API_KEY /
  // GOOGLE_API_KEY in the env (often ambient on the box) hijacks that into a
  // degraded API-key backend. No agent we launch needs these keys — always strip.
  applyKeyVars(env, ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"], null);
  console.log(`[ai-chat] Auth mode — claude=${claudeMode} codex=${codexMode}`);

  // OpenCode loads ShellTeam's additive layer (Fireworks provider + MCP + skills)
  // via OPENCODE_CONFIG — it MERGES with the user's own OpenCode config, never
  // replaces it. No-op if the layer hasn't been built yet. cwd-aware so the
  // dreaming module can add the folder's knowledge to `instructions`.
  const ocConfig = opencodeConfigPath(cwd);
  if (ocConfig) {
    env.OPENCODE_CONFIG = ocConfig;
  }
  return env;
}

// --- OAuth ---
export function startOAuth() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  const url = `${OAUTH_AUTHORIZE_URL}?${params}`;
  pendingOAuth = { verifier, state, url };
  return url;
}

export async function completeOAuth(codeWithState) {
  if (!pendingOAuth) throw new Error("No pending OAuth flow");

  const hashIdx = codeWithState.lastIndexOf("#");
  let code, state;
  if (hashIdx > 0) {
    code = codeWithState.slice(0, hashIdx);
    state = codeWithState.slice(hashIdx + 1);
  } else {
    code = codeWithState;
    state = null;
  }

  if (state && state !== pendingOAuth.state) {
    throw new Error("State mismatch — please try again");
  }

  const body = {
    grant_type: "authorization_code",
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: pendingOAuth.verifier,
    state: pendingOAuth.state,
  };

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const tokens = await resp.json();

  const claudeDir = join(HOME, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    CREDENTIALS_FILE,
    JSON.stringify(
      {
        claudeAiOauth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          scopes: (tokens.scope || OAUTH_SCOPES).split(" "),
        },
      },
      null,
      2
    )
  );
  chmodSync(CREDENTIALS_FILE, 0o600);
  clearAuthFile(API_KEY_FILE, "Claude API key");

  ensureOnboardingComplete();

  pendingOAuth = null;
  console.log("[ai-chat] OAuth credentials saved");
}

export function hasOAuthCredentials() {
  return existsSync(CREDENTIALS_FILE);
}


// --- Codex OAuth (device code flow) ---
export function hasCodexOAuthCredentials() {
  return existsSync(CODEX_AUTH_FILE);
}

export function getPendingCodexAuth() {
  // Only a parsed device code counts as "pending" for callers — the internal
  // slot is claimed earlier (synchronously at spawn) purely to dedupe starts.
  return pendingCodexAuth?.userCode
    ? { userCode: pendingCodexAuth.userCode, verificationUri: pendingCodexAuth.verificationUri }
    : null;
}

export function startCodexDeviceAuth(onSuccess, onError) {
  if (pendingCodexAuth) return getPendingCodexAuth();

  const proc = spawn("codex", ["login", "--device-auth"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME },
  });
  // Claim the pending slot SYNCHRONOUSLY: the device code takes ~1-2s to parse,
  // and a second start inside that window (double-click, or the HTTP and WS
  // paths racing) would otherwise spawn a second `codex login` whose exit then
  // clobbers the live attempt's state.
  pendingCodexAuth = { process: proc, userCode: null, verificationUri: null };

  // A missing/broken `codex` binary (ENOENT) emits 'error', not 'close'. Without
  // this handler Node throws on the unhandled 'error' AND the caller polls
  // getPendingCodexAuth() forever → the UI hangs on "Connecting…" (seen in an
  // employee container that shipped no codex CLI). Surface it as a clean auth
  // failure instead.
  proc.on("error", (err) => {
    if (pendingCodexAuth?.process !== proc) return; // cancelled/stale attempt
    pendingCodexAuth = null;
    const detail = err?.code === "ENOENT"
      ? "the Codex CLI is not installed in this workspace"
      : err?.message || String(err);
    console.error(`[ai-chat] Codex OAuth: could not start device auth — ${detail}`);
    onError?.(`Could not start Codex sign-in — ${detail}.`);
  });

  let output = "";
  let codeEmitted = false;

  const handleData = (chunk) => {
    output += chunk.toString();
    if (codeEmitted) return;

    // Parse URL and user code from output (with ANSI codes stripped)
    const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
    const urlMatch = clean.match(/(https:\/\/auth\.openai\.com\/\S+)/);
    const codeMatch = clean.match(/^\s+([A-Z0-9]+-[A-Z0-9]+)\s*$/m);
    if (urlMatch && codeMatch) {
      codeEmitted = true;
      if (pendingCodexAuth?.process !== proc) return; // cancelled meanwhile
      pendingCodexAuth.userCode = codeMatch[1];
      pendingCodexAuth.verificationUri = urlMatch[0];
    }
  };

  proc.stdout.on("data", handleData);
  proc.stderr.on("data", handleData);

  proc.on("close", (code) => {
    // A cancelled attempt's exit must not clobber a newer one (nor report a
    // spurious failure after the user already cancelled).
    if (pendingCodexAuth?.process !== proc) return;
    pendingCodexAuth = null;
    if (code === 0) {
      console.log("[ai-chat] Codex OAuth: device auth succeeded");
      clearAuthFile(OPENAI_API_KEY_FILE, "OpenAI API key");
      onSuccess?.();
    } else {
      console.error(`[ai-chat] Codex OAuth: device auth failed (exit ${code})`);
      onError?.(`Authentication failed (exit ${code})`);
    }
  });

  // Return null initially — caller should poll getPendingCodexAuth()
  // after a short delay, or the WS handler will check it
  return null;
}

export function cancelCodexAuth() {
  if (pendingCodexAuth?.process) {
    pendingCodexAuth.process.kill("SIGTERM");
    pendingCodexAuth = null;
  }
}

// --- Antigravity OAuth (agy — PTY-driven Google code-paste flow) ---
//
// `agy` has no headless `login` subcommand: sign-in is a bubbletea TUI that needs
// a real TTY, renders a Google-OAuth *authorize URL* to open, then waits for the
// *authorization code* pasted back (the redirect page displays it). That's the
// same code-paste shape as Claude's flow — but agy owns the PKCE exchange + its
// own backend handshake + token storage, so we can't reimplement it; we drive the
// real process over node-pty: auto-pick "Google OAuth", scrape the URL, inject the
// pasted code, and detect the `antigravity-oauth-token` file it writes on success.

const stripAnsi = (s) =>
  s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")
   .replace(/\x1B[()][0-9A-B]/g, "")
   .replace(/\x1B[=>]/g, "")
   .replace(/\x1B\][^\x07\x1B]*(\x07)?/g, "");

// True only when agy has written a token file that actually carries an
// access_token. agy touches its config dir early in the sign-in flow, so mere
// file existence is not proof of a completed OAuth — validate the contents, or
// the Settings dot goes green before the user has connected.
export function hasAntigravityOAuthCredentials() {
  if (!existsSync(ANTIGRAVITY_AUTH_FILE)) return false;
  try {
    const { token } = JSON.parse(readFileSync(ANTIGRAVITY_AUTH_FILE, "utf8"));
    return !!token?.access_token;
  } catch {
    return false; // partial/corrupt write — not signed in
  }
}

// agy has no `logout` subcommand and, when a valid token is already on disk, it
// skips the login-method selector entirely and boots straight into the chat TUI
// — so a "change credentials" re-auth would hang forever waiting for an authorize
// URL that never appears (verified against agy 1.0.16). To force a fresh sign-in
// we move the existing token aside before spawning agy, then either discard the
// backup (new sign-in succeeded) or restore it (re-auth cancelled/failed) so a
// user switching accounts is never left logged out by a half-finished attempt.
const ANTIGRAVITY_AUTH_BACKUP = `${ANTIGRAVITY_AUTH_FILE}.bak`;

function stashAntigravityToken() {
  if (!existsSync(ANTIGRAVITY_AUTH_FILE)) return false;
  if (existsSync(ANTIGRAVITY_AUTH_BACKUP)) unlinkSync(ANTIGRAVITY_AUTH_BACKUP);
  renameSync(ANTIGRAVITY_AUTH_FILE, ANTIGRAVITY_AUTH_BACKUP);
  console.log("[ai-chat] Antigravity OAuth: stashed existing token to force a fresh sign-in");
  return true;
}

function restoreAntigravityToken() {
  if (!existsSync(ANTIGRAVITY_AUTH_BACKUP)) return;
  if (existsSync(ANTIGRAVITY_AUTH_FILE)) unlinkSync(ANTIGRAVITY_AUTH_FILE);
  renameSync(ANTIGRAVITY_AUTH_BACKUP, ANTIGRAVITY_AUTH_FILE);
  console.warn("[ai-chat] Antigravity OAuth: re-auth did not complete — restored the previous token");
}

function discardAntigravityBackup() {
  if (existsSync(ANTIGRAVITY_AUTH_BACKUP)) unlinkSync(ANTIGRAVITY_AUTH_BACKUP);
}

export function getPendingAntigravityAuth() {
  return pendingAntigravityAuth?.url ? { url: pendingAntigravityAuth.url } : null;
}

// agy normally scrapes the authorize URL within ~1–2s. If it wedges at the TUI
// (or never surfaces a URL) we must not hang: the stashed token would stay in
// .bak (a working user temporarily logged out) and pendingAntigravityAuth would
// stay set (wedging every future start). Bound the whole "get me a URL" phase
// here so both the HTTP and WS start paths inherit one recovery.
const ANTIGRAVITY_URL_TIMEOUT_MS = 20000;

// Spawn agy, auto-select Google OAuth, and resolve once its authorize URL is
// scraped. onError fires if agy dies, or times out, before surfacing a URL.
export function startAntigravityAuth(onUrl, onError) {
  if (pendingAntigravityAuth?.url) {
    onUrl?.(pendingAntigravityAuth.url);
    return;
  }
  if (pendingAntigravityAuth) return; // a spawn is already in flight

  // Force the login selector even when the box is already signed in (agy skips it
  // otherwise). Restored below if this attempt never writes a fresh token.
  const stashed = stashAntigravityToken();

  // Wide cols so the long authorize URL isn't wrapped mid-token in the TUI pane.
  // node-pty can throw *synchronously* when the binary is absent (e.g. an
  // employee container with no `agy`); catch it so the connect fails loudly
  // instead of escaping to the WS handler and hanging/crashing the cockpit.
  let pty;
  try {
    pty = ptySpawn("agy", [], { name: "xterm-256color", cols: 1000, rows: 40, env: { ...process.env, HOME } });
  } catch (err) {
    if (stashed) restoreAntigravityToken();
    const detail = err?.code === "ENOENT" || /ENOENT|not found/i.test(err?.message || "")
      ? "the Antigravity CLI (agy) is not installed in this workspace"
      : err?.message || String(err);
    console.error(`[ai-chat] Antigravity OAuth: could not start — ${detail}`);
    onError?.(`Could not start Antigravity sign-in — ${detail}.`);
    return;
  }
  pendingAntigravityAuth = { pty, url: null, done: false };
  let buf = "", selected = false, urlSent = false, timedOut = false;

  // Single teardown for the URL-phase failure cases (early exit / timeout): clear
  // the pending slot and put the stashed token back so a hung attempt can never
  // leave the user logged out or wedge the next start.
  const unwind = () => {
    if (pendingAntigravityAuth?.pty !== pty) return; // already handed off / replaced
    pendingAntigravityAuth = null;
    if (stashed) restoreAntigravityToken();
  };

  const urlTimer = setTimeout(() => {
    if (urlSent || pendingAntigravityAuth?.pty !== pty) return;
    timedOut = true;
    console.warn(`[ai-chat] Antigravity OAuth: no authorize URL after ${ANTIGRAVITY_URL_TIMEOUT_MS / 1000}s — aborting`);
    try { pty.kill(); } catch { /* already gone */ } // onExit runs unwind()
    onError?.("Timed out waiting for the Antigravity sign-in URL");
  }, ANTIGRAVITY_URL_TIMEOUT_MS);

  pty.onData((d) => {
    buf += stripAnsi(d);
    if (!selected && /Select login method/.test(buf)) {
      selected = true;
      setTimeout(() => { try { pty.write("\r"); } catch { /* pty gone */ } }, 400); // default = Google OAuth
      return;
    }
    if (urlSent) return;
    const m = buf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[\s\S]*?(?=\n\s*[─-]{5,}|\n\s*(?:After|If you)|\s{3,}|$)/);
    if (!m) return;
    const url = m[0].replace(/\s+/g, "");
    if (url.length > 250 && /state=/.test(url)) {
      urlSent = true;
      clearTimeout(urlTimer); // URL is up — the login step has its own long budget
      pendingAntigravityAuth.url = url;
      console.log(`[ai-chat] Antigravity OAuth: authorize URL ready (${url.length} chars)`);
      onUrl?.(url);
    }
  });

  pty.onExit(({ exitCode }) => {
    clearTimeout(urlTimer);
    if (pendingAntigravityAuth?.pty === pty && !pendingAntigravityAuth.done) {
      console.warn(`[ai-chat] Antigravity OAuth: agy exited before completion (code ${exitCode})`);
      unwind(); // don't leave a re-authing user logged out
      if (!urlSent && !timedOut) onError?.(`Antigravity sign-in process exited early (code ${exitCode})`);
    }
  });
}

// Paste the authorization code into the live agy process; resolve when it writes
// its token file, reject on agy's own error line or a timeout.
export async function completeAntigravityAuth(code) {
  const pending = pendingAntigravityAuth;
  if (!pending?.pty) throw new Error("No Antigravity sign-in in progress — start it again from Settings.");
  const pty = pending.pty;

  let errLine = null;
  const sub = pty.onData((d) => {
    const m = stripAnsi(d).match(/Got an error:[^\n]*/);
    if (m) errLine = m[0].trim();
  });

  pty.write(`${code.trim()}\r`);

  // agy exchanges the code, does its backend handshake, then writes the token
  // file. Success is detected the instant the file appears (a few seconds after
  // paste), so this ceiling only bounds the failure case — keep it under the
  // FastAPI /internal/ai proxy's 30s httpx timeout so a genuine failure comes
  // back as a clean 400 error, not a proxy 500.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (hasAntigravityOAuthCredentials()) break; // a valid new token landed
    if (errLine) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  sub.dispose?.();
  pending.done = true;

  const ok = hasAntigravityOAuthCredentials();
  if (ok) await new Promise((r) => setTimeout(r, 600)); // let the write settle before we kill agy
  try { pty.kill(); } catch { /* already gone */ }
  pendingAntigravityAuth = null;

  if (ok) {
    discardAntigravityBackup(); // fresh sign-in stuck — drop the old token
    console.log("[ai-chat] Antigravity OAuth: sign-in succeeded, token persisted");
    return { ok: true };
  }
  restoreAntigravityToken(); // re-auth failed — keep the user on their previous account
  const msg = errLine
    ? errLine.replace(/^Got an error:\s*/, "")
    : "Sign-in didn't complete — no token was written. Double-check the code and try again.";
  console.error(`[ai-chat] Antigravity OAuth failed: ${msg}`);
  throw new Error(msg);
}

export function cancelAntigravityAuth() {
  if (pendingAntigravityAuth?.pty) {
    pendingAntigravityAuth.done = true;
    try { pendingAntigravityAuth.pty.kill(); } catch { /* already gone */ }
    pendingAntigravityAuth = null;
    restoreAntigravityToken(); // aborted mid-flow — put the previous token back
  }
}

export function ensureOnboardingComplete() {
  try {
    if (existsSync(CLAUDE_CONFIG_FILE)) {
      const config = JSON.parse(readFileSync(CLAUDE_CONFIG_FILE, "utf8"));
      if (!config.hasCompletedOnboarding) {
        config.hasCompletedOnboarding = true;
        writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(config));
      }
    } else {
      writeFileSync(
        CLAUDE_CONFIG_FILE,
        JSON.stringify({ hasCompletedOnboarding: true })
      );
    }
  } catch (err) {
    console.warn(`[ai-chat] Could not write ${CLAUDE_CONFIG_FILE}: ${err.message}`);
  }
}

// --- Reset ---
export function resetSession(killCLI) {
  killCLI();
  pendingOAuth = null;
  cancelCodexAuth();
  cancelAntigravityAuth();
}


import { spawn } from "node:child_process";
import { spawn as ptySpawn } from "node-pty";
import { getCliEnv, authModeFor } from "./session.mjs";

const COMMAND_TIMEOUT_MS = 12_000;
const USAGE_CACHE_TTL_MS = 5 * 60_000;

let cachedUsage = null;
let usageInFlight = null;

function stripTerminal(text = "") {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "");
}

function runCommand(command, args, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.env.HOME,
      env: getCliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, error: "Timed out waiting for provider usage" });
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

// Codex's TUI has a legacy reset-availability screen. The primary collector
// below uses its app-server protocol (which provides real percentage windows),
// but this small fallback keeps older Codex CLIs useful.
function runSlashCommand(command, args, slashCommand, {
  selectCodexReset = false,
  confirmPattern = null,
} = {}, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = ptySpawn(command, args, {
        name: "xterm-color",
        cols: 140,
        rows: 48,
        cwd: process.env.HOME,
        env: getCliEnv(),
      });
    } catch (error) {
      resolve({ ok: false, error: error.message, output: "" });
      return;
    }

    let output = "";
    let sent = false;
    let menuSelected = false;
    let confirmed = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const send = () => {
      if (sent) return;
      sent = true;
      child.write(`${slashCommand}\r`);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "Timed out waiting for provider usage", output });
    }, timeout);

    child.onData((chunk) => {
      output += chunk;
      const clean = stripTerminal(output);
      const tail = clean.slice(-1_800);
      // A standalone prompt is reliable. Keep the short timer below as a
      // fallback for versions whose prompt is painted with cursor movement.
      if (/(?:^|\n)\s*(?:›|>)\s*$/m.test(tail)) send();

      if (selectCodexReset && !menuSelected && /UsageView[\s\S]*Press enter to confirm/i.test(tail)) {
        menuSelected = true;
        child.write("\x1b[B\r");
        return;
      }
      if (confirmPattern && !confirmed && confirmPattern.test(tail)) {
        confirmed = true;
        child.write("\r");
      }
    });
    setTimeout(send, 3_000);
    child.onExit(({ exitCode }) => finish({ ok: exitCode === 0, code: exitCode, output }));
  });
}

// `codex app-server` is the installed CLI's own local protocol. Unlike the
// `/usage` TUI, account/rateLimits/read returns the actual five-hour and weekly
// subscription windows, so there is no screen scraping or inferred quota.
function runCodexRateLimits(timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      cwd: process.env.HOME,
      env: getCliEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let initialized = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      resolve(result);
    };
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish({ ok: false, error: error.message });
      }
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: "Timed out waiting for Codex rate limits" });
    }, timeout);

    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (!settled) finish({ ok: false, code, error: stderr.trim() || "Codex app-server exited before returning limits" });
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // app-server notifications are JSON; ignore malformed noise defensively
        }
        if (message.id === 1 && !initialized) {
          if (message.error) {
            finish({ ok: false, error: message.error.message || "Codex app-server initialization failed" });
          } else {
            initialized = true;
            send({ id: 2, method: "account/rateLimits/read", params: null });
          }
        } else if (message.id === 2) {
          if (message.error) finish({ ok: false, error: message.error.message || "Codex rate-limit request failed" });
          else finish({ ok: true, result: message.result || {} });
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "ShellTeam quota monitor", version: "1" } },
    });
  });
}

export function parseClaude(text) {
  const windows = [];
  const pattern = /^(Current session|Current week \(all models\)|Current week \(([^)]+)\)):\s*(\d+)% used\s*·\s*resets?\s+(.+)$/gm;
  for (const match of text.matchAll(pattern)) {
    windows.push({
      name: match[1].replace(/^Current /, ""),
      used_percent: Number(match[3]),
      remaining_percent: 100 - Number(match[3]),
      resets_at: match[4].trim(),
    });
  }
  return windows;
}

function percentWindow(name, percentage, direction, resetsAt = null) {
  const value = Math.max(0, Math.min(100, Number(percentage)));
  if (!Number.isFinite(value)) return null;
  const used = direction.toLowerCase() === "remaining" ? 100 - value : value;
  return {
    name: name.trim(),
    used_percent: used,
    remaining_percent: 100 - used,
    resets_at: resetsAt?.trim() || null,
  };
}

export function parseAntigravity(text) {
  const clean = stripTerminal(text);
  const creditPatterns = [
    /(?:AI\s+)?Credits?(?:\s+(?:remaining|available))?\s*[:—-]\s*([\d,.]+)/i,
    /([\d,.]+)\s+(?:AI\s+)?credits?\s+(?:remaining|available)/i,
  ];
  const creditsMatch = creditPatterns.map((pattern) => clean.match(pattern)).find(Boolean);
  const plan = clean.match(/\b(?:plan|tier)\b[^\n:]*:\s*([^\n]+)/i);
  const windows = [];
  const percentPattern = /^(.{2,80}?)\s*(?::|—|-)\s*(\d{1,3})%\s*(used|remaining)(?:\s*(?:·|•|-)\s*resets?\s+(.+))?$/gim;
  for (const match of clean.matchAll(percentPattern)) {
    const window = percentWindow(match[1], match[2], match[3], match[4]);
    if (window) windows.push(window);
  }
  return {
    windows,
    credits_remaining: creditsMatch ? Number(creditsMatch[1].replace(/,/g, "")) : null,
    plan_tier: plan ? plan[1].trim() : null,
  };
}

export function antigravityNeedsSetup(text) {
  return /currently not signed in|choose your color scheme|terms of service\s*&\s*data use/i.test(stripTerminal(text));
}

function isoTimestamp(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return null;
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function codexWindowLabel(durationMinutes) {
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return "quota";
  if (minutes === 300) return "5-hour";
  if (minutes === 10_080) return "weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function codexLimitLabel(snapshot) {
  if (snapshot?.limitName) return snapshot.limitName;
  if (!snapshot?.limitId || snapshot.limitId === "codex") return "Codex";
  return snapshot.limitId
    .replace(/^codex[_-]?/i, "Codex ")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function codexRateLimitWindow(limitLabel, window) {
  if (window?.usedPercent === null || window?.usedPercent === undefined
      || !Number.isFinite(Number(window.usedPercent))) return null;
  const used = Math.max(0, Math.min(100, Number(window.usedPercent)));
  return {
    name: `${limitLabel} · ${codexWindowLabel(window.windowDurationMins)}`,
    used_percent: used,
    remaining_percent: 100 - used,
    resets_at: isoTimestamp(window.resetsAt),
  };
}

// Normalize the Codex app-server result into the provider-neutral payload used
// by both the dashboard and the cockpit's inline meter. Reset-credit IDs never
// leave this function; only the useful available count is exposed.
export function parseCodexRateLimits(result = {}) {
  const snapshots = [];
  const seenLimitIds = new Set();
  const addSnapshot = (snapshot) => {
    if (!snapshot) return;
    const key = snapshot.limitId || `anonymous-${snapshots.length}`;
    if (seenLimitIds.has(key)) return;
    seenLimitIds.add(key);
    snapshots.push(snapshot);
  };
  addSnapshot(result.rateLimits);
  for (const snapshot of Object.values(result.rateLimitsByLimitId || {})) addSnapshot(snapshot);

  const windows = [];
  let planTier = null;
  let creditsRemaining = null;
  for (const snapshot of snapshots) {
    const label = codexLimitLabel(snapshot);
    const primary = codexRateLimitWindow(label, snapshot.primary);
    const secondary = codexRateLimitWindow(label, snapshot.secondary);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (!planTier && snapshot.planType) planTier = snapshot.planType;
    if (creditsRemaining === null && snapshot.credits?.hasCredits && snapshot.credits.balance !== null) {
      creditsRemaining = snapshot.credits.balance;
    }
  }

  const available = Number(result.rateLimitResetCredits?.availableCount);
  return {
    windows,
    plan_tier: planTier,
    credits_remaining: creditsRemaining,
    resets_available: Number.isFinite(available) ? available : null,
  };
}

export function parseCodex(text) {
  const clean = stripTerminal(text);
  const resets = clean.match(/(\d+) usage limit resets? available/i);
  return {
    resets_available: resets ? Number(resets[1]) : null,
  };
}

function baseProvider(id, label, mode) {
  return {
    id,
    label,
    billing: mode,
    status: mode === "none" ? "not_connected" : "checking",
    windows: [],
    credits_remaining: null,
    plan_tier: null,
    resets_available: null,
    source: "provider CLI",
  };
}

function hasQuotaData(provider) {
  return provider.windows.length > 0
    || (provider.credits_remaining !== null && provider.credits_remaining !== undefined)
    || provider.plan_tier
    || (provider.resets_available !== null && provider.resets_available !== undefined);
}

export async function collectUsage() {
  const result = {
    generated_at: new Date().toISOString(),
    providers: {
      claude: baseProvider("claude", "Claude", authModeFor("claude")),
      codex: baseProvider("codex", "Codex", authModeFor("codex")),
      antigravity: baseProvider("antigravity", "Antigravity", authModeFor("antigravity")),
    },
  };

  const checks = [];

  if (result.providers.claude.billing !== "none") checks.push((async () => {
    const response = await runCommand("claude", ["-p", "/usage", "--output-format", "json", "--no-session-persistence"]);
    if (response.ok) {
      try {
        const envelope = JSON.parse(response.stdout);
        result.providers.claude.windows = parseClaude(envelope.result || "");
        result.providers.claude.status = result.providers.claude.windows.length ? "live" : "unavailable";
        if (result.providers.claude.status === "unavailable") {
          result.providers.claude.error = "Claude did not return quota windows.";
        }
      } catch {
        result.providers.claude.status = "unavailable";
        result.providers.claude.error = "Claude returned an unreadable usage response.";
      }
    } else {
      result.providers.claude.status = "unavailable";
      result.providers.claude.error = "Claude usage is temporarily unavailable.";
    }
  })());

  if (result.providers.codex.billing !== "none") checks.push((async () => {
    const provider = result.providers.codex;
    const response = await runCodexRateLimits();
    if (response.ok) {
      Object.assign(provider, parseCodexRateLimits(response.result));
      provider.source = "Codex app-server";
      provider.status = hasQuotaData(provider) ? "live" : "unavailable";
      if (provider.status === "unavailable") provider.error = "Codex did not return rate-limit windows.";
      return;
    }

    // The app-server arrived after the older TUI path. Preserve the latter as a
    // graceful fallback for a user who has not updated Codex yet.
    const fallback = await runSlashCommand("codex", [], "/usage", { selectCodexReset: true });
    Object.assign(provider, parseCodex(fallback.output || ""));
    provider.source = "Codex CLI";
    provider.status = hasQuotaData(provider) ? "live" : "unavailable";
    if (provider.status === "unavailable") {
      provider.error = "Codex rate limits are temporarily unavailable.";
    }
  })());

  if (result.providers.antigravity.billing !== "none") checks.push((async () => {
    const provider = result.providers.antigravity;
    const response = await runSlashCommand("agy", [], "/credits", {
      confirmPattern: /credits panel|AI Credits?/i,
    });
    if (antigravityNeedsSetup(response.output || "")) {
      provider.status = "setup_required";
      provider.error = "Finish Antigravity sign-in in AI settings, then check again.";
      return;
    }
    Object.assign(provider, parseAntigravity(response.output || ""));
    provider.status = hasQuotaData(provider) ? "live" : "unavailable";
    if (provider.status === "unavailable") {
      provider.error = "Antigravity did not return credits or quota data.";
    }
  })());

  await Promise.all(checks);
  return result;
}

export async function collectUsageCached({ force = false } = {}) {
  const generatedAt = cachedUsage ? Date.parse(cachedUsage.generated_at) : 0;
  const fresh = generatedAt && Date.now() - generatedAt < USAGE_CACHE_TTL_MS;
  if (!force && fresh) return { ...cachedUsage, cached: true };
  if (usageInFlight) return usageInFlight;

  usageInFlight = collectUsage()
    .then((usage) => {
      cachedUsage = usage;
      return { ...usage, cached: false };
    })
    .finally(() => { usageInFlight = null; });
  return usageInFlight;
}

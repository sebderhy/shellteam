// GitHub connect via the gh CLI's built-in OAuth device flow.
//
// One implementation for every surface: this process runs on the host for the
// owner and inside the employee container for guests, so `gh auth login` lands
// the credential in whichever HOME this cockpit serves — never anyone else's.
// The flow is exactly what a user gets typing `gh auth login` in the Terminal
// tab, minus the typing: we background the login, hand the device code + URL
// to the UI, and `gh auth setup-git` wires git's credential helper on success
// so every coding agent can push/pull immediately.
//
// Why gh's own OAuth App (not Composio, not PATs): broad CLI-grade scopes with
// zero client-ID setup, long-lived tokens, and self-service revocation from
// the user's GitHub settings. See project_no_composio_github.md.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const LOG = join(tmpdir(), "shellteam-gh-login.log");
const PIDFILE = join(tmpdir(), "shellteam-gh-login.pid");

// `! First copy your one-time code: ABCD-1234`
const CODE_RE = /one-time code:\s*([A-Z0-9-]+)/i;
// `Open this URL ... : https://github.com/login/device`
const URL_RE = /https:\/\/github\.com\/login\/device\S*/;
// `✓ Logged in to github.com account <username> (<source>)` — one block per
// account; the block whose `Active account:` line says true is the one gh and
// git actually use. <source> is `GH_TOKEN` for an env token, else a hosts.yml
// path. Never report a non-active account (SHE-74: an env token masked the
// guest's own login and the card showed the wrong identity).
const ACCOUNT_RE = /Logged in to github\.com account (\S+) \(([^)]*)\)[^✓]*?Active account: (true|false)/gi;
const USER_RE = /Logged in to github\.com account (\S+)(?: \(([^)]*)\))?/i;

function killPending() {
  if (!existsSync(PIDFILE)) return;
  try { process.kill(-Number(readFileSync(PIDFILE, "utf8").trim())); } catch {}
  rmSync(PIDFILE, { force: true });
}

/**
 * Kick off `gh auth login --web` in the background and return the device
 * code + verification URL to show the user. The login process keeps polling
 * GitHub until the user confirms in their browser (or the code expires);
 * on success it runs `gh auth setup-git` so git pushes work right away.
 */
export async function startDeviceFlow() {
  killPending(); // the user may have re-clicked Connect
  rmSync(LOG, { force: true });

  // A missing gh is the single most common failure (a box installed before gh
  // was bundled). Detect it up front and give an actionable message instead of a
  // raw "bash: gh: command not found" (SHE-78).
  try {
    await execFileP("gh", ["--version"]);
  } catch {
    throw new Error(
      "GitHub CLI (gh) isn't installed on this box. Re-run ./install.sh to add it " +
      "(or install gh from https://github.com/cli/cli#installation), then try Connect again."
    );
  }

  // `yes y` auto-accepts gh's "Authenticate Git with your GitHub
  // credentials?" prompt; detached + unref so the poll outlives this request.
  const script =
    `yes y | gh auth login --web --git-protocol https --hostname github.com >> "${LOG}" 2>&1; ` +
    `if gh auth status --hostname github.com >/dev/null 2>&1; then ` +
    `gh auth setup-git --hostname github.com >> "${LOG}" 2>&1; fi; ` +
    `rm -f "${PIDFILE}"`;
  const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(PIDFILE, String(child.pid));

  // gh prints the one-time code within a couple of seconds; wait up to 10s.
  for (let i = 0; i < 100; i++) {
    const out = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
    const code = CODE_RE.exec(out);
    const url = URL_RE.exec(out);
    if (code && url) return { userCode: code[1], verificationUrl: url[0] };
    await new Promise((r) => setTimeout(r, 100));
  }
  killPending();
  const out = existsSync(LOG) ? readFileSync(LOG, "utf8").trim() : "";
  throw new Error(`GitHub login did not produce a device code. gh said: ${out || "(no output — is gh installed?)"}`);
}

/**
 * `{ authenticated, username, viaEnvToken }` — parsed from `gh auth status`.
 * viaEnvToken means a GH_TOKEN env var is satisfying gh (e.g. an
 * owner-provided token), not a login this user performed.
 */
export async function getStatus() {
  try {
    const { stdout, stderr } = await execFileP("gh", ["auth", "status", "--hostname", "github.com"]);
    const out = stdout + stderr;
    const accounts = [...out.matchAll(ACCOUNT_RE)];
    const active = accounts.find((m) => m[3].toLowerCase() === "true")
      ?? accounts[0] ?? USER_RE.exec(out);
    return {
      authenticated: true,
      username: active ? active[1] : null,
      viaEnvToken: (active?.[2] ?? "").includes("GH_TOKEN"),
    };
  } catch (err) {
    if (err.code === "ENOENT") return { authenticated: false, username: null, error: "gh is not installed" };
    return { authenticated: false, username: null };
  }
}

/** Cancel any in-flight login and `gh auth logout`. */
export async function disconnect() {
  killPending();
  rmSync(LOG, { force: true });
  try {
    await execFileP("gh", ["auth", "logout", "--hostname", "github.com"]);
  } catch (err) {
    // Not logged in / gh missing — nothing to revoke, but say so in the logs.
    console.log(`[github-auth] gh auth logout: ${err.stderr?.trim() || err.message}`);
  }
}

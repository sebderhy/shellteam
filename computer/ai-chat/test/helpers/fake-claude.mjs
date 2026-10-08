// A stand-in for the Claude Code binary's `auth` commands. The cockpit asks the
// binary whether a login exists and drives its sign-in; it never reads the
// credential file itself, so tests that need a Claude login put a fixture file
// where the binary would and let this script judge it the way the binary does:
// logged in when the file holds a token.
//
//   claude auth status --json   -> {"loggedIn":bool,"authMethod":...}
//   claude auth login --claudeai -> prints a URL, reads a pasted code from the
//                                   TTY, "GOOD..." logs in, anything else fails
//   claude auth logout          -> removes the file
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const creds = path.join(process.env.HOME, ".claude", ".credentials.json");
const [, , area, cmd] = process.argv;
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, process.argv.slice(2).join(" ") + "\\n");
if (area !== "auth") { console.error("fake claude: only auth is faked"); process.exit(2); }
if (cmd === "status") {
  let loggedIn = false;
  try {
    const o = JSON.parse(fs.readFileSync(creds, "utf8")).claudeAiOauth || {};
    loggedIn = !!(o.accessToken || o.refreshToken);
  } catch {}
  const apiKey = !!process.env.ANTHROPIC_API_KEY;
  console.log(JSON.stringify({ loggedIn: loggedIn || apiKey, authMethod: apiKey ? "api_key" : loggedIn ? "claude.ai" : "none" }));
  process.exit(loggedIn || apiKey ? 0 : 1);
}
if (cmd === "logout") { try { fs.unlinkSync(creds); } catch {} console.log("Logged out"); process.exit(0); }
if (cmd === "login") {
  process.stdout.write("Opening browser to sign in...\\r\\nIf the browser didn't open, visit: \\x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=FAKESTATE\\x07https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=FAKESTATE\\x1b]8;;\\x07\\r\\nPaste code here if prompted > ");
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    if (!/[\\r\\n]/.test(buf)) return;
    if (buf.trim().startsWith("GOOD")) {
      fs.mkdirSync(path.dirname(creds), { recursive: true });
      fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", subscriptionType: "max" } }));
      console.log("\\r\\nLogin successful");
      process.exit(0);
    }
    console.log("\\r\\nLogin failed: Request failed with status code 400");
    process.exit(1);
  });
  return;
}
process.exit(2);
`;

/** Put a fake `claude` first on PATH. Returns the directory holding it. */
export function installFakeClaude(root) {
  const bin = join(root, "fake-claude-bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, "claude");
  writeFileSync(file, SCRIPT);
  chmodSync(file, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return bin;
}

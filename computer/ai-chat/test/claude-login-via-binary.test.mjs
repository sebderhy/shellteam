/**
 * SHE-116: the Claude Code binary does the Claude sign-in, not the cockpit.
 *
 * Anthropic does not let a third party collect, store or intermediate Claude.ai
 * credentials, and sign-in must finish through Anthropic's own flow. The cockpit
 * used to run the OAuth exchange itself and parse ~/.claude/.credentials.json.
 * Now it drives `claude auth login` over a PTY, asks `claude auth status --json`
 * for the state, and only looks at the credential file's stat to know when to ask
 * again. A fake `claude` stands in for the binary.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const tempHome = mkdtempSync(join(tmpdir(), "claude-login-test-"));
process.env.HOME = tempHome;
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[key];
const { installFakeClaude } = await import("./helpers/fake-claude.mjs");
installFakeClaude(tempHome);
const CALLS = join(tempHome, "claude-calls.log");
process.env.FAKE_CLAUDE_LOG = CALLS;

const {
  completeClaudeAuth, getPendingOAuth, signOutClaude, startClaudeAuth, subscriptionStatusFor,
} = await import("../lib/session.mjs");

const CREDS = join(tempHome, ".claude", ".credentials.json");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const write = (value) => { mkdirSync(dirname(CREDS), { recursive: true }); writeFileSync(CREDS, JSON.stringify(value)); };
const statusCalls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8").split("\n").filter((l) => l === "auth status --json").length : 0);
const startUrl = () => new Promise((resolve, reject) => startClaudeAuth(resolve, reject));

beforeEach(() => {
  rmSync(join(tempHome, ".claude"), { recursive: true, force: true });
  rmSync(CALLS, { force: true });
  delete process.env.ANTHROPIC_API_KEY;
});
after(() => rmSync(tempHome, { recursive: true, force: true }));

describe("status comes from the binary", () => {
  it("asks `claude auth status` once per credential change, not per call", () => {
    assert.equal(subscriptionStatusFor("claude"), "none");
    assert.equal(statusCalls(), 0, "no credential file means no login, no need to ask");

    write({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    assert.equal(subscriptionStatusFor("claude"), "connected");
    assert.equal(subscriptionStatusFor("claude"), "connected");
    assert.equal(statusCalls(), 1);

    // A refresh rewrites the file (new size or mtime): ask again.
    write({ claudeAiOauth: { accessToken: "a-longer-refreshed-token", refreshToken: "r" } });
    assert.equal(subscriptionStatusFor("claude"), "connected");
    assert.equal(statusCalls(), 2);
  });

  it("a file the binary calls logged-out reads as expired", () => {
    write({ claudeAiOauth: { accessToken: "", refreshToken: "" } });
    assert.equal(subscriptionStatusFor("claude"), "expired");
  });

  it("asks without the ambient API key, so a key cannot pose as the subscription", () => {
    write({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    process.env.ANTHROPIC_API_KEY = "sk-ant-ambient";
    assert.equal(subscriptionStatusFor("claude"), "connected");
  });
});

describe("sign-in is the binary's own flow", () => {
  it("relays the authorize URL the binary prints and the code the user pastes", async () => {
    const url = await startUrl();
    assert.match(url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?.*state=FAKESTATE$/);
    assert.deepEqual(getPendingOAuth(), { url });

    await completeClaudeAuth("GOOD-CODE#FAKESTATE");
    assert.equal(getPendingOAuth(), null);
    assert.equal(subscriptionStatusFor("claude"), "connected");
    assert.ok(existsSync(CREDS), "the binary wrote its own credentials");
  });

  it("shows the binary's own error for a bad code and leaves no login behind", async () => {
    await startUrl();
    await assert.rejects(completeClaudeAuth("BAD-CODE"), /Request failed with status code 400/);
    assert.equal(getPendingOAuth(), null);
    assert.equal(existsSync(CREDS), false);
    assert.equal(subscriptionStatusFor("claude"), "none");
  });

  it("a failed re-login does not report the old login as a fresh success", async () => {
    write({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    await startUrl();
    await assert.rejects(completeClaudeAuth("BAD-CODE"), /status code 400/);
    assert.equal(subscriptionStatusFor("claude"), "connected", "the previous login is untouched");
  });

  it("refuses a code when no sign-in was started", async () => {
    await assert.rejects(completeClaudeAuth("GOOD"), /No Claude sign-in in progress/);
  });

  it("signs out through `claude auth logout`", () => {
    write({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    assert.equal(subscriptionStatusFor("claude"), "connected");
    signOutClaude();
    assert.equal(subscriptionStatusFor("claude"), "none");
    assert.match(readFileSync(CALLS, "utf8"), /auth logout/);
  });
});

describe("the cockpit stays out of Claude's credentials", () => {
  const SOURCES = ["lib/session.mjs", "lib/constants.mjs", "server.mjs"];
  const code = SOURCES.map((f) => readFileSync(join(root, f), "utf8")).join("\n");

  it("does not call Anthropic's OAuth token endpoint", () => {
    assert.doesNotMatch(code, /platform\.claude\.com\/v1\/oauth/);
    assert.doesNotMatch(code, /grant_type|code_verifier|OAUTH_TOKEN_URL|OAUTH_CLIENT_ID/);
  });

  it("does not read or write the credential file's contents", () => {
    assert.doesNotMatch(code, /claudeAiOauth/);
    assert.doesNotMatch(code, /(?:readFileSync|readJsonSafe|writeFileSync)\(\s*CREDENTIALS_FILE/);
  });
});

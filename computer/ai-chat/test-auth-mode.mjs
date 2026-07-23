/**
 * Tests for subscription-first auth resolution (authModeFor) and the launch env
 * it produces (getCliEnv).
 *
 * Guards the "$575 regression": an API-key env var (ANTHROPIC_API_KEY /
 * OPENAI_API_KEY) silently overrides an OAuth subscription in every CLI and bills
 * pay-per-token. So whenever a subscription exists we MUST strip the key; only a
 * subscription-less box may fall back to it.
 *
 * Run:  node --test computer/ai-chat/test-auth-mode.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// constants.mjs freezes HOME at first import — set it (and scrub ambient keys for
// hermeticity) BEFORE importing session.mjs.
const tempHome = mkdtempSync(join(tmpdir(), "authmode-test-"));
process.env.HOME = tempHome;
for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete process.env[k];

const { authModeFor, getCliEnv } = await import("./lib/session.mjs");

const CLAUDE_CREDS = join(tempHome, ".claude", ".credentials.json");
const CODEX_AUTH = join(tempHome, ".codex", "auth.json");
const OPENAI_KEY_FILE = join(tempHome, ".config", "shellteam", "openai-api-key");
const ANTIGRAVITY_TOKEN = join(tempHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  for (const d of [".claude", ".codex", ".config", ".gemini"]) {
    rmSync(join(tempHome, d), { recursive: true, force: true });
  }
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete process.env[k];
});

describe("authModeFor — subscription-first", () => {
  it("Claude: OAuth subscription wins over an ambient API key", () => {
    write(CLAUDE_CREDS, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-x", subscriptionType: "max" } }));
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
    assert.equal(authModeFor("claude"), "subscription");
    const env = getCliEnv();
    assert.ok(!("ANTHROPIC_API_KEY" in env), "the leaking key must be stripped when a subscription exists");
  });

  it("Claude: no subscription → ambient API key is used (apikey mode)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    assert.equal(authModeFor("claude"), "apikey");
    assert.equal(getCliEnv().ANTHROPIC_API_KEY, "sk-ant-real", "key-only users must still work");
  });

  it("Claude: nothing configured → none, no key leaks into the env", () => {
    assert.equal(authModeFor("claude"), "none");
    assert.ok(!("ANTHROPIC_API_KEY" in getCliEnv()));
  });

  it("Codex: ChatGPT OAuth tokens win over an ambient OPENAI_API_KEY", () => {
    write(CODEX_AUTH, JSON.stringify({ tokens: { access_token: "oat", refresh_token: "r" }, OPENAI_API_KEY: null }));
    process.env.OPENAI_API_KEY = "sk-openai-leak";
    assert.equal(authModeFor("codex"), "subscription");
    assert.ok(!("OPENAI_API_KEY" in getCliEnv()), "the leaking key must be stripped when Codex has a subscription");
  });

  it("Codex: an auth.json with NO tokens (API-key login) is not a subscription", () => {
    // auth.json exists for API-key logins too — must parse, not just stat.
    write(CODEX_AUTH, JSON.stringify({ tokens: null, OPENAI_API_KEY: "sk-in-file" }));
    write(OPENAI_KEY_FILE, "sk-configured");
    assert.equal(authModeFor("codex"), "apikey");
    assert.equal(getCliEnv().OPENAI_API_KEY, "sk-configured");
  });

  it("Antigravity is OAuth-only; OpenCode is included", () => {
    assert.equal(authModeFor("antigravity"), "none");
    // A partial/corrupt token file (no access_token) must NOT read as connected.
    write(ANTIGRAVITY_TOKEN, JSON.stringify({ token: { token_type: "Bearer" } }));
    assert.equal(authModeFor("antigravity"), "none", "partial token is not a subscription");
    // A valid token with an access_token is a subscription.
    write(ANTIGRAVITY_TOKEN, JSON.stringify({ token: { access_token: "ya29.real", token_type: "Bearer" } }));
    assert.equal(authModeFor("antigravity"), "subscription");
    assert.equal(authModeFor("opencode"), "included");
  });

  it("getCliEnv always strips Google keys (agy uses its own OAuth)", () => {
    process.env.GEMINI_API_KEY = "g";
    process.env.GOOGLE_API_KEY = "g2";
    const env = getCliEnv();
    assert.ok(!("GEMINI_API_KEY" in env) && !("GOOGLE_API_KEY" in env));
  });
});

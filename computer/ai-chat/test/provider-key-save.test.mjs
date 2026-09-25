/**
 * Regression: a Claude API key pasted on the Claude tab was filed as the
 * OpenAI key (the server guessed the provider from the key's prefix), and the
 * save deleted the ChatGPT login, so Codex silently fell back to metered
 * billing. The tab now decides the provider, a key that clearly belongs to the
 * other provider is refused, and saving a key never touches a subscription.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = mkdtempSync(join(tmpdir(), "provider-key-save-test-"));
process.env.HOME = tempHome;
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[key];

const { authModeFor, saveProviderKey } = await import("../lib/session.mjs");

const CLAUDE_KEY_FILE = join(tempHome, ".config", "shellteam", "api-key");
const OPENAI_KEY_FILE = join(tempHome, ".config", "shellteam", "openai-api-key");
const CLAUDE_CREDS = join(tempHome, ".claude", ".credentials.json");
const CODEX_AUTH = join(tempHome, ".codex", "auth.json");
const LATER = Date.now() + 3_600_000;

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  for (const dir of [".claude", ".codex", ".config"]) {
    rmSync(join(tempHome, dir), { recursive: true, force: true });
  }
});

after(() => rmSync(tempHome, { recursive: true, force: true }));

describe("saveProviderKey", () => {
  it("files a key under the tab it was pasted on", () => {
    saveProviderKey("claude", "sk-ant-api03-abc");
    saveProviderKey("openai", "sk-proj-xyz");
    assert.equal(readFileSync(CLAUDE_KEY_FILE, "utf8"), "sk-ant-api03-abc");
    assert.equal(readFileSync(OPENAI_KEY_FILE, "utf8"), "sk-proj-xyz");
  });

  it("refuses an Anthropic key on the OpenAI tab instead of filing it there", () => {
    assert.throws(() => saveProviderKey("openai", "sk-ant-api03-abc"), /Anthropic key.*Claude tab/);
    assert.equal(existsSync(OPENAI_KEY_FILE), false);
  });

  it("refuses a non-Anthropic key on the Claude tab and never reroutes it to OpenAI", () => {
    assert.throws(() => saveProviderKey("claude", "sk-proj-xyz"), /start with sk-ant-/);
    assert.equal(existsSync(CLAUDE_KEY_FILE), false);
    assert.equal(existsSync(OPENAI_KEY_FILE), false);
  });

  it("requires an explicit provider", () => {
    assert.throws(() => saveProviderKey(undefined, "sk-ant-api03-abc"), /Unknown provider/);
    assert.equal(existsSync(CLAUDE_KEY_FILE), false);
  });

  it("keeps the ChatGPT login when a key is saved, so Codex stays on the subscription", () => {
    write(CODEX_AUTH, { auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } });
    saveProviderKey("openai", "sk-proj-xyz");
    assert.equal(existsSync(CODEX_AUTH), true);
    assert.equal(authModeFor("codex"), "subscription");
  });

  it("keeps the Claude login when a key is saved, so Claude stays on the subscription", () => {
    write(CLAUDE_CREDS, { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: LATER } });
    saveProviderKey("claude", "sk-ant-api03-abc");
    assert.equal(existsSync(CLAUDE_CREDS), true);
    assert.equal(authModeFor("claude"), "subscription");
  });
});

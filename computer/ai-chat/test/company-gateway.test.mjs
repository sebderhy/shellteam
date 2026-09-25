/**
 * Company LLM gateway (docs/decisions/20260925-company-llm-gateway.md).
 *
 * Regression: on a corporate VDI whose .env held ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN (the variables Claude Code reads for a gateway), the
 * cockpit showed Claude as "not connected" and hid its models, because only an
 * ANTHROPIC_API_KEY counted. A gateway is now its own auth mode, it wins over
 * any subscription (as it does inside Claude Code), and a gateway URL never
 * reaches a CLI without the gateway's own token.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = mkdtempSync(join(tmpdir(), "company-gateway-test-"));
process.env.HOME = tempHome;
const GATEWAY_VARS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY"];
for (const v of GATEWAY_VARS) delete process.env[v];

const {
  authModeFor,
  clearProviderGateway,
  gatewaySummary,
  getCliEnv,
  recordSubscriptionAuthFailure,
  saveProviderGateway,
  subscriptionStatusFor,
} = await import("../lib/session.mjs");
const { codexProviderOverrides } = await import("../lib/agent-layer.mjs");

const CLAUDE_CREDS = join(tempHome, ".claude", ".credentials.json");
const CODEX_AUTH = join(tempHome, ".codex", "auth.json");
const CLAUDE_GATEWAY_FILE = join(tempHome, ".config", "shellteam", "claude-gateway.json");
const GW = "https://genai.example-corp.com";
const LATER = Date.now() + 3_600_000;

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  for (const dir of [".claude", ".codex", ".config"]) {
    rmSync(join(tempHome, dir), { recursive: true, force: true });
  }
  for (const v of GATEWAY_VARS) delete process.env[v];
});

after(() => rmSync(tempHome, { recursive: true, force: true }));

describe("Claude through a company gateway", () => {
  it("reads the .env gateway as connected and hands the CLI exactly its URL and token", () => {
    process.env.ANTHROPIC_BASE_URL = GW;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-corp-token";
    assert.equal(authModeFor("claude"), "gateway");
    const env = getCliEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, GW);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-corp-token");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(gatewaySummary("claude"), { baseUrl: GW, host: "genai.example-corp.com", source: "env" });
  });

  it("wins over a connected subscription, as it does inside Claude Code", () => {
    write(CLAUDE_CREDS, { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: LATER } });
    process.env.ANTHROPIC_BASE_URL = GW;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-corp-token";
    assert.equal(authModeFor("claude"), "gateway");
  });

  it("ignores a gateway URL with no token and strips it, so a subscription never travels there", () => {
    write(CLAUDE_CREDS, { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: LATER } });
    process.env.ANTHROPIC_BASE_URL = GW;
    assert.equal(authModeFor("claude"), "subscription");
    const env = getCliEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("strips an ambient auth token on a subscription", () => {
    write(CLAUDE_CREDS, { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: LATER } });
    process.env.ANTHROPIC_AUTH_TOKEN = "stale";
    assert.equal(getCliEnv().ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("accepts a gateway that takes its token as an API key", () => {
    process.env.ANTHROPIC_BASE_URL = GW;
    process.env.ANTHROPIC_API_KEY = "corp-key";
    const env = getCliEnv();
    assert.equal(authModeFor("claude"), "gateway");
    assert.equal(env.ANTHROPIC_API_KEY, "corp-key");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("does not mark the subscription expired when the gateway rejects a token", () => {
    write(CLAUDE_CREDS, { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: LATER } });
    process.env.ANTHROPIC_BASE_URL = GW;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-corp-token";
    assert.equal(recordSubscriptionAuthFailure("claude", "Invalid bearer token"), false);
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    assert.equal(subscriptionStatusFor("claude"), "connected");
  });
});

describe("gateway entered in Settings", () => {
  it("is saved owner-only, wins over .env, and is never exposed with its token", () => {
    process.env.ANTHROPIC_BASE_URL = "https://other.example.com";
    process.env.ANTHROPIC_AUTH_TOKEN = "env-token";
    saveProviderGateway("claude", { baseUrl: `${GW}/`, token: " settings-token " });
    assert.equal(statSync(CLAUDE_GATEWAY_FILE).mode & 0o777, 0o600);
    const env = getCliEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, GW);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "settings-token");
    assert.deepEqual(gatewaySummary("claude"), { baseUrl: GW, host: "genai.example-corp.com", source: "settings" });
  });

  it("refuses a token sent in clear text, except to this machine", () => {
    assert.throws(() => saveProviderGateway("claude", { baseUrl: "http://gw.example.com", token: "t" }), /https:\/\//);
    assert.throws(() => saveProviderGateway("claude", { baseUrl: "not a url", token: "t" }), /full URL/);
    assert.throws(() => saveProviderGateway("claude", { baseUrl: GW, token: " " }), /token/);
    assert.equal(existsSync(CLAUDE_GATEWAY_FILE), false);
    saveProviderGateway("claude", { baseUrl: "http://localhost:4000", token: "t" });
    assert.equal(JSON.parse(readFileSync(CLAUDE_GATEWAY_FILE, "utf8")).baseUrl, "http://localhost:4000");
  });

  it("is removed on clear, and the previous login takes over again", () => {
    write(CLAUDE_CREDS, { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: LATER } });
    saveProviderGateway("claude", { baseUrl: GW, token: "t" });
    assert.equal(authModeFor("claude"), "gateway");
    clearProviderGateway("claude");
    assert.equal(authModeFor("claude"), "subscription");
  });
});

describe("Codex through a company gateway", () => {
  it("routes Codex's provider to the gateway URL with the gateway key", () => {
    write(CODEX_AUTH, { auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } });
    process.env.OPENAI_BASE_URL = `${GW}/v1`;
    process.env.OPENAI_API_KEY = "sk-corp";
    assert.equal(authModeFor("codex"), "gateway");
    const env = getCliEnv();
    assert.equal(env.OPENAI_API_KEY, "sk-corp");
    assert.ok(codexProviderOverrides(env).includes(`model_providers.openai-api.base_url="${GW}/v1"`));
  });

  it("keeps the public endpoint and drops a stray base URL when there is no gateway", () => {
    process.env.OPENAI_API_KEY = "sk-proj-own";
    saveProviderGateway("openai", { baseUrl: GW, token: "t" });
    clearProviderGateway("openai");
    const env = getCliEnv();
    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.ok(codexProviderOverrides(env).includes('model_providers.openai-api.base_url="https://api.openai.com/v1"'));
  });
});

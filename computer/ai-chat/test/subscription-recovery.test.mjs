/**
 * Regression coverage for subscription recovery.
 *
 * A provider may leave an OAuth file behind after its refresh credential is no
 * longer usable. That file must not read as "connected", and a configured API
 * key fallback must remain visibly distinct from the expired subscription.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const tempHome = mkdtempSync(join(tmpdir(), "subscription-recovery-test-"));
process.env.HOME = tempHome;
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[key];

const {
  authModeFor,
  getCliEnv,
  hasOAuthCredentials,
  hasCodexOAuthCredentials,
  hasAntigravityOAuthCredentials,
  recordSubscriptionAuthFailure,
  subscriptionStatusFor,
} = await import("../lib/session.mjs");

const CLAUDE_CREDS = join(tempHome, ".claude", ".credentials.json");
const CODEX_AUTH = join(tempHome, ".codex", "auth.json");
const ANTIGRAVITY_AUTH = join(tempHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function jwtWithExpiry(exp) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "none" })}.${segment({ exp })}.fixture`;
}

beforeEach(() => {
  for (const dir of [".claude", ".codex", ".gemini", ".config"]) {
    rmSync(join(tempHome, dir), { recursive: true, force: true });
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

after(() => rmSync(tempHome, { recursive: true, force: true }));

describe("subscriptionStatusFor", () => {
  it("reports the exact Claude blank-token failure as expired and exposes the API fallback", () => {
    write(CLAUDE_CREDS, {
      claudeAiOauth: {
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
        refreshTokenExpiresAt: 1_700_000_000_000,
        subscriptionType: "max",
      },
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-metered-fixture";

    assert.equal(subscriptionStatusFor("claude"), "expired");
    assert.equal(hasOAuthCredentials(), false);
    assert.equal(authModeFor("claude"), "apikey");
    assert.equal(getCliEnv().ANTHROPIC_API_KEY, "sk-ant-metered-fixture");
  });

  it("keeps Claude connected while a usable refresh token can renew an expired access token", () => {
    write(CLAUDE_CREDS, {
      claudeAiOauth: {
        accessToken: "expired-access",
        expiresAt: Date.now() - 60_000,
        refreshToken: "usable-refresh",
        refreshTokenExpiresAt: Date.now() + 86_400_000,
        subscriptionType: "max",
      },
    });
    assert.equal(subscriptionStatusFor("claude"), "connected");
    assert.equal(hasOAuthCredentials(), true);
  });

  it("distinguishes expired ChatGPT OAuth from OpenAI API-key billing", () => {
    write(CODEX_AUTH, { auth_mode: "chatgpt", tokens: null, last_refresh: "2026-07-01T00:00:00Z" });
    process.env.OPENAI_API_KEY = "openai-metered-fixture-not-a-key";

    assert.equal(subscriptionStatusFor("codex"), "expired");
    assert.equal(hasCodexOAuthCredentials(), false);
    assert.equal(authModeFor("codex"), "apikey");
    assert.equal(getCliEnv().OPENAI_API_KEY, "openai-metered-fixture-not-a-key");
  });

  it("marks a server-rejected Codex refresh token until credentials change", () => {
    write(CODEX_AUTH, {
      auth_mode: "chatgpt",
      tokens: { access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) + 3600), refresh_token: "rejected-refresh" },
    });
    process.env.OPENAI_API_KEY = "sk-openai-fallback";
    assert.equal(subscriptionStatusFor("codex"), "connected");

    assert.equal(recordSubscriptionAuthFailure(
      "codex",
      "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
    ), true);
    assert.equal(subscriptionStatusFor("codex"), "expired");
    assert.equal(authModeFor("codex"), "apikey");

    write(CODEX_AUTH, {
      auth_mode: "chatgpt",
      tokens: { access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) + 3600), refresh_token: "fresh-refresh" },
    });
    assert.equal(subscriptionStatusFor("codex"), "connected");
    assert.equal(authModeFor("codex"), "subscription");
  });

  it("reports an expired Google token without treating a partial file as a prior subscription", () => {
    write(ANTIGRAVITY_AUTH, { token: { token_type: "Bearer" } });
    assert.equal(subscriptionStatusFor("antigravity"), "none");

    write(ANTIGRAVITY_AUTH, {
      auth_method: "google_oauth",
      token: { access_token: "expired-google", expiry: new Date(Date.now() - 60_000).toISOString() },
    });
    assert.equal(subscriptionStatusFor("antigravity"), "expired");
    assert.equal(hasAntigravityOAuthCredentials(), false);
    assert.equal(authModeFor("antigravity"), "none");

    write(ANTIGRAVITY_AUTH, {
      auth_method: "google_oauth",
      token: {
        access_token: "expired-google",
        expiry: new Date(Date.now() - 60_000).toISOString(),
        refresh_token: "usable-google-refresh",
      },
    });
    assert.equal(subscriptionStatusFor("antigravity"), "connected");
    assert.equal(hasAntigravityOAuthCredentials(), true);
  });
});

describe("recovery UI contract", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(join(here, "../public/app.js"), "utf8");
  const html = readFileSync(join(here, "../public/index.html"), "utf8");
  const dashboard = readFileSync(join(here, "../../../frontend/dashboard.html"), "utf8");

  it("renders a cockpit alert with a provider-specific Settings action", () => {
    assert.match(html, /id="subscriptionWarning"[^>]*role="alert"/);
    assert.match(app, /kind:\s*'provider-settings'/);
    assert.match(app, /Sub expired · API/);
    assert.match(app, /Reconnect \$\{SUBSCRIPTION_RECOVERY\[family\]\.label\}/);
    assert.match(
      app,
      /function familyHasAuth\(family\)\s*\{[\s\S]*?S\.authMode\?\.\[family\]/,
      "ambient API-key fallback must count as usable auth through authoritative authMode",
    );
  });

  it("keeps reconnect controls visible for Claude, OpenAI, and Google in Settings", () => {
    assert.match(dashboard, /Reconnect Claude subscription/);
    assert.match(dashboard, /Reconnect OpenAI subscription/);
    assert.match(dashboard, /Reconnect Google subscription/);
    assert.match(dashboard, /subscriptionStatus\?\.\[cfg\.family\]/);
    assert.match(dashboard, /kind === 'provider-settings'/);
  });
});

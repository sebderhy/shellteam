/**
 * INCLUDED_MODELS — a box key offered "on us", limited to listed models.
 *
 * The live demo box carries a capped OpenAI key for visitors without a ChatGPT
 * plan. Before this, that key read as plain "apikey": the cockpit skipped the
 * setup screen (so nobody was asked to connect their own plan) and landed on
 * GPT-5.6 Sol, the priciest choice, with every Codex model one click away.
 * With INCLUDED_MODELS=gpt-5.6-terra-max the family bills "included", only the
 * listed models may run, and persisted state naming anything else is coerced.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const tempHome = mkdtempSync(join(tmpdir(), "included-models-test-"));
process.env.HOME = tempHome;
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "INCLUDED_MODELS"]) delete process.env[key];

const { includedModelsByFamily, resetIncludedModelsCache } = await import("../lib/model-catalog.mjs");
const { authModeFor, getCliEnv, loadModel, modelPermitted, permittedModelOr, saveModel } =
  await import("../lib/session.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "public/app.js"), "utf8");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const server = readFileSync(join(root, "server.mjs"), "utf8");
const sessionManager = readFileSync(join(root, "lib/session-manager.mjs"), "utf8");

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

beforeEach(() => {
  for (const dir of [".claude", ".codex", ".gemini", ".config", ".shellteam"]) {
    rmSync(join(tempHome, dir), { recursive: true, force: true });
  }
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.INCLUDED_MODELS;
  resetIncludedModelsCache();
});

after(() => rmSync(tempHome, { recursive: true, force: true }));

describe("includedModelsByFamily", () => {
  it("is empty by default", () => {
    assert.deepEqual(includedModelsByFamily(), {});
  });

  it("groups catalog ids by family and drops unknown ids instead of widening the list", () => {
    process.env.INCLUDED_MODELS = "gpt-5.6-terra-max, claude-haiku-4-5-20251001,gpt-5.7-nope";
    assert.deepEqual(includedModelsByFamily(), {
      codex: ["gpt-5.6-terra-max"],
      claude: ["claude-haiku-4-5-20251001"],
    });
  });
});

describe("authModeFor with an included key", () => {
  it("a key alone bills apikey; the same key with INCLUDED_MODELS bills included", () => {
    process.env.OPENAI_API_KEY = "sk-demo";
    assert.equal(authModeFor("codex"), "apikey");
    process.env.INCLUDED_MODELS = "gpt-5.6-terra-max";
    resetIncludedModelsCache();
    assert.equal(authModeFor("codex"), "included");
  });

  it("INCLUDED_MODELS without a key still reads none, and only affects its own family", () => {
    process.env.INCLUDED_MODELS = "gpt-5.6-terra-max";
    assert.equal(authModeFor("codex"), "none");
    process.env.ANTHROPIC_API_KEY = "sk-ant-demo";
    assert.equal(authModeFor("claude"), "apikey");
  });

  it("the CLI still receives the key in included mode", () => {
    process.env.OPENAI_API_KEY = "sk-demo";
    process.env.INCLUDED_MODELS = "gpt-5.6-terra-max";
    assert.equal(getCliEnv().OPENAI_API_KEY, "sk-demo");
  });
});

describe("modelPermitted", () => {
  it("refuses a non-included model of an included family, with the way out in the reason", () => {
    process.env.OPENAI_API_KEY = "sk-demo";
    process.env.INCLUDED_MODELS = "gpt-5.6-terra-max";
    assert.deepEqual(modelPermitted("gpt-5.6-terra-max"), { ok: true });
    const verdict = modelPermitted("gpt-5.6-sol-max");
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /gpt-5\.6-sol-max is not included/);
    assert.match(verdict.reason, /Connect your own plan/);
    // Other families are untouched.
    assert.deepEqual(modelPermitted("claude-opus-5"), { ok: true });
  });

  it("permits everything when the family is not on an included key", () => {
    process.env.OPENAI_API_KEY = "sk-demo";
    assert.deepEqual(modelPermitted("gpt-5.6-sol-max"), { ok: true });
  });

  it("leaves OpenCode alone: its proxy bills 'included' but is not this allowlist", () => {
    process.env.OPENAI_API_KEY = "sk-demo";
    process.env.INCLUDED_MODELS = "gpt-5.6-terra-max";
    assert.deepEqual(modelPermitted("deepseek-v4-pro"), { ok: true });
    assert.deepEqual(modelPermitted("glm-5p3"), { ok: true });
  });

  it("coerces persisted state that predates INCLUDED_MODELS (golden image saved on Sol)", () => {
    process.env.OPENAI_API_KEY = "sk-demo";
    process.env.INCLUDED_MODELS = "gpt-5.6-terra-max";
    saveModel("gpt-5.6-sol-max");
    assert.equal(loadModel(), "gpt-5.6-terra-max");
    assert.equal(permittedModelOr("gpt-5.6-sol-max", "test"), "gpt-5.6-terra-max");
    assert.equal(permittedModelOr("claude-opus-5", "test"), "claude-opus-5");
  });
});

describe("wiring pins", () => {
  it("every model change is gated server-side (setSlotModel + create_tab) and status carries the list", () => {
    assert.match(sessionManager, /const permitted = modelPermitted\(model\);\s*\n\s*if \(!permitted\.ok\) return \{ error: permitted\.reason \};/);
    assert.match(sessionManager, /permittedModelOr\(resolveModelId\(s\.model\)/);
    assert.match(server, /case "create_tab"[\s\S]*?modelPermitted\(msg\.model\)/);
    assert.match(server, /includedModels: includedModelsByFamily\(\)/);
  });

  it("the cockpit asks for the user's own plan first and lists only included models", () => {
    assert.match(app, /if \(msg\.includedModels\) S\.includedModels = msg\.includedModels;/);
    assert.match(app, /return familyHasAuth\(family\) && modelPermittedHere\(model\);/);
    assert.match(app, /\.filter\(m => modelPermittedHere\(m\.id\)\)/);
    assert.match(app, /return own \|\| !hasIncludedFamily\(\) \|\| includedFallbackChosen\(\);/);
    assert.match(app, /preferredModelFor\('codex', 'gpt-5\.6-sol-max'\)/);
    assert.match(app, /function continueWithIncluded\(model\) \{\s*\n\s*localStorage\.setItem\(INCLUDED_CHOSEN_KEY, '1'\);/);
    assert.match(html, /<div class="setup-included hidden" id="setupIncluded"><\/div>/);
  });
});

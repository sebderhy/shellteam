// THE PURITY CONTRACT (docs/decisions/20260704-purity-gate-modules.md).
//
// The launch-post guarantee: on a pure-core box (MODULES empty — the default),
// a cockpit-spawned agent is bit-identical to one the user runs by hand. This
// test pins the EXACT argv the cockpit/terminal spawn paths produce in core
// mode: the CLI's own flags and nothing else — no --plugin-dir, no
// --mcp-config, no --append-system-prompt-file, no -c overrides.
//
// If you add an unconditional flag to a spawn path, this test goes red — that
// is its job. Gate the flag behind the layer manifest instead.
//
// HOME is read once by lib/constants.mjs at import, so the fake HOME must be
// set before the first import (dynamic import below).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "shellteam-purity-test-"));
process.env.HOME = FAKE_HOME;

const LAYER = join(FAKE_HOME, ".shellteam", "agent-layer");

let terminalSpawn, claudeLayerArgs, codexLayerArgs;

before(async () => {
  // A pure-core layer exactly as api/services/agent_layer.py builds it:
  // manifest with no modules + the provider-only opencode.json. No other
  // artifacts exist.
  mkdirSync(LAYER, { recursive: true });
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: [],
    artifacts: {
      claude_plugin: false, claude_mcp: false, claude_system_prompt: false,
      codex_overrides: false, opencode_config: true,
    },
  }));
  writeFileSync(join(LAYER, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { fireworks: {} },
  }));
  ({ terminalSpawn } = await import("../lib/agents/registry.mjs"));
  ({ claudeLayerArgs, codexLayerArgs } = await import("../lib/agent-layer.mjs"));
});

after(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

test("core: the layer contributes zero flags", () => {
  assert.deepEqual(claudeLayerArgs(), []);
  assert.deepEqual(codexLayerArgs(), []);
});

test("core: managed-terminal claude argv is EXACTLY the bare CLI's", () => {
  assert.deepEqual(terminalSpawn("claude-opus-4-8"), {
    cmd: "claude",
    args: ["--dangerously-skip-permissions", "--model", "claude-opus-4-8"],
  });
  assert.deepEqual(terminalSpawn("claude-opus-4-8", { sessionId: "abc" }), {
    cmd: "claude",
    args: ["--dangerously-skip-permissions", "--model", "claude-opus-4-8", "--resume", "abc"],
  });
});

test("core: managed-terminal codex argv is EXACTLY the bare CLI's", () => {
  assert.deepEqual(terminalSpawn("gpt-5.6-sol"), {
    cmd: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.6-sol"],
  });
});

test("core: no spawn argv references ~/.shellteam", () => {
  for (const model of ["claude-opus-4-8", "gpt-5.6-sol", "gemini-3.1-pro", "kimi-k2p6"]) {
    const { args } = terminalSpawn(model);
    for (const a of args) {
      assert.ok(!String(a).includes(".shellteam"),
        `${model} spawn arg ${a} leaks the layer in core mode`);
    }
  }
});

test("core: opencode config is provider-only (the one documented artifact)", async () => {
  const { opencodeConfigPath } = await import("../lib/agent-layer.mjs");
  const p = opencodeConfigPath();
  assert.ok(p, "opencode provider config must exist even in core");
  const cfg = JSON.parse((await import("node:fs")).readFileSync(p, "utf8"));
  assert.ok(cfg.provider, "provider block present");
  assert.equal(cfg.mcp, undefined, "no MCP in core");
  assert.equal(cfg.skills, undefined, "no skills in core");
  assert.equal(cfg.instructions, undefined, "no instructions in core");
});

test("core: cockpit boot never writes user dotfiles (~/.claude.json)", async () => {
  // Found by fresh-box QA (2026-07-05): server.mjs called
  // ensureOnboardingComplete() at module scope, creating ~/.claude.json on
  // every service start — a violation of the additive-layer rule
  // (docs/FOOTPRINT.md) even in pure core. The flag may only be written inside
  // the user-initiated OAuth login (session.mjs), where creating the user's
  // Claude config is the requested outcome.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    fileURLToPath(new URL("../server.mjs", import.meta.url)), "utf8");
  assert.ok(!src.includes("ensureOnboardingComplete"),
    "server.mjs must not touch ~/.claude.json — boot is dotfile-write-free");
});

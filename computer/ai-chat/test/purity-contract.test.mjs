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
  // manifest with no modules + Pi's provider-only layer. No other artifacts
  // exist.
  mkdirSync(LAYER, { recursive: true });
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: [],
    artifacts: {
      claude_plugin: false, claude_mcp: false, claude_system_prompt: false,
      codex_overrides: false, pi_layer: true,
    },
  }));
  mkdirSync(join(LAYER, "pi"), { recursive: true });
  writeFileSync(join(LAYER, "pi", "shellteam.ts"), "// extension");
  writeFileSync(join(LAYER, "pi", "layer.json"), JSON.stringify({ provider: {}, mcpServers: {} }));
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
  assert.deepEqual(terminalSpawn("claude-opus-5"), {
    cmd: "claude",
    args: ["--dangerously-skip-permissions", "--model", "claude-opus-5"],
  });
  assert.deepEqual(terminalSpawn("claude-opus-5", { sessionId: "abc" }), {
    cmd: "claude",
    args: ["--dangerously-skip-permissions", "--model", "claude-opus-5", "--resume", "abc"],
  });
});

test("core: managed-terminal codex argv is EXACTLY the bare CLI's", () => {
  assert.deepEqual(terminalSpawn("gpt-5.6-sol"), {
    cmd: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.6-sol"],
  });
});

test("core: no spawn argv references ~/.shellteam", () => {
  for (const model of ["claude-opus-5", "gpt-5.6-sol", "gemini-4-argon-high"]) {
    const { args } = terminalSpawn(model);
    for (const a of args) {
      assert.ok(!String(a).includes(".shellteam"),
        `${model} spawn arg ${a} leaks the layer in core mode`);
    }
  }
});

test("core: Pi gets its provider extension and nothing else (the one documented artifact)", async () => {
  const { piLayer } = await import("../lib/agent-layer.mjs");
  const { args, env } = piLayer();
  assert.deepEqual(args, ["-e", join(LAYER, "pi", "shellteam.ts")], "no prompt, no skills in core");
  const layer = JSON.parse((await import("node:fs")).readFileSync(env.SHELLTEAM_PI_LAYER, "utf8"));
  assert.ok(layer.provider, "provider present");
  assert.deepEqual(layer.mcpServers, {}, "no MCP in core");
  const terminal = terminalSpawn("kimi-k3p1-pro").args.filter((a) => String(a).includes(".shellteam"));
  assert.deepEqual(terminal, [join(LAYER, "pi", "shellteam.ts")], "the terminal adds the extension only");
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

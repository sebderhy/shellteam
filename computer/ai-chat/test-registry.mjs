import { describe, it, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic HOME: constants.mjs captures process.env.HOME at import time, and
// the agent layer discovers ~/.shellteam/agent-layer through it — on an
// operator's machine the results would depend on their real installed layer.
// Point HOME at an empty temp dir BEFORE the modules load (dynamic import),
// so this file passes identically on a dev box and in clean CI.
const REAL_HOME = process.env.HOME;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "st-registry-test-"));
process.env.HOME = FAKE_HOME;
const { pickAgent, supports, terminalSpawn } = await import("./lib/agents/registry.mjs");
const { claudeLayerArgs, codexLayerArgs } = await import("./lib/agent-layer.mjs");
after(() => {
  process.env.HOME = REAL_HOME;
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("agent registry — hermeticity", () => {
  it("contributes zero layer flags in a clean HOME (no installed agent layer)", () => {
    assert.deepEqual(claudeLayerArgs(), []);
    assert.deepEqual(codexLayerArgs(), []);
  });
});

describe("agent registry — model routing", () => {
  it("routes Claude model families", () => {
    assert.equal(pickAgent("claude-opus-5").id, "claude");
    assert.equal(pickAgent("claude-sonnet-5-5").id, "claude");
    assert.equal(pickAgent("claude-haiku-5-5").id, "claude");
    assert.equal(pickAgent("sonnet-test").id, "claude");
    assert.equal(pickAgent("opus-test").id, "claude");
    assert.equal(pickAgent("haiku-test").id, "claude");
  });

  it("routes Codex model families", () => {
    assert.equal(pickAgent("gpt-6-astra-max").id, "codex");
    assert.equal(pickAgent("gpt-6.1-sol-ultra").id, "codex");
    assert.equal(pickAgent("gpt-6.1-sol-max").id, "codex");
    assert.equal(pickAgent("gpt-6-luna-max").id, "codex");
    assert.equal(pickAgent("o1-preview").id, "codex");
    assert.equal(pickAgent("o3-mini").id, "codex");
    assert.equal(pickAgent("o4-mini").id, "codex");
    assert.equal(pickAgent("codex-mini").id, "codex");
  });

  it("routes Antigravity/Gemini model families", () => {
    assert.equal(pickAgent("gemini-4-argon-high").id, "antigravity");
    assert.equal(pickAgent("gemini-3.8-flash-medium").id, "antigravity");
  });

  it("routes Pi (Fireworks) model families", () => {
    assert.equal(pickAgent("glm-5p3").id, "pi");       // catalog default
    assert.equal(pickAgent("kimi-k3p1-pro").id, "pi");
    assert.equal(pickAgent("kimi-k3").id, "pi");                // a retired id still routes to Pi
    assert.equal(pickAgent("deepseek-v4-pro").id, "pi");
    assert.equal(pickAgent("kimi-k2p7-code").id, "pi"); // prefix routing (not in catalog list)
    assert.equal(pickAgent("kimi-future-model").id, "pi");
    assert.equal(pickAgent("deepseek-v4-pro").id, "pi");
    assert.equal(pickAgent("qwen3p7-plus").id, "pi");   // prefix routing
  });

  it("falls back to Claude for unknown models", () => {
    assert.equal(pickAgent("unknown-model").id, "claude");
    assert.equal(pickAgent(null).id, "claude");
    assert.equal(pickAgent(undefined).id, "claude");
  });
});

describe("agent registry — capabilities", () => {
  it("exposes rewind/resume/cliOwnsHistory per agent", () => {
    assert.equal(supports("claude-opus-5", "rewind"), true);
    assert.equal(supports("claude-opus-5", "cliOwnsHistory"), true);

    assert.equal(supports("gpt-5.5", "rewind"), false);
    assert.equal(supports("gpt-5.5", "resume"), true);
    assert.equal(supports("gpt-5.5", "cliOwnsHistory"), false);

    assert.equal(supports("gemini-4-argon-high", "resume"), true);

    assert.equal(supports("kimi-k3p1-pro", "rewind"), false);
    assert.equal(supports("kimi-k3p1-pro", "resume"), true);
    assert.equal(supports("kimi-k3p1-pro", "cliOwnsHistory"), false);
  });

  it("returns false for unknown capabilities", () => {
    assert.equal(supports("claude-opus-5", "teleportation"), false);
  });
});

describe("agent registry — terminal spawn", () => {
  it("builds the expected command + args per agent", () => {
    assert.deepEqual(
      terminalSpawn("claude-opus-5"),
      { cmd: "claude", args: ["--dangerously-skip-permissions", "--model", "claude-opus-5", ...claudeLayerArgs()] },
    );
    assert.deepEqual(
      terminalSpawn("claude-opus-5", { sessionId: "abc" }),
      { cmd: "claude", args: ["--dangerously-skip-permissions", "--model", "claude-opus-5", ...claudeLayerArgs(), "--resume", "abc"] },
    );
    assert.deepEqual(
      terminalSpawn("gpt-6-astra-max"),
      { cmd: "codex", args: ["--dangerously-bypass-approvals-and-sandbox", ...codexLayerArgs(), "-c", 'model_reasoning_effort="max"', "-m", "gpt-6-astra"] },
    );
    assert.deepEqual(
      terminalSpawn("gpt-6.1-sol-ultra"),
      { cmd: "codex", args: ["--dangerously-bypass-approvals-and-sandbox", ...codexLayerArgs(), "-c", 'model_reasoning_effort="ultra"', "-m", "gpt-6.1-sol"] },
    );
    assert.deepEqual(
      terminalSpawn("gpt-6-luna-max"),
      { cmd: "codex", args: ["--dangerously-bypass-approvals-and-sandbox", ...codexLayerArgs(), "-c", 'model_reasoning_effort="max"', "-m", "gpt-6-luna"] },
    );
    assert.deepEqual(
      terminalSpawn("gemini-4-argon-high", { sessionId: "xyz" }),
      { cmd: "agy", args: ["--dangerously-skip-permissions", "--model", "gemini-4-argon-high", "--conversation", "xyz"] },
    );
    const fresh = terminalSpawn("kimi-k3p1-pro");
    assert.equal(fresh.cmd, "pi");
    assert.deepEqual(fresh.args.slice(0, 6), ["--provider", "shellteam", "--model", "accounts/fireworks/models/kimi-k3p1-pro", "--thinking", "max"]);
    assert.match(fresh.args.at(-1), /^pi-[0-9a-f-]{36}$/, "a new terminal session gets a cockpit Pi id");
    assert.deepEqual(terminalSpawn("kimi-k3p1-pro", { sessionId: "pi-1" }).args.slice(-2), ["--session-id", "pi-1"]);
  });
});

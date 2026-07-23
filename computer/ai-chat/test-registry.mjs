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
    assert.equal(pickAgent("claude-opus-4-8").id, "claude");
    assert.equal(pickAgent("claude-sonnet-5").id, "claude");
    assert.equal(pickAgent("claude-haiku-4-5-20251001").id, "claude");
    assert.equal(pickAgent("sonnet-test").id, "claude");
    assert.equal(pickAgent("opus-test").id, "claude");
    assert.equal(pickAgent("haiku-test").id, "claude");
  });

  it("routes Codex model families", () => {
    assert.equal(pickAgent("gpt-5.6-sol-ultra").id, "codex");
    assert.equal(pickAgent("gpt-5.6-sol-max").id, "codex");
    assert.equal(pickAgent("gpt-5.6-terra-max").id, "codex");
    assert.equal(pickAgent("gpt-5.6-luna-max").id, "codex");
    assert.equal(pickAgent("o1-preview").id, "codex");
    assert.equal(pickAgent("o3-mini").id, "codex");
    assert.equal(pickAgent("o4-mini").id, "codex");
    assert.equal(pickAgent("codex-mini").id, "codex");
  });

  it("routes Antigravity/Gemini model families", () => {
    assert.equal(pickAgent("gemini-3.1-pro").id, "antigravity");
    assert.equal(pickAgent("gemini-3.6-flash").id, "antigravity");
  });

  it("routes OpenCode (Fireworks) model families", () => {
    assert.equal(pickAgent("glm-5p2").id, "opencode");       // catalog default
    assert.equal(pickAgent("glm-5p1").id, "opencode");
    assert.equal(pickAgent("kimi-k2p6").id, "opencode");
    assert.equal(pickAgent("kimi-k2p7-code").id, "opencode"); // prefix routing (not in catalog list)
    assert.equal(pickAgent("kimi-future-model").id, "opencode");
    assert.equal(pickAgent("deepseek-v4-pro").id, "opencode");
    assert.equal(pickAgent("qwen3p7-plus").id, "opencode");   // prefix routing
  });

  it("falls back to Claude for unknown models", () => {
    assert.equal(pickAgent("unknown-model").id, "claude");
    assert.equal(pickAgent(null).id, "claude");
    assert.equal(pickAgent(undefined).id, "claude");
  });
});

describe("agent registry — capabilities", () => {
  it("exposes rewind/resume/cliOwnsHistory per agent", () => {
    assert.equal(supports("claude-opus-4-8", "rewind"), true);
    assert.equal(supports("claude-opus-4-8", "cliOwnsHistory"), true);

    assert.equal(supports("gpt-5.5", "rewind"), false);
    assert.equal(supports("gpt-5.5", "resume"), true);
    assert.equal(supports("gpt-5.5", "cliOwnsHistory"), false);

    assert.equal(supports("gemini-3.1-pro", "resume"), true);

    assert.equal(supports("kimi-k2p6", "rewind"), false);
    assert.equal(supports("kimi-k2p6", "resume"), true);
    assert.equal(supports("kimi-k2p6", "cliOwnsHistory"), false);
  });

  it("returns false for unknown capabilities", () => {
    assert.equal(supports("claude-opus-4-8", "teleportation"), false);
  });
});

describe("agent registry — terminal spawn", () => {
  it("builds the expected command + args per agent", () => {
    assert.deepEqual(
      terminalSpawn("claude-opus-4-8"),
      { cmd: "claude", args: ["--dangerously-skip-permissions", "--model", "claude-opus-4-8", ...claudeLayerArgs()] },
    );
    assert.deepEqual(
      terminalSpawn("claude-opus-4-8", { sessionId: "abc" }),
      { cmd: "claude", args: ["--dangerously-skip-permissions", "--model", "claude-opus-4-8", ...claudeLayerArgs(), "--resume", "abc"] },
    );
    assert.deepEqual(
      terminalSpawn("gpt-5.6-sol-ultra"),
      { cmd: "codex", args: ["--dangerously-bypass-approvals-and-sandbox", ...codexLayerArgs(), "-c", 'model_reasoning_effort="ultra"', "-m", "gpt-5.6-sol"] },
    );
    assert.deepEqual(
      terminalSpawn("gpt-5.6-terra-max"),
      { cmd: "codex", args: ["--dangerously-bypass-approvals-and-sandbox", ...codexLayerArgs(), "-c", 'model_reasoning_effort="max"', "-m", "gpt-5.6-terra"] },
    );
    assert.deepEqual(
      terminalSpawn("gemini-3.1-pro", { sessionId: "xyz" }),
      { cmd: "agy", args: ["--dangerously-skip-permissions", "--model", "Gemini 3.1 Pro (High)", "--conversation", "xyz"] },
    );
    assert.deepEqual(
      terminalSpawn("kimi-k2p6"),
      { cmd: "opencode", args: ["--model", "fireworks/kimi-k2p6"] },
    );
    assert.deepEqual(
      terminalSpawn("kimi-k2p6", { sessionId: "s-1" }),
      { cmd: "opencode", args: ["--session", "s-1", "--model", "fireworks/kimi-k2p6"] },
    );
  });
});

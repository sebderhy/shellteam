import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgent, parseRolloutTokenInfo } from "../lib/codex-agent.mjs";
import { CodingAgent } from "../lib/coding-agent.mjs";

// --- SHE-68: the context meter must read per-call occupancy, not turn sums ---

// A rollout tail as Codex 0.144.x writes it: one token_count per API call.
// total_token_usage is thread-cumulative (what turn.completed.usage mirrors);
// last_token_usage is the final call's real context occupancy.
const ROLLOUT_TAIL = [
  JSON.stringify({ timestamp: "t1", type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 13218, cached_input_tokens: 8960, output_tokens: 5, total_tokens: 13223 },
    last_token_usage: { input_tokens: 13218, cached_input_tokens: 8960, output_tokens: 5, total_tokens: 13223 },
    model_context_window: 258400 } } }),
  JSON.stringify({ timestamp: "t2", type: "event_msg", payload: { type: "response_item", payload: {} } }),
  JSON.stringify({ timestamp: "t3", type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 39906, cached_input_tokens: 35072, output_tokens: 154, total_tokens: 40060 },
    last_token_usage: { input_tokens: 13434, cached_input_tokens: 13056, output_tokens: 24, total_tokens: 13458 },
    model_context_window: 258400 } } }),
].join("\n");

test("parseRolloutTokenInfo returns the LAST token_count info", () => {
  const info = parseRolloutTokenInfo(ROLLOUT_TAIL);
  assert.equal(info.last_token_usage.total_tokens, 13458);
  assert.equal(info.total_token_usage.total_tokens, 40060);
  assert.equal(info.model_context_window, 258400);
});

test("parseRolloutTokenInfo survives a tail cut mid-JSON-line", () => {
  const cut = ROLLOUT_TAIL.slice(40); // first line truncated mid-object
  const info = parseRolloutTokenInfo(cut);
  assert.equal(info.last_token_usage.total_tokens, 13458);
});

test("parseRolloutTokenInfo returns null when no token_count present", () => {
  assert.equal(parseRolloutTokenInfo('{"type":"event_msg","payload":{"type":"user_message"}}'), null);
  assert.equal(parseRolloutTokenInfo(""), null);
});

// End-to-end through the agent: a turn.completed whose usage is the inflated
// turn-cumulative sum must emit the rollout's last-call occupancy instead
// (SHE-68 read "42069k · 100%" from exactly this inflation).
test("turn_done carries rollout occupancy + operative window, not the turn sum", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const threadId = "0197-test-thread";
  const day = join(home, ".codex-test", "sessions", "2026", "07", "13");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-07-13T00-00-00-${threadId}.jsonl`), ROLLOUT_TAIL + "\n");

  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: home, env: { CODEX_HOME: join(home, ".codex-test") } });
  agent._threadId = threadId;
  const done = [];
  agent.on("turn_done", (d) => done.push(d));
  agent._translate({ type: "turn.completed", usage: { input_tokens: 42_069_000, cached_input_tokens: 41_000_000, output_tokens: 154 } });

  assert.equal(done.length, 1);
  assert.equal(done[0].usage.input_tokens, 13458, "must be last_token_usage.total_tokens, not the 42M sum");
  assert.equal(done[0].context_window, 258400, "must surface Codex's operative window");
  rmSync(home, { recursive: true, force: true });
});

// SHE-66: with the window observed at 258400, the next spawn's auto-compact
// limit must sit BELOW it (0.8 × 258400), not at the catalog-derived 320k that
// exceeded the operative window and thus never fired.
test("observed context window drives the auto-compact limit below the real wall", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent._contextWindow = 258400;
  assert.equal(agent._observedContextWindow(), 258400);
  const limit = Math.floor(agent._observedContextWindow() * 0.8);
  assert.ok(limit < 258400, "limit must leave headroom below the operative window");
  assert.equal(limit, 206720);
});

// --- SHE-66: context-overflow auto-recovery state machine ---

test("overflow turn.failed schedules compact+retry instead of erroring", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent._lastPrompt = "continue the review";
  const done = [], errors = [];
  agent.on("turn_done", (d) => done.push(d));
  agent.on("error", (e) => errors.push(e));

  agent._translate({ type: "turn.failed", error: { message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying." } });

  assert.equal(done.length, 0, "no error turn_done while recovery is in flight");
  assert.equal(agent._recovery?.phase, "compact-pending");
  assert.equal(agent._recovery?.prompt, "continue the review");
  assert.equal(errors.length, 1, "the user must be told a recovery is happening");
  assert.match(errors[0].message, /compacting.*retrying/i);
});

test("overflow recovery runs at most once per user message", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent._lastPrompt = "go";
  agent._recoveryUsed = true; // already recovered once for this message
  const done = [];
  agent.on("turn_done", (d) => done.push(d));
  agent._translate({ type: "turn.failed", error: { message: "Codex ran out of room in the model's context window." } });
  assert.equal(done.length, 1, "second overflow must surface as a real error");
  assert.equal(done[0].is_error, true);
});

test("a failed recovery compaction gives up loudly", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent._recovery = { prompt: "go", phase: "compacting" };
  agent._compactTurn = true;
  const done = [];
  agent.on("turn_done", (d) => done.push(d));
  agent._translate({ type: "turn.failed", error: { message: "Codex ran out of room in the model's context window." } });
  assert.equal(done.length, 1);
  assert.equal(done[0].is_error, true);
  assert.equal(agent._recovery, null);
});

test("non-overflow failures still error immediately", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent._lastPrompt = "go";
  const done = [];
  agent.on("turn_done", (d) => done.push(d));
  agent._translate({ type: "turn.failed", error: { message: "stream disconnected" } });
  assert.equal(done.length, 1);
  assert.equal(done[0].is_error, true);
  assert.equal(agent._recovery, null);
});

// --- SHE-67: the prompt must travel over stdin, never argv ---
// A prompt starting with "- " (any bullet list) parsed as a CLI flag: clap
// died with `unexpected argument '- ' found`, exit code=2, on every retry.

test("codex is spawned with the '-' stdin sentinel and receives the prompt on stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-fake-"));
  // Fake `codex` binary: records argv + stdin raw, emits a minimal exec stream.
  writeFileSync(join(dir, "codex"), `#!/usr/bin/env bash
printf '%s' "$*" > ${join(dir, "argv.txt")}
cat > ${join(dir, "stdin.txt")}
echo '{"type":"thread.started","thread_id":"t-1"}'
echo '{"type":"turn.completed","usage":{"input_tokens":10}}'
`);
  chmodSync(join(dir, "codex"), 0o755);

  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, CODEX_HOME: dir } });
  agent.start();
  const turnDone = new Promise((resolve) => agent.on("turn_done", resolve));
  agent.sendMessage("- Remove the dev->main PR for now.");
  await turnDone;

  const { readFileSync } = await import("node:fs");
  const argv = readFileSync(join(dir, "argv.txt"), "utf8");
  const stdin = readFileSync(join(dir, "stdin.txt"), "utf8");
  assert.ok(argv.trim().endsWith(" -"), `argv must end with the stdin sentinel, got: ${argv}`);
  assert.ok(!argv.includes("Remove the dev->main"), "the prompt must not appear in argv");
  assert.equal(stdin, "- Remove the dev->main PR for now.");
  rmSync(dir, { recursive: true, force: true });
});

// --- SHE-69: SIGTERM-trapping CLIs exit 143/signal=null — not an error ---

test("_exitSignal normalizes 143→SIGTERM and 130→SIGINT", () => {
  const a = new (class extends CodingAgent { start() {} sendMessage() {} interrupt() {} stop() {} })({ model: "m" });
  assert.equal(a._exitSignal(143, null), "SIGTERM");
  assert.equal(a._exitSignal(130, null), "SIGINT");
  assert.equal(a._exitSignal(0, null), null);
  assert.equal(a._exitSignal(2, null), null);
  assert.equal(a._exitSignal(143, "SIGTERM"), "SIGTERM");
});

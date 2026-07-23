// SHE-48 regression (Codex path): the context meter must never show the
// PRE-compaction context as the post-compaction occupancy.
//
// Observed live on 2026-07-20: a /compact on a gpt-5.6-sol tab left the meter
// reading "271k · 100%" on a 258400-token window. The numbers below are the
// real ones from that rollout — the compaction's own API call carries the whole
// conversation it is summarizing (270907 tokens), the context it produces is
// ~5k, and the client had already cleared the meter on the `compacted` event
// before turn_done re-poisoned it.
//
// Run: node --test computer/ai-chat/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgent, parseRolloutTokenInfo } from "../lib/codex-agent.mjs";

const tokenCount = (total) => JSON.stringify({
  timestamp: "t", type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { total_tokens: total },
    last_token_usage: { total_tokens: total },
    model_context_window: 258400 } },
});
const COMPACTED = JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "context_compacted" } });

test("counts recorded before a compaction are discarded", () => {
  // The exact sequence from the live rollout: the summarization call (270907),
  // the resulting context (4908), then the marker.
  const info = parseRolloutTokenInfo([tokenCount(270907), tokenCount(4908), COMPACTED].join("\n"));
  assert.equal(info, null, "nothing survives the compaction marker — 4908 predates it too");
});

test("a count recorded AFTER the compaction is the new occupancy", () => {
  const info = parseRolloutTokenInfo([tokenCount(270907), COMPACTED, tokenCount(27653)].join("\n"));
  assert.equal(info.last_token_usage.total_tokens, 27653);
  assert.equal(info.model_context_window, 258400);
});

test("the compaction marker invalidates even when its line is cut mid-JSON", () => {
  // The 128KB tail can start mid-line; matching the raw line (not the parsed
  // payload) is what keeps a pre-compaction count from surviving.
  const tail = [tokenCount(270907), COMPACTED.slice(0, 60), tokenCount(27653)].join("\n");
  assert.equal(parseRolloutTokenInfo(tail).last_token_usage.total_tokens, 27653);
});

test("only the LAST compaction resets — an older one does not hide current counts", () => {
  const tail = [COMPACTED, tokenCount(27653), tokenCount(31200)].join("\n");
  assert.equal(parseRolloutTokenInfo(tail).last_token_usage.total_tokens, 31200);
});

// The end-to-end shape of the bug: turn.completed for the compaction turn wins
// the race against the rollout flush, so there is no post-compaction count yet.
// Falling back to `event.usage` there reports the summarization call's own
// usage — the pre-compaction peak — as the new occupancy.
function agentWithRollout(tailLines) {
  const home = mkdtempSync(join(tmpdir(), "codex-compact-"));
  const threadId = "0197-compact-thread";
  const day = join(home, ".codex-test", "sessions", "2026", "07", "20");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-07-20T14-49-35-${threadId}.jsonl`), tailLines.join("\n") + "\n");
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: home, env: { CODEX_HOME: join(home, ".codex-test") } });
  agent._threadId = threadId;
  return { agent, home };
}

test("a compact turn whose post-compaction count has not flushed reports NO usage", () => {
  const { agent, home } = agentWithRollout([tokenCount(270907), COMPACTED]);
  agent._compactTurn = true;
  const done = [];
  agent.on("turn_done", (d) => done.push(d));
  // `usage` here is the summarization call's own — the pre-compaction context.
  agent._translate({ type: "turn.completed", usage: { input_tokens: 270907 } });

  assert.equal(done.length, 1);
  assert.equal(done[0].usage, undefined,
    "reporting any usage here repaints the meter with the pre-compaction peak (271k · 100%)");
  rmSync(home, { recursive: true, force: true });
});

test("once the post-compaction count lands, the meter gets the real occupancy", () => {
  const { agent, home } = agentWithRollout([tokenCount(270907), COMPACTED, tokenCount(4908)]);
  agent._compactTurn = true;
  const done = [];
  agent.on("turn_done", (d) => done.push(d));
  agent._translate({ type: "turn.completed", usage: { input_tokens: 270907 } });

  assert.equal(done[0].usage.input_tokens, 4908);
  assert.equal(done[0].context_window, 258400);
  rmSync(home, { recursive: true, force: true });
});

test("a normal turn still falls back to event.usage when the rollout is unreadable", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: { CODEX_HOME: join(tmpdir(), "nope-does-not-exist") } });
  agent._threadId = "missing-thread";
  const done = [];
  agent.on("turn_done", (d) => done.push(d));
  agent._translate({ type: "turn.completed", usage: { input_tokens: 12345 } });
  assert.equal(done[0].usage.input_tokens, 12345, "non-compact turns keep the existing fallback");
});

// A resume can hand back a NEW thread id with its own rollout file. The cached
// path belongs to the old thread; keeping it reads an abandoned conversation's
// token counts (observed on this box: two live thread ids, 19k tokens apart).
test("thread.started with a new id drops the cached rollout path", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent._threadId = "old-thread";
  agent._rolloutFile = "/tmp/rollout-old-thread.jsonl";
  agent._translate({ type: "thread.started", thread_id: "new-thread" });
  assert.equal(agent._rolloutFile, null, "stale rollout path must not outlive its thread");
  assert.equal(agent._threadId, "new-thread");
});

test("thread.started for the SAME id keeps the cached path", () => {
  const agent = new CodexAgent({ model: "gpt-5.6-sol", cwd: tmpdir(), env: {} });
  agent._threadId = "same-thread";
  agent._rolloutFile = "/tmp/rollout-same-thread.jsonl";
  agent._translate({ type: "thread.started", thread_id: "same-thread" });
  assert.equal(agent._rolloutFile, "/tmp/rollout-same-thread.jsonl");
});

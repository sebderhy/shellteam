# Codex proactive auto-compaction

- **Date:** 2026-07-10
- **Status:** Accepted
- **Area:** cockpit / coding-agent harness (`computer/ai-chat/lib/codex-agent.mjs`)

## Context

A Codex session in the cockpit hit the model's context window mid-work and
became unrecoverable:

> Codex ran out of room in the model's context window. Start a new thread or
> clear earlier history before retrying.

The turn had been running collectors plus the full test suites — large tool
outputs — and blew past the 400k window in a single turn. Once the wall is hit,
even `/compact` fails: compaction is itself a model call that needs headroom to
summarize, and there is none left. The user is stranded with a live session they
cannot continue (the working-tree changes survive, but the conversation is
dead).

Codex *does* have native auto-compaction, gated on the config key
`model_auto_compact_token_limit` (verified present in the codex-cli 0.144.1
binary's config schema). When accumulated context crosses that limit at a turn
boundary, Codex summarizes and continues in place. But by default the limit sits
near Codex's own ceiling, so:

1. it leaves almost no headroom, and
2. a single heavy turn can push past the *actual* window before the next
   boundary-triggered compaction ever fires.

The cockpit previously set this key **only** on a manual `/compact`
(`model_auto_compact_token_limit=1`, forcing immediate compaction). Normal turns
set nothing and rode Codex's default straight into the wall.

## Decision

On every **normal** Codex turn, pin
`model_auto_compact_token_limit` to **80% of the model's real context window**
(`limit.context` from `config/models.json`, the same source the browser context
meter reads). For a 400k Codex window that is 320k, leaving ~80k of headroom for
the next turn's work before the hard ceiling.

- Lower limit = compact sooner. The manual `/compact` path still forces the
  extreme (`=1`); this change only affects the default per-turn behavior.
- The threshold is derived, not hardcoded per model: a new
  `contextLimitForId()` in `model-catalog.mjs` mirrors the frontend's
  `contextWindowForModel` (200k default, 1M for `[1m]` variants), and
  `autoCompactLimitForModel()` in `codex-agent.mjs` applies the 0.8 fraction.

This reuses Codex's own native compaction rather than parsing token-usage events
and orchestrating compaction ourselves — DRY, no fragile cross-turn state.

## Reasoning / evidence (as of 2026-07-10)

- `model_auto_compact_token_limit` confirmed as a real key in the codex-cli
  0.144.1 binary (`strings` over the native executable's config schema,
  alongside `model_context_window` and `tool_output_token_limit`).
- The existing manual `/compact` already proves the key is honored end-to-end in
  production.
- 0.8 gives a meaningful margin (80k on a 400k window) without compacting so
  aggressively that ordinary sessions churn summaries.

## What would make us revisit

- If a single turn's tool output still exceeds the 80k headroom and blows the
  window mid-turn, the complementary fix is Codex's `tool_output_token_limit`
  (cap per-tool output) — a separate lever, out of scope here.
- If Codex changes the semantics or name of `model_auto_compact_token_limit`
  (watch on CLI upgrades; `--strict-config` would surface a rename as an error).
- If 0.8 proves too eager/too lax in practice, tune `AUTO_COMPACT_FRACTION`.

## Consequences

- Codex sessions compact early and keep going instead of dying at the wall.
- No behavior change for Claude/Gemini/OpenCode (Claude Code already
  auto-compacts natively).
- New unit tests: `computer/ai-chat/test/codex-autocompact.test.mjs`.

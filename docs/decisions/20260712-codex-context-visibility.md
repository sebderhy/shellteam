# Codex context visibility & crash legibility (SHE-66, SHE-67)

- **Date:** 2026-07-12
- **Status:** Accepted
- **Area:** cockpit / coding-agent harness (`computer/ai-chat/lib/codex-agent.mjs`,
  `lib/model-catalog.mjs`, `public/app.js`)

## Context

Two Codex bugs filed the same day, both around the context window:

- **SHE-66** — the Info menu showed *"Context: not reported by this agent yet"*
  for Codex, and the session then *"suddenly fails instead of auto-compacting."*
- **SHE-67** — a Codex turn died with a cryptic *"process exited code=2
  signal=null"* (the user retried, so the failing message appears twice).

The auto-compaction half of SHE-66 (and the underlying crash in SHE-67) is
handled by [20260710-codex-proactive-auto-compaction.md](20260710-codex-proactive-auto-compaction.md).
This doc covers the two remaining, distinct defects: **context never being
reported**, and the **illegible crash message**.

### Why the meter was blank

The cockpit context meter (`updateContextMeter` in `public/app.js`) reads
`usage` off the `turn_done` message. Codex's `turn.completed` event *does* carry
usage —
`{"input_tokens":19259,"cached_input_tokens":9984,"output_tokens":…}` — but the
adapter dropped it, emitting a bare `turn_done {}`. So Codex slots never fed the
meter, unlike Claude (which forwards its per-call `usage`).

### Why the denominator would also have been wrong

Codex catalog ids are the reasoning-tier variants (`gpt-5.6-sol-max`, …, 400k
window); their `cli` value is the bare `gpt-5.6-sol`. A slot persisted with the
bare id (a stale saved tab, or the display we saw in the SHE-66 screenshot)
matched no catalog id, so both the frontend meter window and the backend
auto-compact threshold silently fell back to 200k — halving the meter's
denominator and compacting at 160k instead of 320k.

### Why the crash was illegible

Codex can exit non-zero **without** emitting a `turn.failed`/`error` JSON event
— it prints the reason (e.g. "ran out of room in the model's context window") to
stderr and dies. The adapter's synthetic `turn_done` reported only
`Process exited code=${code} signal=${signal}`, discarding the stderr that
explained *why*.

## Decision

1. **Forward Codex usage.** `codexUsage()` maps `turn.completed.usage` to the
   meter's shape. Codex's `input_tokens` already **includes** the cached prefix
   (unlike Claude, where `input_tokens` and `cache_read` are disjoint), so we
   forward `input_tokens` **alone** and leave the cache fields unset — summing
   `cached_input_tokens` on top would double-count. Emitted on `turn.completed`.

2. **Resolve stale/cli-form model ids by `cli` value.** `contextLimitForId`
   (backend) and `contextWindowForModel` (frontend) now match a catalog model by
   `id` **or** `cli`, so `gpt-5.6-sol` resolves to the real 400k window. Scoped
   deliberately to the two window resolvers: `cliModelForId`/`configArgsForId`
   are **not** broadened, because a cli-value match there could pick the wrong
   reasoning-tier variant's `-c` config (e.g. apply `ultra` to a plain `sol`).

3. **Surface the real crash reason.** `_exitErrorMessage()` prefers the tail of
   Codex's stderr over the bare `code=…` string; when stderr is empty it returns
   a plain-language message that points at the likely cause (context window) and
   the recovery (new chat / `/compact`).

## Reasoning / evidence (as of 2026-07-12)

- Real `turn.completed` usage shape captured from codex-cli 0.144.1
  (`{"input_tokens":14394,"cached_input_tokens":9984,…}`) — `input_tokens` is the
  whole prompt, so it is the current occupancy.
- End-to-end verified by driving the real `CodexAgent` through a live turn: it
  now emits `turn_done {usage:{input_tokens:19259}}`, and a stale `gpt-5.6-sol`
  slot spawns with `model_auto_compact_token_limit=320000` (was 160000).

## What would make us revisit

- If Codex renames/reshapes `turn.completed.usage` (watch on CLI upgrades).
- If two catalog models ever share a `cli` value **and** differ in
  `limit.context`, the by-cli match becomes ambiguous — today all variants of a
  cli share one window, so it is safe.

## Consequences

- Codex slots report live context occupancy against the correct window.
- Codex crashes show the real reason instead of `code=2 signal=null`.
- New unit tests in `computer/ai-chat/test/codex-autocompact.test.mjs`
  (usage mapping, empty-usage guard, cli-form window resolution).

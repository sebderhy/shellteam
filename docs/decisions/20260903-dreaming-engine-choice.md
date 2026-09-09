# 2026-09-03 — Dreaming extraction engine is configurable: `claude` or `codex`

## Context

Dreaming (docs/decisions/20260708-dreaming-v1.md) already ingested every
agent's transcripts (Claude Code JSONL, Codex rollouts, OpenCode SQLite) and
injected the resulting knowledge into every agent at spawn. But the one LLM
call that *writes* the notes was hardcoded to `claude -p`, a deliberate v1
choice ("one engine, no fallback chain") made when Codex had no verified way
to take ShellTeam's instructions.

That made the whole module unusable on a box with a ChatGPT plan but no
Claude login: the owner's enterprise box runs Codex on a business ChatGPT
subscription and nothing else. The v1 doc named "engine choice in Settings"
as the revisit trigger; this is that revisit.

## Decision

`DREAM_ENGINE` in `.env`: **`claude`** (default, unchanged behavior) or
**`codex`**. Toggleable from dashboard **Settings → Dreaming**
(`/api/settings/dream-engine`), applying to the very next sweep.

Key choices and why:

- **Still one engine per box, still no fallback.** The setting picks ONE CLI;
  an unknown value or a missing CLI fails the sweep loudly (and the Settings
  endpoint refuses to persist an engine whose CLI is not on PATH). Note
  quality must be predictable night to night, so we never silently degrade
  to the other engine.
- **Codex runs as `codex exec --ephemeral --skip-git-repo-check -s read-only
  -C <run dir> -o <final message>`**, prompt on stdin. Verified headless on
  2026-09-03 with codex-cli 0.147.0: the final message lands in the `-o`
  file, no rollout is written (`--ephemeral`, so the sweep can never ingest
  its own run), read-only sandbox because extraction needs no tools. The
  `-o` file is parsed by the same tolerant `_parse_ops` as the Claude path;
  `--output-schema` was considered and skipped: strict JSON Schema would need
  every optional op field modelled and buys nothing over the shared parser.
- **Reasoning effort pinned `high` for Codex.** Codex's default effort is
  model-dependent (the probe banner showed `none`); the nightly sweep is the
  one place worth the model's best, mirroring Opus-by-default on Claude.
- **Model is engine-specific**: `DREAM_MODEL` stays the Claude knob (every
  installed `.env` already says `opus`, which Codex would reject); new
  `DREAM_CODEX_MODEL` is optional and defaults to the Codex CLI's own default,
  i.e. the flagship the account is entitled to. Personal and enterprise
  ChatGPT plans differ in which ids they accept (`gpt-5.3-codex` was refused
  on a ChatGPT account here), so guessing an id would break exactly the
  enterprise box this is for.
- **Both metered keys are always stripped** (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`) from the extraction subprocess, whichever engine runs.
  Same subscription-first rule as the cockpit (`session.mjs getCliEnv`).
- **Read at call time, not import time.** `dream_engine()` reads `os.environ`
  on every extraction; the Settings write goes to `.env` AND `os.environ`
  (`feature_keys.persist`), so an owner "dream now" inside the long-lived API
  process and the systemd timer (EnvironmentFile) both see the change with no
  restart. A module constant would have kept dreaming with the old engine
  until the next `systemctl restart`.
- **Settings card, not Knowledge tab.** The owner asked for it in Settings,
  next to Automatic updates; the card hides when the dreaming module is off
  and greys out (rather than hides) a CLI that is not installed, so the owner
  sees what installing it would unlock.

## What would make us revisit

- A third agent family with a usable headless mode and a subscription worth
  riding (Antigravity `agy`, OpenCode on the box's Fireworks key). Adding one
  is an argv builder + a response reader; the contract stays `{"ops": [...]}`.
- Codex `exec` gaining a `--max-turns`-style bound or losing `-o`; the pinned
  argv is contract-tested in `tests/test_dreaming.py::TestExtractionEngine`.
- Evidence that Codex-written notes are systematically worse than Claude's
  (compare dream reports on the same day's transcripts) — then the Settings
  card should say so.

## Consequences

- A Codex-only box (enterprise ChatGPT, no Claude) can run `--full` dreaming.
- Reports and `run.json` now carry `engine` and a `model` label such as
  `codex/default` or `claude/opus`, so a run can be attributed to its engine.
- Per-run audit trail for Codex: `prompt-<node>.txt`, `response-<node>.json`
  (the `-o` final message) and `codex-<node>.log` (banner/transcript/stderr).

# Install surface: two choices, asked out loud

**Date:** 2026-07-17
**Status:** Decided, shipped

## Context

The installer had accumulated nine user-facing flags: `--minimal`, `--full`,
five granular `--with-<module>` flags, `--no-browser`, and the access flags.
The founder himself looked at `--with-persona` in the README and asked *"what
is this? I don't even know what this does"* — a decisive signal that the
granular surface was noise, not power. Meanwhile the module system already had
a single source of truth (`MODULES=` in `.env`), making every `--with-*` flag
a thin alias for an `.env` edit.

## Decision

The install surface is **two questions**, each with two-to-four answers:

1. **Access** — localhost / Tailscale / free HTTPS URL (`--remote`) / own
   domain (`--domain`).
2. **Depth** — pure core (`--minimal`, the default) / **full harness**
   (`--full`: persona + browser + dreaming).

A first interactive run asks both questions; flags answer them for scripts and
coding agents; re-runs never prompt. The `--with-persona/browser/composio/
linear/dreaming` and `--no-browser` flags are **removed** (not aliased — the
repo has no users yet, so there is nothing to break). Granular control remains
in exactly one place: edit `MODULES=` in `.env` and re-run.

"Harness" is the user-facing word for what `--full` adds (the founder's pick
over "persona"/"assistant"): *agents that know the box* — live-URL and
report conventions, self-verification, a shared browser, nightly knowledge.
The internal module id stays `persona` (renaming it would churn every
existing `.env`, the layer builder, and the purity-gate tests for zero user
benefit — no user ever sees the id unless they open `.env`).

## Consequences

- README/INSTALL shrink; the two-question mental model matches the first-run
  prompt exactly.
- Enabling `composio`/`linear` now requires an `.env` edit (they were already
  key-gated and .env-documented; the flag saved one line).
- The interactive depth prompt defaults to pure core, preserving the
  "zero-injection by default" story.

## Revisit if

- Support requests show users struggling to enable a single module → consider
  a `--modules persona,browser` style flag (one flag, not five).
- The `persona` id leaks into more user-visible surfaces → rename it to
  `harness` in one sweep with an `.env` migration.

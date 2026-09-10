# INCLUDED_MODELS: a box key offered "on us", limited to chosen models

Date: 2026-09-10

## Context

The live demo box carries a budget-capped OpenAI key so a visitor without a
ChatGPT plan can still drive Codex. The first real test (the owner, 2026-09-10)
showed two problems with how the cockpit treated that key:

1. A key in `.env` read as the user's own ("apikey" billing mode), so the
   cockpit skipped the setup screen entirely. Nobody was asked to connect
   their own plan, which is the whole point of the product (frontier agents on
   your own subscription).
2. The family default is GPT-5.6 Sol, the flagship, and every Codex model
   (Astra, Sol at ultra effort) was one click away in the picker. On the
   operator's money that is the wrong default and an open-ended bill.

The same shape recurs beyond the demo: a box run for a colleague or a client,
where the operator's key is a courtesy fallback and the user should bring
their own plan for anything more.

## Decision

One `.env` setting, `INCLUDED_MODELS`, a comma-separated list of catalog ids
from `config/models.json`. Listing models of a family means:

- The family's key bills in the existing **"included"** mode (the mode
  OpenCode's proxy already uses) instead of "apikey". The CLI still receives
  the key.
- The cockpit's setup screen is shown first with "connect your plan" as the
  headline; the included models appear under every tab as an "on us" button.
  The choice is remembered in the browser so the screen does not nag.
- The model picker lists only the included models for that family. The full
  list returns the moment the user connects their own subscription.
- The server refuses any other model of the family at every model change
  (`setSlotModel`, which the picker, `create_tab` and the delegation broker all
  reach), and coerces persisted defaults and saved tabs that name an excluded
  model, with a log line. A golden image snapshotted with Sol as the saved
  model cannot start visitors on Sol.
- Unknown ids are dropped with an error log rather than widening the list.

Empty (the default) changes nothing: keys in `.env` are the owner's own.

## Alternatives considered

- **A model allowlist independent of billing mode.** Rejected: the cap should
  apply only while the operator pays. Once the visitor signs in with their own
  plan, restricting models would be pure friction.
- **Per-family variables (`OPENAI_INCLUDED_MODELS`, ...).** Rejected: the
  family is derivable from the catalog id, and one list keeps `.env` short.
- **Demo-only logic in cloudops (trial.json).** Rejected: the restriction must
  be enforced in the cockpit that spawns the process, and the shape is generic.

## What would make us revisit

- A wish to include a family without any key on the box (a managed relay).
  That is a different mechanism, not a wider `INCLUDED_MODELS`.
- Per-model spend caps rather than a model list.

## Consequences

- The demo box sets `INCLUDED_MODELS=gpt-5.6-terra-max` next to its capped key
  (`demo_box_setup.sh` in cloudops).
- `computer/ai-chat/test/included-models.test.mjs` pins the mode, the gate,
  the coercion and the client wiring.

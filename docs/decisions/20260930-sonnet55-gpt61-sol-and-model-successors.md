# Sonnet 5.5 and GPT-6.1 Sol replace their predecessors; retired ids follow a `replaces` link

Date: 2026-09-30

## Context

Claude Sonnet 5.5 (`claude-sonnet-5-5`, 2026-09-28) and GPT-6.1 Sol
(`gpt-6.1-sol`, 2026-09-29) shipped. Both are listed by the live Anthropic and
OpenAI model APIs, and both answered real turns through the cockpit adapters on
the owner's subscriptions (Claude Code 2.1.285, Codex 0.159.2).

- Sonnet 5.5: 1M context, 128K output, $2/$10 per 1M tokens, "the best
  combination of speed and intelligence". Sonnet 5 is now a legacy model.
- GPT-6.1 Sol: same price, context and output as GPT-6 Sol, "near-Astra
  performance at reduced cost". OpenAI's GPT-6 Sol page points to it as "the
  newer Sol model".

Until now, a tab pinned to a retired model id fell back to its family's default
(`resolveModelId`), so a Sonnet 5 tab would have jumped to Opus 5.5: a different
speed and quota tier the user never picked.

## Decision

1. Each new model replaces its predecessor in `config/models.json`, following
   the house rule that adding a model retires the one it supersedes. The Codex
   default becomes `gpt-6.1-sol-max`; both Sol efforts (max, and Codex's own
   `ultra` mode) move to 6.1.
2. A catalog entry may carry `replaces: [retired ids]`. `resolveModelId` maps a
   retired id to its successor before falling back to the family default, and
   `INCLUDED_MODELS` does the same with a warning, so a box whose `.env` names a
   retired model keeps offering its successor instead of nothing.

## Why

- Each successor is at least as good on every axis the picker shows (same or
  lower price, same context), so keeping both only lengthens the dropdown.
- A successor link keeps a tab in the tier the user chose. It is data, one line
  per model, not a code change per release.
- The `INCLUDED_MODELS` carry-over exists because the live demo box named
  `gpt-6-sol-max`: dropping it would have left visitors with no model.

## Minimum CLI versions

- Codex >= 0.159: on 0.156.0 a ChatGPT login refuses `gpt-6.1-sol` ("not
  supported when using Codex with a ChatGPT account").
- Claude Code 2.1.280 warns `unrecognized_model` for Sonnet 5.5 but answers;
  2.1.285 knows it. `install.sh` does not upgrade CLIs, so managed boxes are
  upgraded by hand.

## Revisit when

- A successor is not strictly better (a price rise, a smaller context): keep
  both models listed instead of retiring one.
- A vendor removes a retired id outright: the `replaces` link still migrates
  tabs, so nothing to do beyond this doc.

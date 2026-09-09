# Dreaming: autonomous knowledge, optional review

**Date:** 2026-07-10
**Status:** accepted
**Refines:** [20260708-dreaming-v1.md](20260708-dreaming-v1.md),
[20260710-dreaming-owner-pass.md](20260710-dreaming-owner-pass.md)

## Context

v1 gated every non-`high` fact behind owner approval: `medium`/`low` proposals
were parked in the review queue and only entered the knowledge base if the
owner clicked approve. After two runs plus a 14-day backfill the queue held 7
items and Seb pushed back:

> "This list is waay too long, and each item is also waay too long and
> unclear… I'm not against having users validate some facts when we're not
> sure, but 1/ the facts should be succinct 2/ it should be optional (the
> system does not rely on that to build its knowledge base)."

Two real problems:

1. **The system relied on review to learn.** With only `high` auto-applying,
   the bulk of learning (`medium`) sat waiting. If the owner never opened the
   tab, the box stopped getting smarter. That inverts the goal — dreaming
   should build knowledge autonomously; review is a courtesy, not a gate.
2. **Facts were verbose.** The prompt said "≤400 chars" and the hard cap was
   500, so multi-clause, parenthetical-stuffed facts were normal — unreadable
   in the queue and bloated in the injected files. Separately, an over-long
   fact was *queued* (previous fix) which, combined with "review is optional,"
   meant it could be silently lost if never reviewed.

## Decision

1. **Confidence controls autonomy, not admission.** `high` **and** `medium`
   apply immediately. Only `low` — genuinely-shaky facts — waits in the
   review queue. The knowledge base builds with zero human dependency; the
   queue is a small, optional trickle for the "when we're not sure" case Seb
   explicitly allowed.
2. **Over-long facts are truncated and applied, never queued or dropped.**
   Length is clamped at a word boundary + ellipsis (`_truncate_fact`) at the
   `MAX_FACT_CHARS` ceiling. Nothing the box learns depends on review, so a
   verbose fact still lands. Injection/multiline/scope stay HARD refusals —
   truncation runs after the injection check, never around it.
3. **The prompt demands succinct facts.** "One crisp line, aim ≤200 chars,
   one fact per op, no crammed clauses." The hard ceiling drops 500 → 320 as
   a backstop; the prompt (not the cap) is what keeps facts short.
4. **Confidence guidance nudges toward autonomy:** the model is told high &
   medium are recorded automatically and low is the only reviewed bucket, so
   it reserves `low` for real doubt instead of hedging everything down.

## What would make us revisit

- Medium-confidence facts proving wrong often enough to pollute injected
  prompts → add a lightweight "recently auto-applied, medium" audit lane, or
  a periodic self-review dream pass that revises stale facts.
- The `low` queue still growing unread → drop review entirely and rely on the
  Knowledge-tab editor (owner edits already win) + the changelog.
- Truncation mangling meaning on real facts → have extraction split an
  over-long fact into several instead of clamping.

## Consequences

- The review queue shrinks from "everything uncertain" to "genuinely shaky
  only" — matches Seb's "short and optional."
- Medium facts enter injected system prompts without human sign-off. Mitigated
  by: injection hygiene still runs, owner edits win, every write is in
  `changelog.jsonl`, and the owner can prune any file from the Knowledge tab.
- Existing queued items from before this change are drained through the new
  logic at deploy time (medium → applied, over-long → truncated+applied).

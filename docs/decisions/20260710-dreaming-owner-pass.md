# Dreaming: the owner pass (single writer of the user layer)

**Date:** 2026-07-10
**Status:** accepted
**Supersedes parts of:** [20260708-dreaming-v1.md](20260708-dreaming-v1.md) (extraction scoping)

## Context

After two real nightly runs, the changelog showed 51 of 58 learned facts going
to per-project `index.md` files and almost nothing reaching the user layer:
`identity.md` got 1 fact, `preferences.md` 0, and `projects.md`/`contacts.md`
could not be written **at all**. Root causes, verified in code:

1. The only batch allowed to write the full user/root layer was the
   `<root>` batch — which only receives sessions whose cwd is bare `~`.
   Nobody runs coding agents from bare `~`, so that batch never fired.
2. Node batches were project-framed ("Everything project-specific → index"),
   biasing extraction away from owner facts even where allowed.
3. `feedback.md` absorbed what should be `preferences.md` — no routing rubric
   distinguished them.
4. A real owner preference was *lost* because the model wrote it >500 chars
   and the engine refused (dropped) it.
5. `~/tmp` QA/research sessions created a bogus `tmp` project node that
   absorbed personal facts (owner-relevant, not project-relevant).

The AI-org vision needs the opposite bias: the box must learn *the owner*
(identity, preferences, people, project map) at least as reliably as it
learns each repo.

## Decision

1. **Owner pass.** Every dream run makes one extra extraction over **all** of
   the day's sessions (every project + scratch), with an owner-framed prompt
   and an explicit routing rubric (identity = who; preferences = standing
   how-to-work rules; feedback = incident-specific corrections; projects =
   cross-project registry; contacts = people). It is the **single writer** of
   the user layer and root layer — enforced structurally in the apply engine
   (a node batch targeting `feedback.md` is refused), not just prompted.
   Node passes are project-only. Rationale for single-writer over
   both-may-write: two writers paraphrasing the same fact defeats exact-match
   dedup and clutters injected files; the owner pass sees the same
   transcripts, so nothing is lost.
2. **Fair-share transcript budget** for the owner pass (120k chars split
   across up to 40 sessions, head+tail per session) — greedy newest-first
   fill would let one long session starve the owner signal in all others.
3. **Scratch scope.** `SCRATCH_NODES = ("tmp",)`: `~/tmp` sessions never
   create a project node but still feed the owner pass. (A "tmp project" is
   a fiction; scratch sessions tend to carry owner facts.)
4. **Queue, don't drop, overlong facts.** Text length is now a *soft*
   violation: >500-char facts go to the review queue with full text; owner
   approval (force) bypasses length + confidence — consistent, since the
   owner can already write anything via the Knowledge tab editor. Injection
   markers/multiline remain hard refusals regardless of length.
5. **First-run lookback 48h → 14 days.** Identity/preference facts accrue
   slowly and mostly live before any 48h window; a box's first dream should
   wake up knowing its owner. Per-batch caps bound the cost.
6. **`last_report` in dream state.** The status API stops globbing
   `~/reports/dream-*.html` (any stray artifact shadowed the real report).

## What would make us revisit

- Owner-pass dedup misses (paraphrase duplicates across nights) → add
  semantic dedup or a consolidation op.
- The 120k owner budget truncating away real owner signal on heavy days →
  raise budget or add a user-message-weighted transcript.
- Users wanting per-folder scratch config → make `SCRATCH_NODES` env-driven.
- Review queue flooded by overlong facts → teach extraction to split facts,
  or add an edit-before-approve UI.
- A second consumer needing cross-file *moves* (e.g. reclassifying old
  feedback entries as preferences) → add a `move_fact` op to the engine.

## Consequences

- One extra `claude -p` call per night (~+1 batch, on the owner's
  subscription; Opus by default).
- `projects.md`/`contacts.md` become populated for the first time; the
  cockpit's root-scope agents get a real cross-project map.
- Node batches proposing owner facts are refused and logged (visible in the
  changelog) — expected to fade as the project prompt now excludes them.
- Existing `tree/tmp` nodes are stale by design; the live box's was backed up
  and removed at deploy time.

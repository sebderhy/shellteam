# Decision: launch from a fresh public snapshot, then develop in the open

- **Date:** 2026-07-12
- **Status:** Accepted (implementation: `scripts/make-public-snapshot.sh`)
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [20260712-agpl-and-dco.md](20260712-agpl-and-dco.md)

## Context

Two facts about this repo's history make it unpublishable as-is:

1. **A leaked OAuth secret lives in cached PR refs.** It was scrubbed from
   `main`'s history, but GitHub caches `refs/pull/*` — force-pushing a cleaned
   history over the existing repo would still leave the secret fetchable.
2. **The owner wants no work-in-progress traces public.** Plans, archives,
   internal roadmaps, and demo scripts are lab notes, not product.

On top of that, the AI-org module (employees/guests/ship) is the future
commercial layer and must not launch as OSS.

## Decision

Release day creates a **fresh public GitHub repo from a filtered export**
(`scripts/make-public-snapshot.sh`): a fresh single initial commit, with the
following excluded —

- the org module files, plus `ORG-BEGIN`/`ORG-END`-marked regions in shared
  files (the markers were fenced in commit `b169995` precisely for this);
- `docs/plans/`, `docs/archive/`, the org decision docs;
- the internal `ROADMAP` and demo scripts.

**Post-launch development model:** the public repo becomes the **primary dev
repo**. This private repo stays the lab for unreleased work (org), merging
public → private regularly; private features are PR'd into public deliberately
when released.

## Rejected alternatives

- **(a) Force-push a cleaned history over the existing repo.** GitHub caches
  `refs/pull/*`; the old OAuth secret would remain fetchable from the cached
  PR refs. A fresh repo has no such refs.
- **(b) One public repo with public `main` + public dev branches.** Anything
  ever pushed to a public repo is public forever — the org module could never
  be unpublished once a branch carried it. The private lab is the only place
  unreleased work can actually stay unreleased.

## What would make us revisit

1. The org module ships as OSS — the `ORG-BEGIN`/`ORG-END` markers make
   re-inclusion trivial, and the two-repo split loses its main justification.
2. The public → private merge overhead becomes painful — at that point,
   consolidate rather than keep paying the sync tax.

## Consequences

- The public repo starts with zero history: no leaked refs, no WIP
  archaeology, and a clean line for the DCO/provenance story.
- Contributors and CI live against the public repo; the private repo consumes
  public via regular merges, so drift is bounded by merge cadence.
- The snapshot script is the single source of truth for what is public —
  anything not excluded there ships.

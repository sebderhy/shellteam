# Wizard scripts are served by the box, not fetched from GitHub main

**Date:** 2026-07-28
**Status:** accepted (shipped with the secrets-manager detection release)

## Context

The Environment Mirror's laptop-side scripts (`mirror-import.sh`, which the
Settings tab mints a command around, and `mirror-inventory.sh`, which the
wizard downloads as its engine) were fetched from
`raw.githubusercontent.com/sebderhy/shellteam/main`. Two problems:

1. **Unpinned remote code on the user's laptop.** These scripts read dotfiles,
   agent configs, and (opt-in) credential files on the machine that holds
   everything the user owns. Fetching them from a mutable git ref means whoever
   moves `main` — a compromised maintainer account, a bad merge — controls what
   runs on every user's laptop from that moment on. Boxes are pinned to release
   tags (`self-update.sh`); the laptop path was the one place still tracking
   `main` live.
2. **Version skew.** A box on v0.1.5 would mint a command that fetches
   tomorrow's `main` scripts, whose staging format the box's `migrate` skill
   and upload endpoint may not understand yet.

## Decision

The box serves both scripts itself at `GET /api/mirror/mirror-import.sh` and
`GET /api/mirror/mirror-inventory.sh` (unauthenticated — they are public source
and the laptop has no credential at fetch time; only the two fixed names are
routed, no path reaches the filesystem). The minted command fetches the wizard
from the box, and `mirror-import.sh` defaults its inventory fetch to the box
URL it was given. GitHub `main` remains only the boxless fallback (running the
inventory by hand with no box yet) and via the `MIRROR_RAW_BASE` override.

A tag-pinned GitHub URL was considered and rejected: it fixes the mutable-ref
problem but not version skew, and it adds a release-time bump to maintain. The
box's own checkout IS the correct version by construction.

## What would make us revisit

- The scripts growing a life independent of the box release cycle (e.g. a
  standalone "inventory my machine" tool) — then a pinned, signed artifact on
  GitHub Releases would be the right distribution.
- Serving needs beyond two fixed files (never add a path parameter here).

## Consequences

- What runs on the laptop is exactly the version the box runs; the
  wizard/packer section-list contract is guaranteed at runtime, not just in CI.
- Docs (`INSTALL.md`, the `migrate` skill) now teach download-read-run against
  the box URL instead of `bash <(curl … main …)`.
- Contract tests: the minted command must reference the box and never
  `githubusercontent`; the served scripts must be byte-identical to the
  checkout; the wizard's inventory fetch is behaviorally pinned to the box URL
  (fake-curl capture test).

## Amendment — 2026-07-29: the boxless fallback is pinned to a tag

The rejection of a tag-pinned GitHub URL above was about the *primary* path,
where the box's own version is strictly better. It left the boxless fallback
(`scripts/mirror-import.sh`, no box argument, no repo sibling) fetching
`main` — the last place where moving a branch changes code that runs on a
user's laptop and reads their dotfiles. Version skew is not a concern there:
with no box, there is nothing to skew against.

So the fallback now pins `MIRROR_FALLBACK_REF` to a release tag. The
release-time bump the original decision wanted to avoid is enforced by a test
(`test_the_pinned_fallback_tag_matches_the_current_release`) that compares the
pin against CHANGELOG's newest release, so forgetting it is a red suite rather
than a silently stale pin. A second test forbids the string `/shellteam/main/`
in the wizard outright.

# Pin immutable versioned artifacts, never "latest" URLs

**Date:** 2026-08-03
**Status:** accepted

## Context

`install.sh` downloads three third-party installer scripts and verifies each
against a pinned sha256 before running it (the NodeSource one runs as root). The
guard was added deliberately: a changed or compromised upstream must fail loudly
rather than execute.

Two of the three URLs pointed at *moving* endpoints:

- `https://astral.sh/uv/install.sh` — always serves the latest uv release
- `https://deb.nodesource.com/setup_22.x` — NodeSource's rolling setup script

On 2026-08-03 Astral shipped uv 0.12.1. The pinned hash stopped matching and the
guard aborted **every fresh install**:

```
xx Installer script changed upstream: https://astral.sh/uv/install.sh
   pinned sha256: b67e3850...
   actual sha256: d3f5412d...
```

The guard behaved exactly as designed. The pin was the bug.

It was found the worst possible way: provisioning a box for a prospective user,
64 seconds into a build that had been promised to her that evening.

## The decision

**Where an upstream publishes versioned release artifacts, pin those.** uv now
resolves through a version constant:

```sh
UV_VERSION=0.12.1
UV_INSTALL_URL="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-installer.sh"
```

A "latest" URL plus a sha256 is a contradiction. The hash is a promise that the
bytes will not change; the URL is a promise that they will. Combining them
guarantees a break on the next upstream release, timed by a third party.

The blast radius is what makes it more than an annoyance. Managed boxes install
from a **release tag**, not `main`. So a stale pin cannot be repaired by fixing
the repo: it needs a re-pin *and* a new tag, while every new customer box and
every new self-hoster is dead in the water.

Before re-pinning, the new script was verified rather than assumed: the
astral.sh CDN copy was confirmed byte-identical to the GitHub release artifact
for 0.12.1. Bumping a supply-chain pin because "upstream probably updated" would
defeat the entire mechanism.

Two supporting changes:

- All three installers now have URL constants, defined **above** `print_plan`,
  so `--plan` quotes the URLs the install actually fetches instead of a
  hand-maintained copy. The duplicated-string drift that hid this is the same
  failure mode one level up.
- `provision.sh` gained an explicit `--allow-unpinned-installers` escape hatch
  (off by default, logs a warning) for the window between an upstream release
  and a new tag. It is a last resort, not the fix.

## Not done, and why

**NodeSource is still pinned to `setup_22.x`.** NodeSource does not publish a
per-version installer artifact, so there is no immutable URL to point at. It
will eventually break the same way. Accepted knowingly rather than papered over;
the escape hatch exists for that day.

## Consequences

- Upgrading uv is now a deliberate two-line change (version + hash), which is
  the point.
- Three gates in `tests/test_installer.py`, all verified to fail against the
  pre-fix `install.sh`: the uv URL must be version-scoped,
  `astral.sh/uv/install.sh` must not come back, and `--plan` must reference the
  constants.

## What would make us revisit

- An upstream we pin starts signing releases in a way we can verify directly
  (minisign, cosign): prefer signature verification over a hash we maintain.
- A third pin goes stale, or NodeSource breaks as predicted. At that point the
  right move is probably a scheduled job that checks every pinned URL against
  its hash and opens an issue **before** a customer install discovers it. Today
  the only detector is a failed provision.

# Decision: security docs compare against the CLI, and `--create-owner` sudo is install-time only

- **Date:** 2026-09-07
- **Status:** Implemented (v0.1.20)
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [20260702-core-plus-modules.md](20260702-core-plus-modules.md),
  [20260715-install-coexists-with-existing-services.md](20260715-install-coexists-with-existing-services.md),
  [20260907-apps-tab-on-composio.md](20260907-apps-tab-on-composio.md)

## Context

A prospective user asked his own Claude whether to install ShellTeam on a VPS
that already hosts a paying client's app. Claude read `SECURITY.md`, and told
him: no container isolation, a compromised agent has the whole VPS, use a
dedicated box. He walked away.

The advice was defensible, but the framing was ours to fix. `SECURITY.md` opened
by comparing the OSS edition to our own Cloud edition ("no container
isolation"), which means nothing to a new user and reads as if ShellTeam
invented the risk. Seb's pushback was exact: ShellTeam is a UX layer on top of
CLIs the user already runs on that box. The only honest question is *what
changes versus running the CLI yourself*.

The answer, once written down, is short:

1. Approval prompts are off (full-auto is the product).
2. The box gets a token-gated web door, plus our own services running as the
   user.
3. Optional modules add channels (browser, app connections), each an explicit
   opt-in.

The prompt-injection scenario itself is identical in a terminal. And one item
was purely our doing: `--create-owner` left the owner with permanent
passwordless sudo and docker-group membership. The product never needs either
after install (everything is `systemd --user`; self-update is a `git pull`).
On a shared box that grant *was* the blast radius.

## Decision

1. **`SECURITY.md` leads with the CLI comparison**, not with isolation. A new
   "Sharing a box with other things" section gives the recipe instead of only
   the warning. The residual (localhost services without passwords, the
   network) is stated.
2. **`--create-owner` grants sudo for the install run only** and removes
   `/etc/sudoers.d/<user>` when the re-exec'd run returns. `--keep-sudo` keeps
   the old behaviour for dedicated boxes. Re-running the installer later is
   `sudo ./install.sh --create-owner <name> <flags>` from a root shell; the
   closing note says so on bootstrapped boxes.
3. **The docker group moves into the browser module.** `provision_browser`
   adds the group (with a root-equivalence warning) and runs Docker through a
   `sudo` fallback for the current run. Nobody gets the group for existing.
4. **Opt-in modules carry their own note at the point of consent.** The Apps
   tab says, under its title, that agents get the access you grant and that
   what they read there becomes text they may act on. The README paragraph
   that claimed "zero new agent privilege" now names the two real changes.

## What would make us revisit

1. A day-2 operation that genuinely needs root (a Caddy reconfiguration from
   Settings, say): either scope a sudoers entry to that exact command or keep
   the operation in the installer.
2. Rootless Docker or Podman becoming a dependable default on the distros we
   support: then the browser module no longer needs a root-equivalent group.
3. Evidence that the "sharing a box" recipe leads people to install next to
   production anyway and get hurt: tighten the copy toward the dedicated box.

## Consequences

- Existing `--create-owner` boxes are untouched; the changelog gives the
  one-line revoke for owners who want it.
- `tests/test_installer.py` pins both the revocation and the docker-group move.
- Fresh-box QA for this release ran the real `--create-owner` path in a
  sysbox container and checked the sudoers file is gone with services healthy.

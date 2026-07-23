# 2026-07-23 — Opt-in automatic updates via a systemd --user timer

## Context

The documented update story is manual: `git pull && ./install.sh`
(INSTALL.md). Self-hosted boxes that never do this drift behind security
fixes; the managed-VPS tier ("always patched" is part of what's being paid
for) needs updates to happen without the owner thinking about it.

## Decision

A daily `shellteam-update.timer` (03:10 + jitter, `Persistent=true`) running
`scripts/self-update.sh`, governed by **`AUTO_UPDATE` in `.env`**:
`off` (default) | `daily` | `weekly`. Toggleable from dashboard Settings
(`/api/settings/auto-update`), which shows the last outcome from
`~/.local/state/shellteam/update-state.json`.

Key choices and why:

- **Default OFF for self-hosters.** Unsolicited restarts of someone's own box
  violate the "additive, you stay in charge" posture. The managed-VPS
  provisioning flips it to `daily` (cloudops change, separate repo).
- **Track the latest `v*` release tag, never `main`.** Boxes get vetted
  releases; a maintainer pushing to main doesn't ripple to fleets.
- **Timer always installed, script self-gates.** Unlike the module-gated
  dreaming timer, `AUTO_UPDATE` is core config: the service re-reads `.env`
  each tick and exits instantly when off. The Settings toggle is therefore a
  plain `.env` write — no systemctl choreography from a web request, no
  restart needed. An inert daily oneshot costs nothing; FOOTPRINT.md lists the
  unit and `uninstall.sh` removes it.
- **systemd timer, not cron** — the whole stack is already `systemd --user`
  with linger; no new moving part, failures show red in `systemctl --user`.
- **Never clobber local work**: refuses a dirty working tree and any checkout
  that isn't an ancestor of the target tag (local commits, dev branches, a box
  deliberately ahead of the release). Fast-forward only.
- **Apply = `./install.sh`** — the canonical idempotent apply step (deps,
  rendered configs, service restarts). No second update mechanism to maintain.
- **Health-checked with rollback**: after install, `/health` is polled; on
  failure the previous ref is restored and install.sh re-run, the unit exits
  red, and the state file says `rolled-back`. No silent failure at any step —
  every outcome is in the journal AND surfaced in Settings.
- The script re-execs from a temp copy first, because the update replaces the
  script file itself mid-run.

Behavior is pinned by `tests/test_auto_update.py` against a real git fixture:
fast-forward, off-mode no-op, dirty refusal, diverged refusal, up-to-date
no-op, and rollback on a failed install.

## Consequences

- Services (including the cockpit) restart during an auto-update window
  (03:10–03:20 local). Acceptable for an opt-in nightly window; the Settings
  copy says so.
- A box left on a dirty checkout reports a red unit daily until resolved —
  loud by design.

## What would make us revisit

- Release-channel needs (e.g. `stable` vs `edge`) — would become
  `AUTO_UPDATE_CHANNEL`.
- Signed releases: tag signature verification before checkout would slot into
  the script at the tag-selection step.

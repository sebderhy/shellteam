# 2026-09-07 — The owner's systemd user manager restarts unconditionally

## Context

Everything ShellTeam runs (API, cockpit, nginx, timers) is a `systemd --user`
unit under the owner's user manager, `user@<uid>.service`. The installer
enables linger so that manager stays up with no login session and starts at
boot. That was assumed to be enough for a headless box.

It is not. On 2026-09-07 at 06:30:17 UTC the whole stack on the founder's VPS
went down for 3.5 hours. The journal shows why:

```
systemd[1085]: Received SIGINT from PID 3402594 (node).
gpg-agent[3291138]: SIGINT received - immediate shutdown      <- same millisecond
systemd[1085]: Activating special unit exit.target...
systemd[1]:    user@1002.service: Deactivated successfully.
```

A node process (an agent session running in the cockpit) sent a **broadcast**
signal: gpg-agent and other unrelated daemons got the same SIGINT in the same
millisecond, which is the signature of `kill(-1, SIGINT)` or a broad `pkill`.
The user manager is one of the processes such a signal reaches, and a user
manager treats SIGINT/SIGTERM as `exit.target`: it stops every unit it owns
and exits with status 0.

The part that turned a blip into a 3.5h outage: **linger does not restart a
manager that exited.** `user@.service` ships with `Restart=no`. Linger only
means "start it at boot and do not stop it at logout". Once it is gone, the
only thing that brings it back is a new login session (pam_systemd), which is
exactly what happened at 09:58:54 when the owner SSH'd in to ask why the box
was down.

This is structural to ShellTeam's design, not a one-off: the agents run as the
owner, in the same user session as the services they depend on, with
`--dangerously-skip-permissions`. Any agent that cleans up "its" processes too
broadly is a kill switch for the stack. The repo already carries two scars of
this shape (the "never restart ai-chat from a cockpit session" rule and the
"no `pkill -f`" QA gotcha).

## Decision

`install.sh` writes one root-owned drop-in,
`/etc/systemd/system/user@<uid>.service.d/shellteam-restart.conf`:

```ini
[Unit]
StartLimitIntervalSec=0
[Service]
Restart=always
RestartSec=2
```

`uninstall.sh` removes it. It is listed as a Tier 3 change in
`docs/FOOTPRINT.md`, and `--plan` prints it.

Verified on 2026-09-07 with a throwaway user carrying the same drop-in:
`kill -INT <manager pid>` produced `exit.target` → `Deactivated successfully`
→ `Scheduled restart job, restart counter is at 1` → manager back in 2s, every
enabled user unit with it.

Why this shape:

- **`Restart=always`, not `on-failure`.** exit.target ends the manager with
  status 0. `on-failure` would never fire for the very case we care about.
- **`StartLimitIntervalSec=0`.** The default (5 starts in 10s) would give up
  if a misbehaving agent fired repeatedly, leaving the box in the exact state
  we are fixing. An unbounded restart loop of a 2s-cost process is the lesser
  evil, and it is visible in `journalctl -u user@<uid>`.
- **Instance-specific (`user@<uid>`), not the template.** It is the owner's
  manager we depend on; other accounts on the box keep distro behaviour and
  the footprint stays exactly one file.
- **A drop-in, not a copy of the unit.** Distro upgrades to `user@.service`
  keep applying.

Explicit stop jobs (`loginctl disable-linger` + logout, system shutdown,
`systemctl stop user@<uid>`) are unaffected: `Restart=` only reacts to the
process ending on its own.

## Alternatives considered

- **Move the stack to system-level units (`User=<owner>` under PID 1).**
  Immune to user-session signals, but it changes the whole install model
  (root-owned units, `systemctl` needs sudo, `journalctl --user` stops
  working, every doc and test that says `systemctl --user` changes). Too big
  a swing for a failure that a one-file drop-in fully covers. Revisit if the
  drop-in proves insufficient.
- **Stop agents from sending broadcast signals.** Not enforceable: they run
  as the owner with full permissions by design (SECURITY.md).
- **Make the manager ignore SIGINT.** Not a systemd option, and would also
  break legitimate `systemctl --user exit`.
- **A watchdog timer that re-runs `loginctl enable-linger` / starts the
  manager.** Strictly worse than letting systemd do the same thing natively.

## What would make us revisit

- A second outage class the drop-in does not cover (for example the manager
  wedged rather than exited; `Restart=` does nothing for a hung process).
- systemd changing `user@.service` semantics so that linger implies restart
  (then the drop-in becomes redundant and should be dropped).
- Moving to system-level units for another reason (multi-user boxes, org
  module), at which point this decision is superseded.

## Consequences

- The installer now writes one file outside the owner's home. `--plan` shows
  it; `uninstall.sh` removes it; `docs/FOOTPRINT.md` lists it.
- A stray broadcast kill still interrupts every running agent turn (they are
  children of the units that get stopped). It no longer costs hours of
  downtime; the stack is back in about 2 seconds plus service start time.
- Boxes installed before this change do not have the drop-in until
  `install.sh` is re-run (it is idempotent) or the self-update timer pulls a
  release that includes it.

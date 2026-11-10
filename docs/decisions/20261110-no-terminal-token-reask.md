# Decision: the web terminal no longer re-asks for the owner token

- **Date:** 2026-11-10
- **Status:** IMPLEMENTED (Linear SHE-155). Regression: `TestTerminalSession` in
  `tests/test_she136_box_takeover.py`.
- **Deciders:** Seb + Claude
- **Amends:** [20261104-sessions-not-the-master-token.md](20261104-sessions-not-the-master-token.md), point 2

## Context

After the 2026-11-03 takeover, SHE-136 made the Terminal tab ask for
`OWNER_TOKEN` again when the sign-in was older than `TERMINAL_FRESH_MINUTES`
(15). The goal: a stolen session cookie alone should not open a shell.

On 2026-11-10 Seb could not open his own terminal: he did not remember the
token. Checking the code showed the terminal was the only place that re-asked.
The Agents tab runs Claude Code, Codex and the others with
`--dangerously-skip-permissions` on the same session, and an agent runs any
command it is told to. So a thief holding a stolen session already had a shell
one tab over.

## Decision

Remove the re-ask entirely: the 4401 close, `POST /api/auth/confirm`, the
terminal page's token prompt, the session `auth_at` field, `sessions.is_fresh`
/ `confirm`, and `TERMINAL_FRESH_MINUTES`. The terminal opens on any live
session, exactly like the Agents tab.

## Why

- The re-ask guarded one door of two that open the same room. It cost the
  owner the token on every terminal open after 15 minutes and stopped no
  attacker.
- What actually bounds a stolen session stays: sessions expire
  (`SESSION_TTL_DAYS`), are stored hashed, die on "Log out everywhere" or a
  token rotation; new sign-ins and devices alert the owner (SHE-149); every
  terminal open is logged with its IP and pushed to the notify channel.
- Option considered and not taken: a passkey (fingerprint / Face ID) in place
  of the token. Nicer than typing the token, but it would still guard only the
  terminal while the Agents tab stays open.

## Revisit if

- The cockpit itself gets a step-up gate (e.g. a passkey to start an agent
  turn after a long idle). Then the terminal should join the same gate.
- A box runs agents without full shell access, so the terminal becomes the
  only way to run arbitrary commands.

## Consequences

- One fewer prompt; ~160 lines removed.
- An old `TERMINAL_FRESH_MINUTES` line in a box's `.env` is simply ignored.

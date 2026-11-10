# Decision: browsers hold sessions, never OWNER_TOKEN; the agent browser is network-isolated

- **Date:** 2026-11-04
- **Status:** IMPLEMENTED on branch `fix/she-136` (Linear SHE-136). Regression
  pack: `tests/test_she136_box_takeover.py`, plus the session cases added to
  `tests/test_split_credentials.py`, `tests/test_proxy.py`, `tests/test_app_routes.py`.
- **Deciders:** Seb + Claude
- **Amends:** [20260702-split-credentials.md](20260702-split-credentials.md)
- **Amended by:** [20261110-no-terminal-token-reask.md](20261110-no-terminal-token-reask.md)
  (point 2, the terminal's fresh confirmation, was removed on 2026-11-10)

## Context

On 2026-11-03 a box was taken over end to end:

1. Code running in a container on the default Docker bridge (another app's
   sandbox on the same host) reached the Steel agent browser `shellteam-steel`.
   Its CDP port (9223) and API (3000) answered anyone on the bridge, no auth.
2. `Storage.getCookies` on the live browser returned the cockpit cookies. The
   browser had been signed in to the dashboard, and the `shellteam_token`
   cookie value WAS `OWNER_TOKEN` (`auth.apply_session_cookies`). The derived
   `shellteam_files` was a static HMAC of the master, so it never expired either.
3. With the master they opened `/api/terminal` from the internet: a shell as the
   owner, who had passwordless sudo (a cloud-image default, not granted by us).

Every layer of the split-credential model held against what it was designed for
(hostile served pages), but a stolen cookie jar was a permanent, unrevocable
master credential, and a single cookie was enough for a root shell.

## Decision

1. **Sessions, not the master, in the cookie.** `api/services/sessions.py` owns
   `DATA_DIR/<owner>/sessions.json` (0600). Login, enrollment and `/?token=` mint
   `s1.<id>.<secret>`; only `sha256(secret)` is stored. Sessions expire
   (`SESSION_TTL_DAYS`, default 14, absolute), can be revoked one by one
   (`POST /api/auth/logout`) or all at once (`POST /api/auth/logout-all`,
   Settings, Devices, "Log out everywhere"). The store carries an HMAC "epoch"
   of the current master: rotating `OWNER_TOKEN` revokes every session on the
   next lookup. `shellteam_files` became `f1.<id>.<HMAC(master, id)>`, so it
   dies with its session. A cookie holding the master is refused everywhere
   (`auth.request_is_owner`, `auth.verify_token`); `GET /` migrates such a
   legacy cookie into a non-fresh session once. `OWNER_TOKEN` still works as a
   Bearer header for in-box tooling.
2. **Fresh confirmation for the terminal.** `/api/terminal` opens only on a
   session whose last master/enrollment proof is younger than
   `TERMINAL_FRESH_MINUTES` (default 15). Otherwise it closes with 4401 and the
   terminal page asks for the token (`POST /api/auth/confirm`). Every terminal
   session logs its client IP and session id, and is pushed to the owner's
   notify channel (Telegram/ntfy) when one is configured.
3. **Steel on its own network.** `install.sh` creates (idempotently, and
   re-creates when ICC was turned back on) `shellteam-browser-net` with
   `com.docker.network.bridge.enable_icc=false`, and runs Steel only there,
   published on host loopback. It refuses to start Steel on a non-isolated
   network. `api/services/security_checks.py` warns in the dashboard and journal
   when the container is found anywhere else.
4. **The agent browser is never signed in to the dashboard.** Nothing in the
   platform does it automatically; the persona's browser section now forbids
   it, and a test pins that no layer text puts the token or a login link in a
   browser.
5. **Passwordless sudo: detect and warn, never edit.** The installer never
   granted it to an existing account (`--create-owner` already removes its own
   install-time grant). It now warns at the end of a run and the dashboard shows
   a persistent red banner while `sudo -n -l` lists `NOPASSWD: ALL`. We do not
   touch sudoers we did not write.

## Why

- Bounding the value of a stolen cookie (expiry, revocation, rotation) is the
  piece the incident proved missing; the session store is ~200 lines, one
  file, no new dependency, consistent with the no-database OSS edition.
- Fresh confirmation for the terminal makes a cookie alone insufficient for a
  shell, at the cost of one prompt per terminal open after 15 minutes.
- Network isolation removes the entry point itself, independent of cookies.

## Not done (and why)

- **No step-up on the cockpit.** The agents run with
  `--dangerously-skip-permissions`, so a live session reaching the cockpit is
  still shell-equivalent. Gating it would break the cockpit's own WebSocket on
  every reconnect. The session expiry, revocation and network isolation bound
  this; revisit with WebAuthn.
- **No scoped "agent browser" token.** Nothing signs the agent browser in, so
  there is nothing to scope. If a feature ever needs the agent to view private
  pages in its browser, mint a files-only session for it, never a full one.
- **Sliding expiry.** Absolute TTL is simpler to reason about; revisit if
  owners complain about re-login every two weeks.

## Revisit when

- WebAuthn/passkeys land (replace token re-entry for confirm and login).
- Multi-process API (the store's in-process lock assumes one uvicorn worker).
- Steel gains auth on CDP, or the browser moves off Docker.

## Consequences

- Every browser signs in again after the upgrade only if it never loads `/`
  (others are migrated). Owners who may have been exposed must rotate
  `OWNER_TOKEN` (which also signs everything out).
- The terminal prompts for the token when the sign-in is older than 15 minutes.

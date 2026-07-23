# Install coexists with the operator's existing services (never seizes ports or clobbers config)

**Date:** 2026-07-15
**Status:** accepted

## Context

ShellTeam's north star is an *additive layer* — it must never mutate the box out
from under its owner (see [docs/design/vps-footprint.md](../design/vps-footprint.md),
[docs/FOOTPRINT.md](../FOOTPRINT.md)). That principle was written about coding-agent
dotfiles, but dogfooding the public v0.1 snapshot on a fresh cloud VPS
(2026-07-14/15) exposed that the *installer* itself violated the spirit of it in
three ways on a box that already runs production services — which is the common
case, not the exception. A self-hoster's VPS very often already has a web app on
`:8000`, a site on `:80/:443`, and a reverse proxy.

The failures, in order of severity:

1. **`--public` overwrote `/etc/caddy/Caddyfile` wholesale** (`sudo tee`) and
   restarted Caddy. If the operator already ran Caddy for their own site, the
   installer would **take that site down**. This is data loss + an outage, not
   friction.
2. **`--public` assumed ShellTeam owns `:80/:443`.** If nginx/Apache/Traefik held
   them, our Caddy silently failed to bind and no cert issued — an opaque dead
   end (the exact symptom hit while dogfooding).
3. **Default app-port collisions were a hard `die`.** If `:8000`/`:80` were taken,
   the installer stopped and made the operator hand-edit `.env`.

## Decision

The installer fits *around* whatever the box already runs:

- **Auto-pick free loopback ports.** `autopick_port` moves `API_PORT` /
  `AI_CHAT_PORT` / `FILE_PORT` to the next free port when the default is taken and
  records the choice in `.env`. A free port, or one already served by our own unit
  (idempotent re-run, detected via `systemctl --user is-active`), is left alone.
- **Never clobber a non-ShellTeam Caddyfile.** ShellTeam-written Caddyfiles carry a
  `ShellTeam-managed` marker. `configure_caddy` regenerates only a marked file;
  anything else is backed up to `/etc/caddy/Caddyfile.pre-shellteam.<ts>` and the
  install stops with guidance (put ShellTeam behind your own proxy, or move the
  file aside).
- **Refuse `:80/:443` rather than fight for them.** `preflight_tls_ports` stops
  `--public` when something other than Caddy already serves those ports, and points
  the operator at the bring-your-own-proxy path (ShellTeam stays on
  `127.0.0.1:$API_PORT`; add a vhost that forwards to it).

All three are verified on a fresh sysbox box with foreign listeners / a foreign
Caddyfile in place (autopick relocates and stays healthy; both refusals fire; a
marked Caddyfile still regenerates so `--public` re-runs remain idempotent).

## Consequences

- Installing next to a production stack is safe by default: no seized ports, no
  overwritten proxy config, no outage.
- The scary `--public` flag is **renamed to `--remote`** (a benefit-named flag —
  "reach it from anywhere" — that doesn't imply open access; `--public` stays as a
  hidden deprecated alias that warns). The post-install banner now says "token-gated
  login wall, not open access" explicitly.
- The bring-your-own-proxy path is currently *documented guidance*, not yet a
  first-class flag. A follow-up will add an explicit `--behind-proxy` mode (bind a
  high port + print an nginx/Caddy/Apache snippet).

## What would make us revisit

- If auto-relocating ports surprises operators (they expect a fixed `:8000`),
  reconsider defaulting to relocate vs. prompt.
- If the `ShellTeam-managed` marker heuristic ever produces a false positive
  (treating a user file as ours), switch to a stored manifest of files we wrote.

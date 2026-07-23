# File URLs live on the main domain, not the owner-subdomain

- **Date:** 2026-07-02
- **Status:** Accepted
- **Deciders:** Seb + Claude (cockpit session)

## Context

ShellTeam OSS inherited the Cloud edition's URL scheme: files are served at
`<username>.<APP_DOMAIN>/<path>`, ports at `<username>-<port>.<APP_DOMAIN>`.
In the multi-tenant Cloud that username-subdomain *is* the tenant boundary.
On a single-user box it degenerates: with `APP_DOMAIN=alice.example.com` the
file host becomes the stuttering `alice.alice.example.com`.

Worse, it broke agents in practice. The agent-layer persona
(`agent_layer.py:_render_persona`) already told agents *"every file in your
home dir is accessible at `https://APP_DOMAIN/<path>`"* — but the control
plane never implemented that URL, so every report link an agent produced
(e.g. `https://alice.example.com/tmp/report.html`) returned 404. Hit twice on
2026-07-02 with agent-generated implementation reports.

## Decision

Serve the owner's `$HOME` directly on the main domain: any main-host path not
matched by a registered route falls through to a catch-all
(`proxy.serve_owner_file`) that proxies to the local nginx file server
(`127.0.0.1:FILE_PORT`).

Security gates, in order:
1. **Path traversal / null bytes** → 400 (`_has_path_traversal`).
2. **Dotfile segments** (`.env`, `.ssh`, `.claude`, …) → 404 *before any
   forwarding*, on top of nginx's own `location ~ /\.` deny (defense in depth).
3. **Owner token required** (Bearer / `?token=` / cookie, constant-time
   compare) — except `~/public/*` and reports the owner explicitly published.
   Deliberately narrower than the file-subdomain's `_is_public_path` (guest
   chat is not exposed on the main host).

The `<owner>.APP_DOMAIN` file subdomain keeps working (dashboard Files tab
still frames it); it is simply no longer the canonical URL form. Port-preview
subdomains (`<owner>-<port>.APP_DOMAIN`) are unchanged — a server on a port
genuinely needs its own origin.

## Reasoning

- **Agents' natural URLs now resolve.** The persona's promise and the
  server's behavior finally agree; no more 404 report links, with zero
  persona changes.
- **Kills the double-subdomain.** `alice.example.com/tmp/report.html` instead
  of `alice.alice.example.com/tmp/report.html`.
- **One origin** for dashboard + files → one login cookie, no cross-subdomain
  scoping, simpler mental model for a single-user product.
- **Reuses the existing security boundary** — same `token_is_owner` gate as
  every API route, same nginx dotfile deny. No new auth code paths.

Trade-offs accepted:
- `$HOME` shares a namespace with app routes: a top-level `~/api/`,
  `~/static/`, `~/public/`, `~/terminal` … dir is shadowed by the app route.
  Registered routes always win (the catch-all is registered last).
- The catch-all is security-critical on a public bind — covered by dedicated
  tests (`tests/test_proxy.py::TestMainHostFileServing`): dotfiles never
  reach nginx, traversal rejected, token gate enforced, guest-chat bypass not
  inherited.
- Anonymous requests to unknown main-host paths now get a 401 login page
  rather than a 404 — deliberate (don't leak which files exist).

## What would make us revisit

- OSS grows real multi-user support → per-user subdomains become meaningful
  again.
- A route/file namespace collision bites in practice (e.g. a project dir
  named `api/`) → consider a dedicated `/~/<path>` or `/files/<path>` prefix.
- The file server needs to move off-box → the catch-all would proxy across a
  network boundary and deserves a rethink.

## Consequences

- `MAIN_HOSTS` moved from `api/main.py` to `api/config.py` (shared with
  `proxy.py`).
- The duplicated httpx forwarding block in `proxy_subdomain` was extracted to
  `_forward_http()`, now shared by both paths.
- Docs/UI that print the `<owner>.APP_DOMAIN` file URL form should migrate to
  main-domain paths over time (Files tab iframe is fine as-is).

# Decision: split-credential web security model (master token out of JS and URLs)

- **Date:** 2026-07-02
- **Status:** **IMPLEMENTED 2026-07-04** (roadmap item B2). The master session
  cookie is HttpOnly + host-only; content origins carry the derived read-only
  `shellteam_files` credential; sharing mints signed expiring links
  (`GET /api/auth/share`); `?token=` master acceptance is dead (one-time
  `GET /?token=` redemption excepted). Regression pack:
  `tests/test_split_credentials.py` + the split-credential classes in
  `tests/test_proxy.py`. Two implementation deltas from the design as written,
  both documented in [20260704-purity-gate-modules.md](20260704-purity-gate-modules.md):
  the cockpit port accepts the derived credential **behind an Origin
  allow-list** (a host-only master can never reach a port subdomain), and the
  Files tab/editor moved to the dashboard origin (its writes need the master).
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [SECURITY.md](../../SECURITY.md), [20260702-main-domain-file-urls.md](20260702-main-domain-file-urls.md)

## Context

ShellTeam's defining convenience is that **everything gets a URL**: every file
under `~/`, every port, the editor, shareable reports — usable from any device.
The auth boundary for all of it is a single shared secret, `OWNER_TOKEN`.

Auditing the live code (2026-07-02) found the token handling solid in places —
constant-time compare (`api/services/auth.py`), brute-force throttling
escalating to 429 (`api/dependencies.py`), path-traversal rejection, and the
subdomain proxy stripping the `shellteam_token` cookie before forwarding to
user apps (`api/routers/proxy.py:75`) — but with one structural flaw and two
leak paths:

1. **The master token is a JS-readable cookie on every subdomain, for a
   year.** `enroll.py` sets `shellteam_token` with `httponly=False`,
   `domain=APP_DOMAIN`, `max_age=31536000`; the dashboard's `persistToken()`
   does the same and mirrors it into `localStorage`. Meanwhile ShellTeam
   *serves agent-generated HTML* on those same origins. Consequence: one
   malicious or compromised script in one served page (a report pulling a
   compromised CDN library, a prompt-injected agent writing an exfiltrating
   page) can read `document.cookie` and ship the master token — and the master
   token drives the terminal, i.e. owns the box.
2. **`?token=` is accepted as the master token** (`auth.py`
   `get_token_from_request`), so it can end up in browser history, server
   logs, and Referer headers.
3. **Sharing is all-or-nothing:** the only way to hand someone a file today is
   the public folder or the report publish toggle — there is no scoped,
   expiring link.

The question: is URL-everything inherently unsafe, or can we keep it fully and
fix the credential model?

## Decision

Keep URL-everything unchanged. Replace the single ambient credential with a
**capability split** — the pattern behind `googleusercontent.com`:

1. **Master token → HttpOnly, host-only cookie** on the dashboard host only.
   Page JavaScript can never read it; it is never valid on content-serving
   origins. (The terminal's localStorage mirror is replaced by cookie-auth on
   the WebSocket.)
2. **Content credential for file subdomains:** a *derived*, read-only
   credential (separate cookie, minted from the master session) that can fetch
   files and nothing else — it cannot reach the terminal, the API's mutating
   routes, or the cockpit. XSS in a served page downgrades from "owns the box"
   to "can read files the owner can read", and step 3 narrows even that story
   for shared links.
3. **Signed URLs for sharing:** sharing a file mints a short-lived,
   HMAC-signed, per-path link (`?sig=…&exp=…`, S3-presigned style) — expiring
   and revocable. A leaked share link exposes one file for minutes, not the
   box. This *improves* the sharing UX over the public-folder toggle.
4. **Kill `?token=` master acceptance.** A token in a URL is accepted exactly
   once (enrollment-style): set the cookie, redirect with the query scrubbed.
   Logs never see a live master token.
5. **Private-by-default stands:** Tailscale/localhost unless `--public`;
   `OWNER_TOKEN` mandatory on any public bind (already enforced).

## Why (state of the world on 2026-07-02)

- **The risk was never the URLs.** URL-per-file is the Google Drive model; the
  danger is a *master* credential that is simultaneously (a) JS-readable,
  (b) valid on origins serving untrusted (agent-generated) content, and
  (c) long-lived. Fixing the credential keeps 100% of the feature.
- **The audience will check.** HN 2025–26 is primed on agent-security horror
  stories. Our launch frame is "the agents add zero new privilege — the only
  new surface is the cockpit"; that argument only holds if the cockpit's
  credential model survives scrutiny. The predictable top comment — "one
  leaked cookie and your box is owned, and you serve agent HTML on your own
  domain" — is precisely flaw #1, and today the commenter would be right.
- **Prior art is settled.** Serving user content on a cookie-isolated origin
  (googleusercontent, githubusercontent) and presigned URLs (S3) are
  boring, well-understood mechanisms — no invention required, ~1 week of work
  including tests.

## What would make us revisit

1. **Real-world friction:** if the derived-credential handoff breaks
   legitimate flows (e.g. cockpit iframes, the Monaco editor, port-forwarded
   apps needing owner context), reassess the split's granularity — not the
   principle that the master token stays out of JS and URLs.
2. **Browsers ship a better primitive** (e.g. broadly-supported
   origin-bound cookies / Storage Access changes) that achieves the isolation
   more simply.
3. **Multi-user sharing needs** (shared folders with other people) outgrow
   signed URLs → revisit with real per-identity auth, not by widening the
   owner token.

## Consequences

- Roadmap item **B2 (~1 wk)**: implement the split; rewrite the relevant parts
  of SECURITY.md around it; add tests (cookie flags, content-credential scope,
  signature expiry/revocation, traversal + dotfile-block regression).
- The dashboard/terminal/cockpit must stop reading the token from
  `localStorage`/`document.cookie`; enrollment sets the HttpOnly cookie and
  the pages operate credential-blind.
- Share UX changes for the better: "copy link" mints a signed URL with a
  chosen TTL; the report publish toggle can be reimplemented on top of it.
- Launch post gains a defensible sentence: "the master token is never readable
  by page JavaScript and never appears in a URL; sharing mints a short-lived
  signed link."

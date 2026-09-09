# Named app routes: `<name>.<APP_DOMAIN>` for a long-lived app

**Date:** 2026-09-09
**Status:** accepted, shipped in v0.1.23

## Context

An app on port 3000 is reachable at `https://<owner>-3000.<APP_DOMAIN>`. That
URL is tied to the port: move the app to another port and the URL, the
installed PWA and its localStorage all break. The motivating case is
`~/inkling`, a PWA plus a Node server that should live at one stable address.

Two designs were on the table:

1. **A path on the dashboard host** (`https://<APP_DOMAIN>/inkling/`).
   Rejected. Owner files on the main host are served with a sandbox CSP
   (docs/decisions/20260717-served-content-sandbox.md) precisely because that
   origin holds the master cookie. A real origin there for app HTML would let
   any served page ride that cookie into the terminal WebSocket and
   `/api/auth/enroll`. Path routing on the main host would have to weaken the
   sandbox to work, so it is out.
2. **A subdomain that resolves to a port** (`https://inkling.<APP_DOMAIN>`).
   Chosen. Content already lives on subdomains; the split-credential model
   (docs/decisions/20260702-split-credentials.md) puts only the derived files
   credential there, and the master cookie is host-only on the dashboard.

The PRD proposed `<name>.<owner>.<APP_DOMAIN>`. On a typical box `APP_DOMAIN`
already carries the owner (`alice.example.com`), so that form yields
`inkling.alice.alice.example.com`, and a second label level
needs its own wildcard DNS record and wildcard certificate. `<name>.<APP_DOMAIN>`
sits at the same level as `<owner>-3000.<APP_DOMAIN>`: the existing `*.APP_DOMAIN`
DNS record, the Caddy wildcard site and the on-demand TLS hook cover it with no
DNS or proxy change.

## Decision

- **A name is a pointer to a port, nothing more.** `api/services/app_routes.py`
  keeps `{name: port}` in memory, persisted next to the public-ports state
  (`DATA_DIR/<user>/app_routes.json`). Visibility (private, share link, public)
  belongs to the port; a name inherits it.
- **Resolution happens before the gate.** `proxy.resolve_host()` maps a host to
  `(username, port)`: a bare label that is a registered name becomes
  `(OWNER_USERNAME, port)`. Everything downstream, HTTP and WebSocket, runs the
  same `_authorize`, the same public-port check and the same share-cookie logic
  as `<owner>-<port>`. There is no named-route branch in the gate.
- **Origin trust follows resolution.** `_origin_is_owner_app_sibling` resolves
  the origin host the same way, so a frontend on a named host may call its
  backend on another owner app port and vice versa. The file host and reserved
  ports stay excluded.
- **Names are validated against everything ShellTeam serves.** 2 to 32 chars,
  lowercase letters, digits, hyphens, no edge hyphen; the owner label, the
  reserved labels (`www api app mail admin static files public reports cockpit
  guest share`) and any `<label>-<digits>` shape (the port-preview pattern) are
  refused. Ports must be app ports (>= 1024, not `FILE_PORT`, not a ShellTeam
  service port). At most 20 names, because each one may trigger a certificate.
- **TLS on demand only for registered names.** `GET /internal/check-domain`
  accepts `<name>.<APP_DOMAIN>` only while the name is registered, so a stranger
  cannot burn the ACME quota with made-up hostnames (the M4 lesson).
- **Two APIs, one service.** Agents use `/internal/apps` (same HMAC auth as the
  ports API); the Settings card uses `/api/computers/apps` (owner cookie, CSRF
  guarded on mutations). `/internal/ports/share` accepts `{"name": ...}` and
  mints the link on the named host; the signature still binds the port, so a
  link minted for the port host also works on the name.
- **Unregistered labels keep their old meaning** (a username on the file port),
  so nothing that worked before changes.

## What would make us revisit

- A second owner label on one box (multi-user). Then a name must be scoped per
  owner and the `<name>.<owner>.<APP_DOMAIN>` form, with its DNS and wildcard
  cost, becomes worth it.
- A need for names on custom domains (`inkling.example.org`). That is a Caddy
  and DNS question first; the registry would gain a `host` field.
- Let's Encrypt rate pressure from many names. Raise or lower `MAX_APP_ROUTES`
  or move to a wildcard certificate.

## Consequences

- The agent persona teaches the named form for anything long-lived; the port
  form stays for quick previews.
- `SECURITY.md` records that a name is never a new trust edge.
- Tests (`tests/test_app_routes.py`) pin name validation, HTTP and WS
  resolution, auth parity with the port host across every credential, sibling
  trust, the TLS refusal for unregistered names, and that the main-host sandbox
  CSP is untouched.

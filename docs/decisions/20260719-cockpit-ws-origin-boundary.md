# Origin, not method, is the files-credential boundary off the file host

**Date:** 2026-07-19
**Status:** Accepted — supersedes the M1 remedy in
[20260718-security-audit-hardening.md](20260718-security-audit-hardening.md)

## Context

M1 of the 2026-07-18 grey-box audit tightened the derived `shellteam_files`
credential to be **read-only on every port**, not just `FILE_PORT`. The stated
threat: a files-cred `POST`/WS upgrade on the cockpit port (3456) could reach
`/ws/shell` and the cockpit write API, escalating a read-only credential toward
file-write / RCE.

That change shipped in `1d9aae5` and **took the cockpit down on every deploy with
`OWNER_TOKEN` set**, including this box, for ~10 hours.

The reason is structural. The dashboard embeds the cockpit as a **cross-origin
sibling** at `<owner>-<AI_CHAT_PORT>.<APP_DOMAIN>` (`api/main.py:_cockpit_url`).
The master `shellteam_token` cookie is **host-only on the dashboard origin**, so
it never reaches that subdomain. The files credential is therefore the *only*
credential the cockpit iframe carries — its own WebSocket authenticates with it.
Refusing every non-read method on every port refused the cockpit's own socket.

The failure mode was quiet in exactly the wrong way: `GET` still passed, so the
iframe **loaded** and the UI looked alive; only the socket was dead. The employee
cockpits (3470/3471, `org` module) broke identically.

## Decision

Split the boundary by port, because the two ports have genuinely different risks:

- **`FILE_PORT`** — strictly read-only, from any origin. The files credential
  must never write the owner's files. (Unchanged.)
- **Every other port (cockpit, agent apps)** — **Origin** is the boundary, not
  method. Non-read methods are allowed from a trusted origin, and additionally
  require an **explicitly present** Origin: browsers always attach Origin to
  WS/POST/fetch, so a header-less mutation is never a legitimate browser flow.
  Reads keep the lenient no-Origin rule, since header-less top-level navigations
  are how files and app previews get opened.

This is strictly tighter than the pre-M1 behaviour (which allowed header-less
mutations) while restoring the cockpit.

## Why this is safe — M1's threat is covered by Origin, not by method

M1's escalation is an XSS'd served page riding the ambient cookie into the
cockpit. That page is cross-origin to the cockpit subdomain and is refused by
`_origin_trusted`. Crucially, served user content is **origin-sandboxed**
([20260717-served-content-sandbox.md](20260717-served-content-sandbox.md)): it
gets `Content-Security-Policy: sandbox …` **without** `allow-same-origin`, so it
runs in an opaque origin and its Origin header is `null` — refused. Verified live:

```
Origin: https://<cockpit-host>   (cockpit's own socket)  → ok
Origin: null                     (sandboxed served page) → forbidden
Origin: https://<file-subdomain>                         → forbidden
POST/PUT/WS on FILE_PORT, any origin                     → forbidden
```

The residual M1 case is a **non-browser** client that exfiltrated the HttpOnly
cookie — such a client can forge any Origin header, so the origin gate does not
bind it. What closes this residual is that the credential has **no exfiltration
path** (verified 2026-07-19, pinned by `TestSessionCookiesNeverReachUpstreams`):
it is HttpOnly (no page JS), `_sanitize_forwarded_headers` strips all
`_SESSION_COOKIES` before HTTP forwarding to proxied apps, and the WS proxy
connects upstream with no browser-derived headers at all. The "mutations require
an explicit Origin" rule additionally blocks accidental non-browser use.

## Considered and deferred: a third, cockpit-scoped credential

A strictly stronger design exists: mint a separate strong credential host-only on
the cockpit subdomain (delivered via a one-time signed redeem in the iframe URL,
the pattern `?token=` and share links already use). Then the files credential
could be read-only *everywhere* — M1's rule made correct by architecture.

Deferred deliberately, not as a compromise: the extra credential only defends
against an attacker who already holds a cookie that has no known leak path (see
above), while it adds real machinery — cross-origin mint/redeem/rotation, iframe
wiring, employee-cockpit variants — to the security-critical path. This incident
is itself the case study: the outage came from tightening machinery whose
architecture wasn't fully mapped. If any leak path for the session cookies ever
appears (e.g. header pass-through to upstreams), implement the scoped credential
rather than patching the leak.

## Why the tests didn't catch it

This is the important part. The suite was **green while the product was down**,
because the M1 tests asserted the security property *in isolation*
(`test_cockpit_port_reads_ok_but_never_writes` literally asserted the cockpit's
WS was forbidden). Nothing tied that assertion back to *"the cockpit URL the
dashboard embeds must work with the credential a browser holds at that URL."*

A second trap made manual verification lie: **verifying from the box is a false
pass.** The H1 in-box-trust branch keys on uvicorn's validated peer, so a
`curl`/WS probe run on the VPS short-circuits before `_authorize` ever runs. The
cockpit reports healthy from the box and is refused for every real browser. Two
of the probes taken while diagnosing this passed for exactly that reason.

Guards added (each verified to fail without the fix):

| Test | Pins |
|---|---|
| `TestCockpitReachableWithBrowserCredential` | derives the cockpit host the way `_cockpit_url` does and asserts its WS authorizes with the files cred — couples security rule to product invariant |
| `test_ws_cockpit_from_external_browser_passes_auth` | drives the **full** `proxy_websocket` path with an **external** peer, so in-box trust cannot mask the gate |
| `test_cockpit_port_mutation_requires_an_explicit_origin` | the header-less-mutation tightening |
| `test_file_host_stays_strictly_read_only` | `FILE_PORT` invariant survives the loosening |

## Consequences

- Agent-built apps on forwarded ports can again accept `POST` from their own
  origin — they are full web apps and were collaterally broken by M1.
- The sandbox CSP on served content is now **load-bearing for the auth model**,
  not just defense-in-depth. Weakening it (e.g. adding `allow-same-origin`, as
  the `/guest` exemption in `03045e2` does) re-opens M1's path — any such
  exemption must not be served on an origin that can reach a cockpit port.

## Revisit if

- The cockpit stops being a cross-origin sibling (e.g. served same-origin behind
  the dashboard, or given its own scoped credential) — then the files credential
  no longer needs non-read power anywhere and M1's blanket rule becomes correct.
- The served-content sandbox is relaxed or bypassed for any content origin.

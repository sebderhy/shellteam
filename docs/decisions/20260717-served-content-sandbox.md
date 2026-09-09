# 2026-07-17 — Origin-sandbox served content on the main domain

## Context

ShellTeam serves the owner's files as **main-domain paths**
(`https://APP_DOMAIN/tmp/report.html`, `docs/decisions/20260702-main-domain-file-urls.md`).
That is deliberate — it is the URL convention the agent persona teaches and it
avoids the double-subdomain (`seb.seb.…`) form. But it means agent-generated or
`~/public` HTML runs on **the same origin as the dashboard**.

The master session cookie (`shellteam_token`) is `HttpOnly`, host-only,
`SameSite=Lax` (`api/services/auth.py`). `HttpOnly` stops page JS from *reading*
it, but a same-site request still **rides** it. A pre-launch security review
(auth/proxy/credential surface, 2026-07-17) confirmed the resulting chain:

- Untrusted content reaches the dashboard origin two realistic ways — an agent
  renders scraped / prompt-injected third-party data into a report the owner
  opens, or attacker-influenced HTML lands in `~/public` and the owner is lured
  to open it.
- From there a `fetch`/WebSocket to a same-origin capability sink carries the
  ambient master cookie: the terminal WS (`/api/terminal` → a host shell),
  `POST /api/auth/enroll` (**mints a durable device session** → persistent
  takeover, not just "while the tab is open"), `GET /api/auth/share`, and
  `/_api/` file writes. None had an Origin/CSRF defense; CORS is irrelevant
  because the attack is same-origin.

`SECURITY.md` had acknowledged a weaker version of this ("can act as you while the
tab is open… can no longer steal a durable credential") — but `/api/auth/enroll`
*does* let a durable credential be minted, so the residual was understated.

## Decision

Two complementary layers, both cheap and self-contained:

1. **Content sandbox (primary).** Every HTML document served through the
   main-host file catch-all is stamped with
   `Content-Security-Policy: sandbox allow-scripts allow-popups
   allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals`
   (`api/main.py:_wants_content_sandbox` + the `security_headers` middleware).
   Withholding `allow-same-origin` forces the document into an **opaque origin**:
   interactive reports still run JS, submit forms, and open links, but the browser
   no longer treats them as `APP_DOMAIN`, so the host-only master cookie is never
   attached to their subresource fetches or WebSocket upgrades. ShellTeam's own
   first-party pages are exempt (`_TRUSTED_FILE_UI_PREFIXES`: the Monaco editor,
   `/_ls`, `/_files`, `/_api`, and the master-gated cockpit proxy), because they
   need the real origin to make credentialed fetches.

2. **Origin allow-list on the sinks (defense-in-depth).** The terminal WS,
   `/api/auth/enroll`, `/api/auth/share` (+ `/guest-link`), and main-host file
   writes now reject any *present* browser `Origin` that is not a dashboard
   (`MAIN_HOSTS`) host — a sandboxed document sends `Origin: null`, a content
   subdomain sends `owner.APP_DOMAIN`, an external site sends its own host
   (`auth.origin_is_trusted` / `dependencies.require_trusted_origin`). Absent
   Origin is allowed (non-browser tooling; the attack needs a browser, which
   always sends Origin on these). This holds even if a browser ever mishandled
   the sandbox header.

## Consequences

- The concrete RCE + persistent-takeover chain the review found is closed; the
  residual shrinks to a same-origin bug in ShellTeam's *own* first-party pages.
- **UX cost:** a **private** report referencing a **private** sibling asset
  (`report.html` → `chart.png` under `~/reports`) won't load the asset — the
  opaque-origin page can't send the read cookie. Mitigation: inline the asset
  (data URI, the persona's default) or publish the report. Public reports and
  self-contained reports (the common case) are unaffected; public siblings need
  no cookie.
- The GitHub connect widget was moved to a same-origin, master-gated proxy
  (`/api/computers/cockpit/…`) as part of this change — it no longer depends on
  wildcard DNS, and being exempt from the sandbox it keeps its credentialed
  fetches.

## What would make us revisit

- Moving file serving to a **separate content domain** (googleusercontent-style)
  would give true origin isolation and let us drop the sandbox constraint on
  reports (restoring private multi-file reports). Tracked as a post-v1 candidate.
- If private multi-file reports become a common, load-bearing pattern before that
  lands, reconsider serving report subresources via the read-only files
  credential on a `SameSite=None` cookie (trade: a cross-site file-existence
  oracle) — rejected now as not worth the surface for a rare layout.

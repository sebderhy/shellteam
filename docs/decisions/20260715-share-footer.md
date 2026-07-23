# "Made with ShellTeam" footer on shared HTML — brand at the moment of sharing

**Date:** 2026-07-15
**Status:** Decided, shipped

## Context

Reports are ShellTeam's most-seen artifact: agents build HTML reports, the owner
publishes one with the panel's private→public toggle (or mints a signed share
link), and a third party views it. Every such view is a natural growth surface —
"what made this page?" is the first thing a curious viewer wonders (the loop that
built Typeform, Calendly, Notion's "Made with" badges).

Two candidate mechanisms were considered:

1. **A line in the persona prompt** ("always end reports with a Made-by footer").
   Rejected: stochastic (~85–95% compliance, drifts with model versions), and it
   brands the wrong tier — the prompt can't tell a private report from a published
   one, so it would stamp the owner's own private views with noise.
2. **Server-side injection at serve time**, only when a third party is the
   viewer. Chosen: deterministic, hits exactly the audience that matters, zero
   prompt surface, trivially toggleable.

## Decision

The proxy appends a small self-contained footer
(`Made with ShellTeam — your own AI cloud computer`, linking to shellteam.sh) to
**200 text/html responses served to third parties**:

- **published reports** (the private→public toggle, `api/services/reports.py`) —
  on both the canonical main-domain path and the legacy `<owner>.APP_DOMAIN` form;
- **signed share links** (`?sig=&exp=`).

Never badged:

- the **owner's own views** (any request carrying the master or files credential) —
  including their view of a report they published;
- **`~/public` hosting** — that's the user's own website (portfolio, demo);
  force-branding their content would be intrusive and wrong;
- anything non-HTML, non-200, HEAD requests, guest sandbox files (org surface).

The footer is inline-styled (`color:inherit; opacity:.55`) so it reads quietly on
dark and light reports alike, inserted before `</body>` (appended if absent), with
Content-Length recomputed.

**Kill switch:** `SHARE_FOOTER=false` in `.env` (default on). OSS norms demand
this — a self-hosted tool that force-brands output with no off switch draws
exactly the HN comment you'd expect.

## What would make us revisit

- Viewer complaints or evidence the footer harms report credibility → tone it
  down further or default off.
- A future rich share page (og-tags, preview card) could subsume the footer.
- If share-link HTML badging surprises users (it badges *any* shared HTML file,
  not just `~/reports/`), scope it to `reports/` paths.

## Consequences

- Every shared report is a small ShellTeam landing page at zero prompt cost.
- The injection point (`_append_share_footer` in `api/routers/proxy.py`) is the
  single place any future badge/preview logic hangs off.
- Regression pack: `tests/test_proxy.py::TestShareFooter` (9 tests: anonymous
  badged, owner clean, ~/public clean, sig-link badged, non-HTML untouched,
  kill switch, legacy subdomain, no-`</body>` fallback, Content-Length).

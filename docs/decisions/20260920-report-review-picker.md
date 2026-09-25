# 2026-09-20 — Review by pointing: comment on and edit elements of a served HTML file

## Context

The agent builds HTML reports and decks that open in the dashboard's side panel.
Reviewing them meant describing the target in words ("the second pricing card,
the paragraph under Team") or opening the source in the Monaco editor. Seb
asked whether to port the HTML editor of his other product (a report-writing
SaaS, ~3,400 lines) into ShellTeam to edit reports and decks here.

Facts weighed:

- That editor is welded to its own product (Auth0, per-user ownership paths,
  13 endpoints, a metered LLM chain for its AI pass, CDN libraries). Its AI pass
  is that product's paid differentiator, and ShellTeam is AGPL with the whole
  product in the repo.
- ShellTeam already has a review primitive: the cockpit's quote-to-comment tray
  (`> quote / --> comment`), and an agent that owns the file and the tools.
- The panel document is **origin-sandboxed** by design
  (`20260717-served-content-sandbox.md`): the dashboard cannot reach into its
  DOM, and the document cannot reach the file API.

## Decision

Do not port the editor. Build a ShellTeam-native pointer instead:

1. **Comment on an element.** A picker script (`frontend/review-picker.js`) is
   appended by the API to the **owner's own view** of content-sandboxed HTML
   (`api/services/report_review.py`, called from `proxy.serve_owner_file`). In
   comment mode the owner hovers, widens or narrows with the arrow keys, and
   clicks; the picker posts `{selector, text, html}` to the dashboard, which
   relays `{path, selector, text}` to the cockpit. The quote tray sends it as

   ```
   > reports/deck.html › section#pricing > div.card:nth-of-type(2) > p.lead
   > "Ninety euros per month for unlimited boxes."
   --> make this half as long
   ```

   The agent edits the file on the owner's subscription. No second model, no
   metered key, no new syntax for the agent.

2. **Edit text in place.** In edit mode a click makes the nearest block element
   `contenteditable`. On commit the dashboard calls
   `POST /api/computers/reports/edit` with the element's `innerHTML` before and
   after. The server replaces the snippet **only when it occurs exactly once**
   (byte-exact, then whitespace-insensitive); otherwise it answers 409 and the
   dashboard hands the edit to the agent as a comment ("Replace this text
   with: …") with a visible toast. Deterministic safety, LLM as the judgment
   fallback, never a silent guess.

### Security bounds kept

- The document stays opaque-origin; the picker's only channel is `postMessage`
  to its parent. The dashboard accepts picker messages only from the report
  frame's window and only ever shows the text back to the owner or asks the
  server to replace text the owner just saw.
- The edit route is `require_trusted_origin`-gated like publishing: a
  sandboxed page (`Origin: null`) can never drive a write. Paths go through
  `reports.resolve_report_path(owner_initiated=True)`: home-confined, no
  dotfiles.
- Visitors (signed share links, published pages) never receive the picker;
  the trusted file UI (`/_editor`) and non-HTML are untouched. The sandbox CSP
  header is unchanged.

### Not done (on purpose)

- No whole-document serialisation and rewrite (would bake inlined image data
  URIs into the source and normalise the markup). Edits are snippet replaces.
- No version history. Every applied edit is logged at INFO with the old and new
  snippet, and the agent has the file's history if it lives in git.
- The Reports tab's own preview iframe does not offer the buttons yet; the
  side panel (where the agent opens reports) does.
- Apps proxied into the panel (`<name>.APP_DOMAIN`) are not injected.

## What would make us revisit

- Owners commenting on apps in the panel, not only files: inject through the
  subdomain proxy as well.
- Frequent 409 hand-offs in the logs: the DOM-vs-source matching needs a
  source-mapping step (stable element ids stamped at generation time) rather
  than text search.
- Demand for real WYSIWYG (moving blocks, restyling): that is the point to
  extract a shared editor core with the sibling product, keeping the AI pass
  out of the AGPL repo.

## Consequences

- `tests/test_report_review.py` (delivery + edit contract),
  `computer/ai-chat/test/report-review-pointer.test.mjs` (tray, relay, picker
  bounds), and `tests/conftest.py` now scrubs `VISITOR_REDIRECT_URL` so a box
  with a landing redirect does not break anonymous shell tests.
- Ships in v0.1.29.

## Update 2026-09-25: apps on a port

The first revisit trigger fired. Seb opened his own site (an app on a port, served
at a named route) in the panel and every header button was dead: Comment and
Edit never appeared, Private and Share were disabled.

- The subdomain proxy now appends the picker to an app page when, and only when,
  the OWNER's own credential loads it into a frame (`GET`, `Sec-Fetch-Dest:
  iframe`, files cookie). That one document is buffered instead of streamed;
  every other app response (top-level visits, share-link visitors, anonymous
  hits on a public port, assets, APIs, SSE) is untouched.
- Comment sends the page URL as the pointer. Edit text has no file we can patch
  deterministically, so it always goes to the agent, which knows the app's
  source. Private toggles the port (`POST /api/computers/ports`, now origin-gated
  like publishing a file); Share mints the existing signed 24h port link.
- An app that sends its own strict CSP blocks the inline picker: the buttons
  then stay hidden, as before.

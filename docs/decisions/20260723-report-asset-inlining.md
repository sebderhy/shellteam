# 2026-07-23 — Inline report images at serve time (instead of weakening the content sandbox)

## Context

The content sandbox (`docs/decisions/20260717-served-content-sandbox.md`) stamps
every HTML document served through the main-host file catch-all with
`Content-Security-Policy: sandbox` **without** `allow-same-origin`. That forces
an opaque origin — the master cookie is never attached to the document's
fetches, which is the point.

Discovered side effect (owner report, 2026-07-22): an opaque origin makes the
browser treat **every subresource request as cross-origin**. The file server
sends no `Access-Control-Allow-Origin`, so all of a report's `<img>` refs are
CORS-blocked — reports with images render broken in a plain browser tab or via
a share link. They only worked inside the cockpit's side panel, whose iframe is
granted same-origin as a trusted first-party surface. Reproduced empirically on
the live box: even a same-URL `/public/...` image is blocked from a sandboxed
`/public/...` page (`Access to image … from origin 'null' has been blocked by
CORS policy`).

## Options considered

1. **Add `allow-same-origin` for "report" paths** — rejected outright. That
   re-opens the exact owner-shell-takeover chain the sandbox closed; the
   sandbox IS the security boundary.
2. **Send `Access-Control-Allow-Origin` on image responses** — fixes only the
   credential-less public case. A signed share link (`?sig=&exp=`) authorizes
   exactly one path — the HTML — so the sibling image requests still fail auth.
   Shared private reports (the most important audience) would stay broken.
3. **Serve-time inlining (chosen)** — rewrite qualifying relative `<img src>`
   refs to `data:` URIs while building the response. The bytes ride the single
   request that already passed auth, so owner view, public reports, and share
   links all work identically, and the CSP is untouched.

## Decision

`api/services/content_inline.py`, called from `serve_owner_file` only when the
response is main-host HTML that will receive the content sandbox (the predicate
is reused from `api.main`, late-imported — one definition). Bounds, each pinned
by `tests/test_content_inline.py`:

- **Relative refs only** — absolute paths, `//`, any scheme, and `data:` are
  left untouched.
- **Subtree-confined** — the resolved file must stay inside the document's own
  directory subtree (post-`resolve()`, so symlinks can't escape) and inside the
  owner home.
- **Dotfiles denied** on any segment, mirroring the file-server rule.
- **Image extensions only** (allowlist doubles as the mime map).
- **Size caps** — 8 MB per asset, 24 MB per document; every skip is logged.
- Failure to inline (missing file, unreadable, oversized) serves the original
  ref — a report is never 500'd by its images.

## Security review of the residual

Inlining changes one information flow: a sandboxed page's own JS can now read
the bytes of inlined sibling images (they're in its DOM), which the CORS block
previously prevented. Assessment: negligible widening — the images are, by
construction, files sitting next to the report (almost always produced by the
same agent run that wrote the report), and whoever authored the HTML could have
embedded the same bytes directly. The boundary that matters — no ambient
credential, no reach into the dashboard origin, no dotfiles, no files outside
the report's subtree — is unchanged. The share-link surface is also unchanged:
a recipient sees the images the report displays, which is what sharing a report
means.

Known limitation: the ORG guest file path (`_serve_guest_container_file`) does
not inline — guest-viewed reports with relative images still hit the CORS
block there. Scoped out deliberately (different home-dir resolution, read via
Docker); revisit if guests report it.

## What would make us revisit

- Reports needing non-image assets (CSS, JS, fonts) — would extend the
  allowlist + tags, same bounds.
- A future first-party "report viewer" route with its own trusted origin would
  obsolete inlining; until then this is the smallest safe fix.

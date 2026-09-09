# Owner-initiated publishing is not confined to ~/reports and ~/public

**Date:** 2026-08-04
**Status:** accepted

## Context

Since v0.1.7 (`20260728-no-ambient-public-grant.md`) nothing is world-readable
until it is explicitly published, and publishing was confined to two subtrees:

```python
PUBLISHABLE_SUBTREES = ("reports", "public")
```

That confinement exists because `SHELLTEAM_AI_TOKEN` is held by every in-box
agent — including a prompt-injected one — so an arbitrary-path publish would
be a one-call exfiltration primitive (`~/backup.sql` → public URL).

The rule was applied to *both* callers: the agent route (`/internal/reports`)
and the owner route (`POST /api/computers/reports`). For the owner it produced
a confusing product: `~/public` looked like a leftover of the old ambient
mount, and the obvious question ("why can't I just publish this file?") had no
good answer. Asked directly: *"What's the point of keeping this folder if we
are not automatically making everything there public? Shouldn't we just have a
button for files in the editor to make a file public?"*

Reviewing the route to answer that surfaced a second fact: the owner publish
route had **no `require_trusted_origin`**. `SameSite=lax` blocks cross-*site*
requests, but a content subdomain (`<name>.APP_DOMAIN`, where untrusted
agent-generated HTML is served) is *same-site* with the dashboard, so its
requests carry the master cookie. The subtree confinement was silently acting
as the blast-radius limit for that gap.

## Decision

1. **Origin-gate the owner publish route** (`require_trusted_origin`), like
   enroll/share/mirror-command. This is a fix in its own right and a
   precondition for 2.
2. **Split the rule by caller.** `resolve_report_path(..., owner_initiated=)`:
   - owner (cookie + dashboard origin): may publish anywhere under `$HOME`;
   - machine (`/internal/reports`): stays confined to `reports/` + `public/`.
   Dotfiles and anything outside home stay refused for both.
3. **Surface it in the editor**: a Private/Public toggle on the open file, with
   a confirmation before publishing and the link copied on success.

`~/public` keeps its meaning: the folder an **agent** may publish into without
asking the owner. That is now its actual, explainable purpose, rather than
looking like a vestige of the removed ambient grant.

## Reasoning

The threat that motivated confinement is an *agent* turning a private file
public without the owner knowing. A human clicking a button in their own
editor, on the dashboard origin, behind a confirmation, is not that threat —
it is the product. Keeping one rule for both callers meant paying the agent's
restriction on the owner's own action.

Origin-gating is what makes the split safe: without it, "owner-initiated"
would mean "anything holding the ambient cookie", which includes a page served
on a content subdomain.

## Consequences

- The owner can publish any non-dotfile in their home; exposure stays visible
  via `GET /api/computers/exposure` and the boot log.
- Agents cannot publish outside the two folders, unchanged.
- Any new publish caller must pass `owner_initiated` deliberately; the default
  stays confined.
- Tests: `tests/test_reports.py::TestPublishScopeByCaller` and
  `::TestPublishRouteIsOriginGated`.

## What would make us revisit

- A future multi-actor mode (guests, employees) where "owner-initiated" is no
  longer synonymous with "the one human": the flag would need to carry *which*
  actor, not just human-vs-machine.
- Evidence that owners publish sensitive files by accident — the answer would
  be a stronger confirmation (typing the filename) or an exposure digest, not
  re-confining the owner.

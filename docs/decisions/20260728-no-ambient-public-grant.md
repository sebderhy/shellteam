# 2026-07-28 — Remove the ambient `~/public` grant; publishing is the only path to a public URL

## Context

A pre-launch exposure audit (an independent agent, black-box + source) probed a
live box and found no bulk-enumeration path, no existence oracle, and a working
content sandbox. Its sharpest finding (F4) was not a hole in the gate but the
*shape* of publishing:

- `~/public` was mounted world-readable by filesystem location. A single
  `write()` to `~/public/x.html` — a stray `cp -r`, or a prompt-injected agent
  told "save your notes to ~/public/notes.html" — published to the open internet
  with no toggle, no confirmation, no record, and no way to review it after.
- It failed **open**: the failure mode of a mistake was exposure.
- On the maintainer's own box this had silently published three personal
  documents (home-purchase and school-choice notes), discovered only by the
  audit.

Seb, deciding this at the end of a long day, delegated the call: "I'm asking
myself if we should keep the public directory... please decide for me. If you
delete it, make sure the prompts/skills don't think it exists and the related
code is deleted too."

## Decision

Keep `~/public` as a **storage convention**, remove the **ambient grant**.

- `~/public` is no longer auto-mounted (`api/main.py`). A path under it is served
  only when it — or a parent directory — has been **explicitly published**
  through the owner-authenticated toggle (`api/services/reports.py`,
  `POST /api/computers/reports`). Writing a file there no longer exposes it.
- **Directories are publishable.** `is_report_public` matches an entry exactly or
  by segment prefix, so a static bundle with relative links (a logo set, a demo
  site) publishes in one action. Segment-prefix, never substring: `public/logos`
  never grants `public/logos-secret`.
- **URLs are unchanged.** `/(public|reports)/<path>` still works once published,
  so the mental model and any published links are preserved.
- **The injection-to-exfiltration path is closed structurally.** Publishing
  requires the master token, which in-box agents (holding only
  `SHELLTEAM_AI_TOKEN`) do not have. An agent can stage in `~/public` all it
  wants; the world-readable step is the owner's. This is deterministic
  host-side safety, not a prompt rule — consistent with "publication is an
  outward-facing, hard-to-reverse effect."

Shipped alongside (same audit, cheap and adjacent):

- **Loud migration.** On first boot after upgrade, existing top-level `~/public`
  content is auto-published so no live link breaks, and the full world-readable
  inventory is logged at WARNING (`migrate_ambient_public_grant`). Runs once.
- **Exposure inventory (F3).** `reports.exposure()` + `GET /api/computers/exposure`
  + a boot log line list every world-readable path with per-directory file
  counts. Exposure is no longer invisible.
- **noindex (F5).** Served home content carries `X-Robots-Tag: noindex, nofollow`;
  `/robots.txt` is served unauthenticated with `Disallow: /`. Confidentiality no
  longer rests solely on no inbound link existing.
- **Enumeration throttle (F6).** A dedicated 20/min/IP limiter on 401-producing
  file reads (`note_unpublished_read`), mirroring `auth_failure_limiter`; the
  private-vs-nonexistent 401 stays byte-identical (regression-tested).

## What would make us revisit

- If directory publishing proves too coarse (owners want per-file control inside
  a published dir), add an exclude list.
- If the split share-link vs publish-publicly UX (audit F2) lands, publishing
  gains a confirmation + reason; the storage/serving model here does not change.
- The `~/public`-agent-write path is closed by the missing master token, so a
  filesystem-level read-only overlay (the audit's stronger variant) was judged
  unnecessary. Revisit if a future agent path ever gains publish authority.

## Consequences

- Existing OSS boxes upgraded to 0.1.7 keep their links (migration) and gain an
  inventory for the first time.
- `_is_public_path` no longer treats `public/` as public; it consults the
  publish allowlist. The `/public` StaticFiles mount is gone. Persona
  (`computer/claude-config/CLAUDE.md`, `frontend-design` skill), `AGENTS.md`,
  and `docs/ARCHITECTURE.md` were corrected so no agent believes `~/public` is
  ambiently world-readable.
- `~/public` sites (portfolios, demos) are served without the "Made with
  ShellTeam" share footer even when published — they are sites, not shared
  report deliverables.

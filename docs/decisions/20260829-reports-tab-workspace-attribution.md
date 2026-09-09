# Reports tab: workspace attribution via transcript scan (SHE-84)

**Date:** 2026-08-29
**Status:** accepted

## Context

The dashboard gained a Reports tab (SHE-84): every report under `~/reports`,
one-click open, publish/share reusing the existing visibility flow. The owner's
stated way of finding a report again is "which folder was the agent in when it
made this" — but nothing on the box records that. Reports are plain files an
agent writes; there is no write-path hook, no manifest, and four different CLIs
produce them.

## Decision

Recover the workspace **after the fact from agent session transcripts** instead
of adding a write-time hook:

- Claude Code JSONLs (`~/.claude/projects/*/*.jsonl`) carry `cwd` on every
  line, and every Write/Edit tool call carries the report's `file_path` —
  authorship evidence.
- `api/services/report_catalog.py` scans transcript bytes with two C-speed
  regexes (first `"cwd"` value + every `"file_path": "…/reports/<path>"`
  write), maps each report **basename** to the cwd of the **earliest-mtime**
  transcript that wrote it (creation beats a later edit from another folder),
  and persists the map under `DATA_DIR/<owner>/reports_index.json` (versioned;
  a version bump discards and rebuilds) with a watermark so subsequent scans
  only read new/changed transcripts. First-ever scan of a ~1 GB corpus takes
  seconds and runs in FastAPI's threadpool.

### Amendment, same day: writes only, mentions are toxic

v1 of this design attributed on any textual `reports/<name>` **mention**. It
misattributed within hours: the QA session that verified the tab had the full
report listing in its own transcript and thereby claimed every unattributed
report for `~/shellteam`, and a morning chat that merely linked three dream
reports stole them into "Home". Discussion is not authorship. v2 attributes
**only on write evidence** and drops Codex scanning entirely (the real 486 MB
Codex corpus contains no report-write evidence to match — its rare reports
land in "Other" honestly). Index format bumped to v2 so polluted v1 indexes
self-heal on the next listing.
- Labels: top-level folder under home (`webshop`, `blog`), `~` itself →
  "Home", the dreaming pipeline's run dirs (and `dream-*` filenames) →
  "Dreaming", anything unclaimed → an explicit "Other" bucket.

The tab ships hidden and is revealed by a cheap probe
(`/api/computers/reports/list?probe=1`, file count only) — a fresh or
pure-core box keeps its untouched tab row, same pattern as Knowledge.

## Why not the alternatives

- **Write-time metadata (hook/manifest):** would only cover reports created
  after the feature ships, needs per-CLI hooks we deliberately don't inject
  (additive-layer rule), and still misses hand-written reports.
- **Asking the cockpit to record report-open events:** misses dreaming/cron
  reports and anything never opened from a chat.
- **HTML `<meta>` stamping at serve time:** mutates user content; against the
  serve-things-raw contract.

## Known bounds (stated, not silent)

- Codex, OpenCode and Antigravity transcripts are not scanned; reports they
  produce, and reports written via plain shell commands (e.g. TTS mp3s from
  ffmpeg), land in "Other". Logged in `refresh_attribution`'s docstring.
- Attribution is keyed by basename: two reports with the same basename in
  different subfolders share one attribution; a renamed report loses its claim
  (observed live: a typo-fix rename orphaned one report's attribution).
- Transcript retention bounds history: reports whose creating session Claude
  no longer stores (on the dev box, roughly everything older than a few weeks
  plus all output of a headless cron job) cannot be attributed and stay in
  "Other".

## Revisit when

- A report-writing convention gains real metadata (e.g. agents write a
  `.meta.json` next to reports) — then the scan becomes the fallback.
- OpenCode/Antigravity report production becomes common on real boxes.

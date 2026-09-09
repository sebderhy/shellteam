"""Catalog of the owner's reports: listing + workspace attribution.

Backs the dashboard's Reports tab (SHE-84). A report is a document under
``~/reports`` (the persona-layer convention). Two jobs:

1. **Listing** — every report file with title, mtime, size (visibility is
   merged in by the router from ``reports.py``, which stays the single owner
   of publish state).
2. **Workspace attribution** — which folder the agent was working in when it
   produced each report, so the tab can group "webshop reports" vs "blog
   reports". Nothing on the box records this at write time, but Claude Code
   transcripts do: JSONLs carry ``cwd`` on every line, and a Write/Edit tool
   call carries the report's path as ``file_path`` — authorship evidence. We
   scan transcripts for those write calls, map each basename to the cwd of
   the earliest transcript that wrote it, and persist the mapping so
   subsequent scans only read transcripts modified since the last watermark.

   Heuristic by design: a report renamed on disk, or produced by an unscanned
   CLI (Codex/OpenCode/Antigravity) or by plain shell commands, simply lands
   in the "unattributed" bucket; nothing breaks. Textual MENTIONS deliberately
   do not attribute — see ``_WRITE_RE`` for the incident that taught us.

See docs/decisions/20260829-reports-tab-workspace-attribution.md.
"""

import html as html_mod
import json
import logging
import re
import time
from pathlib import Path

from api.config import DATA_DIR

log = logging.getLogger(__name__)

_INDEX_FILENAME = "reports_index.json"

# Document types that count as a report. Images are excluded on purpose: they
# are almost always assets referenced BY a report, not reports themselves.
REPORT_EXTS = {".html", ".md", ".pdf", ".mp3", ".mp4", ".wav"}

# The label every report falls back to when no transcript claims it.
UNATTRIBUTED = ""

# AUTHORSHIP evidence only: the report path appearing as a Write/Edit tool
# ``file_path`` in a Claude transcript. The first design matched any textual
# mention of ``reports/<name>`` — that misattributed within hours of shipping:
# a QA session that merely LISTED the reports claimed every unattributed one,
# and a morning chat that linked a dream report stole it into "Home".
# Discussion is not authorship; only a write is. Matched on raw bytes so a
# 400 MB transcript corpus scans at C-regex speed without JSON-parsing every
# line. Attribution is keyed by BASENAME (the last segment), so a write of
# ``reports/sub/b.md`` claims ``b.md``.
_WRITE_RE = re.compile(
    rb'"file_path"\s*:\s*"(?:[^"]*/)?reports/((?:[A-Za-z0-9][A-Za-z0-9._\-]*/)*'
    rb'[A-Za-z0-9][A-Za-z0-9._\-]*\.(?:html|md|pdf|mp3|mp4|wav))"'
)
_CWD_RE = re.compile(rb'"cwd"\s*:\s*"([^"]+)"')

# Bump when the attribution semantics change: a loaded index of a different
# version is discarded and rebuilt from scratch on the next listing (v1 indexes
# were mention-based and carry stolen attributions).
_INDEX_VERSION = 2

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_MD_HEADING_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)


def _report_files(reports_dir: Path):
    """Every report file under ``~/reports``, recursively.

    Dotfiles are never reports; anything inside a directory named ``assets``
    is a report's resource bundle, not a report.
    """
    for f in sorted(reports_dir.rglob("*")):
        if not f.is_file() or f.suffix.lower() not in REPORT_EXTS:
            continue
        rel_parts = f.relative_to(reports_dir).parts
        if any(p.startswith(".") for p in rel_parts):
            continue
        if "assets" in rel_parts[:-1]:
            continue
        yield f


def count_reports(home_dir: Path) -> int:
    """Cheap probe for the dashboard: does the box have any reports at all?"""
    reports_dir = home_dir / "reports"
    if not reports_dir.is_dir():
        return 0
    return sum(1 for _ in _report_files(reports_dir))


def _title_of(f: Path) -> str | None:
    """Human title of a report: the HTML <title> or the first Markdown H1."""
    suffix = f.suffix.lower()
    if suffix not in (".html", ".md"):
        return None
    head = f.read_text(encoding="utf-8", errors="replace")[:8192]
    m = _TITLE_RE.search(head) if suffix == ".html" else _MD_HEADING_RE.search(head)
    if not m:
        return None
    title = html_mod.unescape(re.sub(r"\s+", " ", m.group(1))).strip()
    return title or None


def _workspace_label(cwd: str, home: Path) -> str:
    """Group label for an agent cwd: the top-level folder under home.

    ``~`` itself → "Home"; the dreaming pipeline's run dirs → "Dreaming";
    a cwd outside home keeps its basename so it still groups meaningfully.
    """
    try:
        rel = Path(cwd).resolve().relative_to(home)
    except ValueError:
        return Path(cwd).name or cwd
    if not rel.parts:
        return "Home"
    top = rel.parts[0]
    if top == ".shellteam" and "dream" in rel.parts:
        return "Dreaming"
    if top.startswith("."):
        return "Home"
    return top


def _transcripts(home: Path):
    # Claude transcripts only: they carry cwd on every line and Write tool
    # calls with file_path (authorship). Codex rollouts were checked against
    # the real corpus (486 MB) and contain no report-write evidence — agents
    # there write via shell in forms too varied to match honestly. Reports
    # produced by Codex/OpenCode/Antigravity land in the "Other" bucket.
    claude = home / ".claude" / "projects"
    if claude.is_dir():
        yield from claude.glob("*/*.jsonl")


def _index_path(user_id: str) -> Path:
    return DATA_DIR / user_id / _INDEX_FILENAME


def _load_index(user_id: str) -> dict:
    path = _index_path(user_id)
    empty = {"v": _INDEX_VERSION, "watermark": 0.0, "attribution": {}}
    if not path.exists():
        return empty
    try:
        idx = json.loads(path.read_text())
        if idx.get("v") != _INDEX_VERSION:
            log.info("Reports index %s is v%s — rebuilding as v%d",
                     path, idx.get("v"), _INDEX_VERSION)
            return empty
        return {
            "v": _INDEX_VERSION,
            "watermark": float(idx.get("watermark", 0.0)),
            "attribution": dict(idx.get("attribution", {})),
        }
    except (json.JSONDecodeError, TypeError, ValueError):
        log.warning("Invalid %s — rebuilding attribution from scratch", path)
        return empty


def refresh_attribution(user_id: str, home: Path) -> dict[str, dict]:
    """Update the basename → {cwd, ts} attribution map from agent transcripts.

    Incremental: only transcripts modified since the stored watermark are
    read. Only WRITE evidence attributes (see ``_WRITE_RE``); among writers,
    the earliest-mtime transcript keeps the claim (creation beats a later
    edit by another workspace). Reports written by Codex/OpenCode/Antigravity
    or by plain shell commands stay unattributed — a coverage bound, stated
    rather than silent.
    """
    idx = _load_index(user_id)
    watermark = idx["watermark"]
    attribution = idx["attribution"]
    scan_start = time.time()
    scanned = writes = 0

    for f in _transcripts(home):
        mtime = f.stat().st_mtime
        if mtime <= watermark:
            continue
        data = f.read_bytes()
        scanned += 1
        cwd_match = _CWD_RE.search(data)
        if not cwd_match:
            continue
        cwd = cwd_match.group(1).decode("utf-8", errors="replace")
        for m in set(_WRITE_RE.findall(data)):
            basename = m.decode("utf-8", errors="replace").rsplit("/", 1)[-1]
            writes += 1
            current = attribution.get(basename)
            if current is None or mtime < current["ts"]:
                attribution[basename] = {"cwd": cwd, "ts": mtime}

    if scanned:
        path = _index_path(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(
            {"v": _INDEX_VERSION, "watermark": scan_start, "attribution": attribution}
        ))
    log.info(
        "Report attribution: scanned %d transcript(s) (>%s), %d write(s), "
        "%d attributed basename(s), %.1fs",
        scanned, watermark, writes, len(attribution), time.time() - scan_start,
    )
    return attribution


def list_reports(user_id: str, home_dir: Path) -> list[dict]:
    """Every report under ``~/reports``, newest first, with workspace labels."""
    home = home_dir.resolve()
    reports_dir = home / "reports"
    if not reports_dir.is_dir():
        return []
    attribution = refresh_attribution(user_id, home)
    entries: list[dict] = []
    for f in _report_files(reports_dir):
        st = f.stat()
        attributed = attribution.get(f.name)
        workspace = _workspace_label(attributed["cwd"], home) if attributed else UNATTRIBUTED
        # Nightly dream reports name themselves deterministically — attribute
        # them even when their transcript predates the scan window.
        if workspace == UNATTRIBUTED and f.name.startswith("dream-"):
            workspace = "Dreaming"
        entries.append({
            "path": f.relative_to(home).as_posix(),
            "name": f.name,
            "title": _title_of(f),
            "mtime": int(st.st_mtime),
            "size": st.st_size,
            "kind": f.suffix.lower().lstrip("."),
            "workspace": workspace,
        })
    entries.sort(key=lambda e: e["mtime"], reverse=True)
    return entries

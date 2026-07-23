"""Per-file public visibility for generated reports.

A "report" is just an HTML file under the owner's home (by convention
``~/reports/…``). By default it is owner-only — served only to the authenticated
owner, exactly like the rest of ``$HOME``. Publishing a report adds its
home-relative path to this allowlist; the subdomain proxy then serves that one
path without cookie auth, at the **same URL** (no file move, no copy). Un-publish
removes it. This mirrors the private→public model in ``ports.py``.

State is an in-memory set for O(1) lookups on every proxy request, persisted to
disk so it survives API restarts.

Pattern: module-level dict + functions (same as ``ports.py``).
"""

import json
import logging
import os
from pathlib import Path

from api.config import DATA_DIR

log = logging.getLogger(__name__)

# Generous guardrail: each published report is a world-readable URL, so cap the
# blast radius the way ports.py caps public ports — but high enough to never
# annoy in practice.
MAX_PUBLIC_REPORTS = int(os.environ.get("MAX_PUBLIC_REPORTS", "100"))
_FILENAME = "public_reports.json"

# {user_id: set[relpath]} — relpath is home-relative, POSIX, no leading slash.
_public_reports: dict[str, set[str]] = {}


# A published report becomes a world-readable, cookie-less URL. Publishing is
# therefore confined to the two subtrees a report legitimately lives in — the
# reports convention and the already-public folder — so a holder of
# SHELLTEAM_AI_TOKEN (every in-box agent, including a prompt-injected one) cannot
# turn an arbitrary home file (`~/backup.sql`, `~/id_rsa` — no leading dot, so the
# dotfile guard alone wouldn't catch it) into a public URL (M3).
PUBLISHABLE_SUBTREES = ("reports", "public")


def _is_publishable_subtree(rel: str) -> bool:
    return any(rel == d or rel.startswith(d + "/") for d in PUBLISHABLE_SUBTREES)


def _norm(relpath: str) -> str:
    """Normalize a home-relative report path: strip leading slashes, collapse.

    Rejects traversal (``..``), absolute paths, and dotfile segments — a published
    path must stay inside the owner's home and never expose a dotfile (L5).
    """
    p = relpath.strip().lstrip("/")
    if not p:
        raise ValueError("Empty report path")
    parts = Path(p).parts
    if ".." in parts:
        raise ValueError(f"Illegal report path: {relpath}")
    if any(seg.startswith(".") for seg in parts):
        raise ValueError(f"Dotfiles cannot be published: {relpath}")
    return Path(*parts).as_posix()


def resolve_report_path(home_dir: Path, path: str) -> str:
    """Resolve a report path to a home-relative POSIX path, confined to ``home_dir``.

    Accepts a home-relative path (``reports/x.html``) or an absolute path under
    home. Raises ``ValueError`` on traversal / outside-home, ``FileNotFoundError``
    if the file doesn't exist. Shared by the internal + owner-facing routes.
    """
    home = home_dir.resolve()
    raw = path.strip()
    # A report path is normally a URL pathname (home-relative, maybe leading-slash);
    # a fully-qualified path under home is also accepted. We distinguish the two by
    # whether it's already rooted at home — so "/reports/x.html" is treated as
    # home-relative, not as the filesystem root.
    if raw.startswith(str(home) + "/") or raw == str(home):
        abs_path = Path(raw).resolve()
    else:
        abs_path = (home / raw.lstrip("/")).resolve()
    if abs_path != home and home not in abs_path.parents:
        raise ValueError("Path is outside the owner's home")
    rel = abs_path.relative_to(home).as_posix()
    if not _is_publishable_subtree(rel):
        raise ValueError("Only files under reports/ or public/ can be published")
    if any(seg.startswith(".") for seg in Path(rel).parts):
        raise ValueError("Dotfiles cannot be published")
    if not abs_path.is_file():
        raise FileNotFoundError("Report file not found")
    return rel


def is_report_public(user_id: str, relpath: str) -> bool:
    if not relpath:
        return False
    return relpath.lstrip("/") in _public_reports.get(user_id, set())


def get_public_reports(user_id: str) -> set[str]:
    return set(_public_reports.get(user_id, set()))


def set_report_visibility(user_id: str, relpath: str, public: bool) -> set[str]:
    """Toggle a report's public visibility. Returns the updated set of public paths.

    Raises ValueError on an illegal path or when publishing would exceed
    MAX_PUBLIC_REPORTS.
    """
    rel = _norm(relpath)
    current = _public_reports.get(user_id, set())

    if public:
        if rel not in current and len(current) >= MAX_PUBLIC_REPORTS:
            raise ValueError(f"Maximum of {MAX_PUBLIC_REPORTS} public reports reached")
        current = current | {rel}
        log.info("report published user_id=%s path=%s", user_id, rel)
    else:
        current = current - {rel}
        log.info("report unpublished user_id=%s path=%s", user_id, rel)

    if current:
        _public_reports[user_id] = current
    else:
        _public_reports.pop(user_id, None)

    _persist(user_id, current)
    return set(current)


def _persist(user_id: str, reports: set[str]) -> None:
    path = DATA_DIR / user_id / _FILENAME
    if not reports:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sorted(reports)))


def seed_from_disk() -> int:
    """Load all public_reports.json files from disk. Returns count of users loaded."""
    count = 0
    if not DATA_DIR.exists():
        return count
    for user_dir in DATA_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        path = user_dir / _FILENAME
        if not path.exists():
            continue
        try:
            reports = set(json.loads(path.read_text()))
            if reports:
                _public_reports[user_dir.name] = reports
                count += 1
        except (json.JSONDecodeError, TypeError):
            log.warning("Invalid %s for user %s", _FILENAME, user_dir.name)
    log.info("Loaded public reports for %d users", count)
    return count

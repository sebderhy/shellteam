"""Review-by-pointing on served HTML (docs/decisions/20260920-report-review-picker.md).

Two halves:

- ``inject_picker`` appends ``frontend/review-picker.js`` to the OWNER's own view
  of a content-sandboxed HTML file, so the side panel can offer "comment on this
  element" and "edit this text". Visitors (signed links, published pages) never
  receive it: it is a review tool for the person who owns the file.

- ``apply_text_edit`` is the deterministic save behind in-place text edits: the
  snippet the owner edited is replaced in the source file only when it occurs
  exactly once (byte-exact first, then whitespace-insensitive). Anything less
  certain is refused with ``EditNotApplicable`` and the dashboard hands the
  request to the coding agent instead. No heuristics, no partial writes.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

log = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
PICKER_MARK = "shellteam-review-picker"

_picker_html: bytes | None = None


def _picker() -> bytes:
    global _picker_html
    if _picker_html is None:
        js = (FRONTEND_DIR / "review-picker.js").read_text(encoding="utf-8")
        _picker_html = f'\n<script data-{PICKER_MARK}>\n{js}\n</script>\n'.encode()
    return _picker_html


def inject_picker(html: bytes) -> bytes:
    """Return ``html`` with the review picker appended (before ``</body>`` when present)."""
    idx = html.lower().rfind(b"</body>")
    script = _picker()
    return html[:idx] + script + html[idx:] if idx != -1 else html + script


class EditNotApplicable(Exception):
    """The edited snippet cannot be located exactly once in the source file."""


def _whitespace_insensitive(snippet: str) -> re.Pattern[str]:
    parts = [re.escape(p) for p in snippet.split()]
    return re.compile(r"\s+".join(parts))


def apply_text_edit(home_dir: Path, relpath: str, old_html: str, new_html: str, selector: str) -> None:
    """Replace ``old_html`` with ``new_html`` in ``~/relpath`` iff it occurs exactly once.

    ``relpath`` must already be resolved and confined by ``reports.resolve_report_path``.
    Raises ``EditNotApplicable`` when the snippet is missing or ambiguous; the
    file is untouched in that case.
    """
    if not old_html.strip():
        raise EditNotApplicable("The edited element had no source text to match")
    path = home_dir / relpath
    source = path.read_text(encoding="utf-8")

    count = source.count(old_html)
    if count == 1:
        updated = source.replace(old_html, new_html, 1)
    else:
        if count > 1:
            raise EditNotApplicable(f"The text appears {count} times in the file")
        matches = list(_whitespace_insensitive(old_html).finditer(source))
        if len(matches) != 1:
            raise EditNotApplicable(
                "The text was not found in the file"
                if not matches
                else f"The text appears {len(matches)} times in the file"
            )
        m = matches[0]
        updated = source[: m.start()] + new_html + source[m.end() :]

    tmp = path.with_name(path.name + ".st-edit.tmp")
    tmp.write_text(updated, encoding="utf-8")
    os.replace(tmp, path)
    log.info(
        "Text edit applied to %s at %s: %d -> %d bytes; old=%r new=%r",
        relpath, selector, len(old_html), len(new_html), old_html[:200], new_html[:200],
    )

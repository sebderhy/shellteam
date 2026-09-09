"""Release gate for repository-local Markdown links.

The public-release QA audit (2026-07-19) found 19 dead repo-local links —
mostly skill files pointing at paths that don't exist. Any relative link in a
tracked Markdown file must resolve to a real file or directory.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from urllib.parse import unquote

REPO_ROOT = Path(__file__).resolve().parents[1]
INLINE_LINK = re.compile(r"!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[\"'][^)]*)?\)")
REFERENCE_LINK = re.compile(r"^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)")
# "/" — root-absolute targets are upstream-site paths (e.g. Google API guide
# links copied into gws skill descriptions), never repo files.
REMOTE_PREFIXES = ("http://", "https://", "mailto:", "tel:", "data:", "#", "/")


def _tracked_markdown_files() -> list[Path]:
    """Tracked *.md on a checkout; a filesystem walk in an exported snapshot
    (the public-release tree is tested before its git history exists)."""
    out = subprocess.run(
        ["git", "ls-files", "*.md"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if out.returncode == 0:
        return [REPO_ROOT / line for line in out.stdout.splitlines() if line]
    skip = {".git", ".venv", "node_modules"}
    return sorted(
        path
        for path in REPO_ROOT.rglob("*.md")
        if not any(part in skip for part in path.relative_to(REPO_ROOT).parts)
    )


def _local_targets(path: Path) -> list[tuple[int, str]]:
    """(line, target) for every repo-local link, skipping fenced code blocks."""
    targets: list[tuple[int, str]] = []
    fence: str | None = None
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        marker = line.lstrip()[:3]
        if marker in {"```", "~~~"}:
            fence = None if fence == marker else fence or marker
            continue
        if fence:
            continue
        raw_targets = [m.group(1) for m in INLINE_LINK.finditer(line)]
        if ref := REFERENCE_LINK.match(line):
            raw_targets.append(ref.group(1))
        for raw in raw_targets:
            target = raw.strip("<>")
            if target.startswith(REMOTE_PREFIXES) or not target:
                continue
            # Strip anchors/queries; decode %20-style escapes.
            target = unquote(target.split("#", 1)[0].split("?", 1)[0])
            if target:
                targets.append((lineno, target))
    return targets


def test_all_local_markdown_links_resolve():
    broken: list[str] = []
    for md in _tracked_markdown_files():
        for lineno, target in _local_targets(md):
            if target.startswith("/"):
                resolved = REPO_ROOT / target.lstrip("/")
            else:
                resolved = md.parent / target
            if not resolved.exists():
                rel = md.relative_to(REPO_ROOT)
                broken.append(f"{rel}:{lineno} -> {target}")
    assert not broken, "dead repo-local markdown links:\n" + "\n".join(broken)

"""Guard against the legacy 'ormind' brand leaking back into shipped source.

ShellTeam OSS is a clean-branded repo. The managing-agent rename swept every
shipped file; this test fails loudly if any 'ormind' identifier (cookie names,
CLI binaries, domains, copy) reappears in code we ship. Internal planning and
inspiration archives are intentionally excluded.
"""

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

# Directories that ship as part of the product (code, config, frontend, docs).
SHIPPED_DIRS = ["api", "computer", "frontend", "deploy", "tests"]
SHIPPED_ROOT_FILES = [
    "install.sh",
    "Caddyfile.example",
    ".env.example",
    "README.md",
    "SECURITY.md",
    "INSTALL.md",
    "NOTICE",
    "CLAUDE.md",
]

# Never scan these — generated, vendored, or internal-only archives.
EXCLUDE_DIR_PARTS = {
    "node_modules",
    ".git",
    ".pytest_cache",
    "__pycache__",
    ".venv",
    "vendor",
    "plans",
    "inspiration",
}

TEXT_SUFFIXES = {
    ".py", ".mjs", ".js", ".ts", ".html", ".css", ".sh", ".conf",
    ".service", ".md", ".yml", ".yaml", ".json", ".sql", ".example", "",
}


def _iter_shipped_files():
    paths = []
    for d in SHIPPED_DIRS:
        base = REPO_ROOT / d
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            if any(part in EXCLUDE_DIR_PARTS for part in p.parts):
                continue
            if p.suffix.lower() not in TEXT_SUFFIXES:
                continue
            paths.append(p)
    for name in SHIPPED_ROOT_FILES:
        p = REPO_ROOT / name
        if p.is_file():
            paths.append(p)
    return paths


def test_no_ormind_brand_in_shipped_source():
    # This test file references the brand by name on purpose; skip itself.
    self_path = Path(__file__).resolve()
    offenders = []
    for p in _iter_shipped_files():
        if p.resolve() == self_path:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if "ormind" in line.lower():
                rel = p.relative_to(REPO_ROOT)
                offenders.append(f"{rel}:{lineno}: {line.strip()}")
    assert not offenders, "Legacy 'ormind' brand found in shipped source:\n" + "\n".join(offenders)

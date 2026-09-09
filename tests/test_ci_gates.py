"""Contract tests for the CI workflows themselves.

Three gates regressed silently once each and are cheap to pin:

1. The CLA allowlist accepted wildcard patterns. contributor-assistant's
   checkAllowList.ts turns any entry containing '*' into an UNANCHORED regex
   and tests it against `committer.login || committer.name` — for an author
   with no linked GitHub account that is the git author name, which the author
   picks. 'Claude *' therefore let anyone past the CLA with
   `git config user.name "Claude x"` and an unlinked email.

2. ShellCheck lived inside the release-gates job that the public exporter
   strips, so the public snapshot's CI had no shell linting at all — for a
   project whose front door is install.sh.

3. The subscription-recovery gate sat under release-qa.md's "Automated in CI"
   heading for weeks while ci.yml never ran it, so it only ran when someone
   remembered to. A release gate you have to remember is not a gate; the doc
   and the workflow have to agree, and that agreement is checkable.

The private-region markers are assembled from fragments rather than written
literally: the exporter's stripper is line-oriented, so a source line spelling
both markers out would be deleted from this file in the public snapshot and
leave it syntactically broken.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
RELEASE_QA = ROOT / "docs" / "release-qa.md"
_BEGIN, _END = "ORG-" + "BEGIN", "ORG-" + "END"


def _public_view(path: Path) -> str:
    """The file as the public snapshot sees it — private regions stripped.

    Mirrors make-public-snapshot.sh's stripper exactly: line-oriented, nesting
    aware, comment-syntax agnostic (YAML '#' and Markdown '<!-- -->' alike),
    and a line naming both markers is prose about the process, not a marker.
    """
    kept, depth = [], 0
    for line in path.read_text(encoding="utf-8").splitlines(keepends=True):
        if _BEGIN in line and _END in line:
            if depth == 0:
                kept.append(line)
        elif _BEGIN in line:
            depth += 1
        elif _END in line:
            depth -= 1
        elif depth == 0:
            kept.append(line)
    assert depth == 0, f"{path}: unbalanced {_BEGIN} (never closed)"
    return "".join(kept)


def test_cla_allowlist_has_no_wildcards() -> None:
    """A '*' entry is an unanchored regex over an author-controlled name."""
    line = next(
        line
        for line in (WORKFLOWS / "cla.yml").read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("allowlist:")
    )
    entries = line.split(":", 1)[1].strip().strip("'\"").split(",")
    offenders = [e for e in entries if "*" in e]
    assert not offenders, (
        f"CLA allowlist contains wildcard pattern(s) {offenders}. "
        "contributor-assistant matches these as unanchored regexes against the "
        "git author name when the author has no linked GitHub account, so any "
        "contributor can bypass the CLA by choosing a matching user.name. "
        "List exact GitHub logins only; give agents Co-Authored-By trailers "
        "(which the action never inspects) instead of an allowlist entry."
    )


def test_shellcheck_survives_the_public_export() -> None:
    """install.sh is the public front door — its linter must ship with it."""
    public_ci = _public_view(WORKFLOWS / "ci.yml")
    assert "shellcheck" in public_ci.lower(), (
        "No ShellCheck step survives marker-stripping in "
        ".github/workflows/ci.yml, so the public repo's CI does not lint "
        "install.sh. Keep ShellCheck in a job outside the private release-gates "
        "region."
    )


def _automated_in_ci_rows() -> list[tuple[str, str]]:
    """(gate name, command cell) for every row under 'Automated in CI'."""
    section = _public_view(RELEASE_QA).split("## Automated in CI", 1)[1]
    section = section.split("\n## ", 1)[0]
    rows = []
    for line in section.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3 or cells[0] in ("Gate", "---") or not cells[1]:
            continue
        rows.append((cells[0], cells[1]))
    return rows


def _gate_is_wired_in(command: str, ci: str) -> bool:
    """Does CI actually run this gate's command?"""
    paths = re.findall(r"`[^`]*?([\w./-]+\.(?:mjs|sh|py))[^`]*`", command)
    if any(path in ci for path in paths):
        return True
    # A gate carried by `npm test` names a test file relative to the cockpit
    # rather than a command CI spells out. Still pin the file's existence, so a
    # rename cannot quietly drop it from the suite.
    if "runs inside `npm test`" in command and "npm test" in ci:
        return all((ROOT / "computer" / "ai-chat" / path).exists() for path in paths)
    return False


def test_ci_automated_gates_are_actually_automated() -> None:
    """Every gate release-qa.md calls CI-automated must run in ci.yml."""
    ci = _public_view(WORKFLOWS / "ci.yml")
    rows = _automated_in_ci_rows()
    assert rows, "Parsed no gates out of release-qa.md's 'Automated in CI' table."
    missing = [
        f"{name} ({command})"
        for name, command in rows
        if not _gate_is_wired_in(command, ci)
    ]
    assert not missing, (
        "docs/release-qa.md lists these under 'Automated in CI', but nothing in "
        f".github/workflows/ci.yml runs them: {missing}. A release gate nobody "
        "has to remember is the whole point — wire it into ci.yml, or move the "
        "row to the 'Manual' section and say why it cannot run in CI."
    )

"""Contract tests for the CI workflows themselves.

Two gates regressed silently once each and are cheap to pin:

1. The CLA allowlist accepted wildcard patterns. contributor-assistant's
   checkAllowList.ts turns any entry containing '*' into an UNANCHORED regex
   and tests it against `committer.login || committer.name` — for an author
   with no linked GitHub account that is the git author name, which the author
   picks. 'Claude *' therefore let anyone past the CLA with
   `git config user.name "Claude x"` and an unlinked email.

2. ShellCheck lived inside the release-gates job that the public exporter
   strips, so the public snapshot's CI had no shell linting at all — for a
   project whose front door is install.sh.

The private-region markers are assembled from fragments rather than written
literally: the exporter's stripper is line-oriented, so a source line spelling
both markers out would be deleted from this file in the public snapshot and
leave it syntactically broken.
"""

import re
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
_BEGIN, _END = "ORG-" + "BEGIN", "ORG-" + "END"
_PRIVATE_REGION = re.compile(
    rf"^\s*#\s*{_BEGIN}.*?^\s*#\s*{_END}", re.DOTALL | re.MULTILINE
)


def _public_view(path: Path) -> str:
    """The file as the public snapshot sees it — private regions stripped."""
    return _PRIVATE_REGION.sub("", path.read_text(encoding="utf-8"))


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

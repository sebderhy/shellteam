"""The public static mount ships from an approved inventory — nothing else.

frontend/static/ is served unauthenticated at /static on every install AND is
part of the public repository, so anything that lands there is published twice
over. A rendered report artifact (an internal meeting summary) shipped this way
in the initial public release: the residue scanner greps for secret shapes and
private names, but a business document matches none of those patterns — only an
explicit inventory catches "a file that has no business being here at all".

Adding a real asset is deliberate: put the path in APPROVED and say why in the
PR. This test runs in the lab suite and inside the exported snapshot, so an
unapproved file fails both the lab CI and the release exporter.
"""

from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "frontend" / "static"

APPROVED = {
    ".gitkeep",
    "apple-touch-icon.png",
    "base.css",
    "favicon-16.png",
    "favicon-32.png",
    "favicon.ico",
    "favicon.svg",
    "feedback.js",
    "icon-192.png",
    "icon-512.png",
    "icons/figma.svg",
    "icons/github.svg",
    "icons/gmail.svg",
    "icons/googlecalendar.svg",
    "icons/googledrive.svg",
    "icons/notion.svg",
    "icons/slack.svg",
    "tokens.css",
    "vendor/xterm-5.5.0.min.css",
    "vendor/xterm-5.5.0.min.js",
    "vendor/xterm-addon-fit-0.10.0.min.js",
    "vendor/xterm-addon-web-links-0.11.0.min.js",
}


def test_static_mount_contains_only_approved_files() -> None:
    present = {str(p.relative_to(STATIC)) for p in STATIC.rglob("*") if p.is_file()}
    unapproved = sorted(present - APPROVED)
    assert not unapproved, (
        f"Unapproved file(s) under frontend/static/: {unapproved}. This "
        "directory is served UNAUTHENTICATED at /static and ships in the "
        "public repo. If the file is a real product asset, add it to APPROVED "
        "in this test deliberately; if it is a report, screenshot, or any "
        "generated document, it must not live here (an internal meeting "
        "summary leaked exactly this way)."
    )


def test_no_documents_under_static_even_if_approved() -> None:
    """Belt and braces: document formats never belong on the static mount."""
    banned = {".html", ".md", ".pdf", ".doc", ".docx", ".csv", ".xlsx"}
    offenders = sorted(
        str(p.relative_to(STATIC))
        for p in STATIC.rglob("*")
        if p.is_file() and p.suffix.lower() in banned
    )
    assert not offenders, (
        f"Document file(s) under frontend/static/: {offenders}. Reports and "
        "rendered documents belong in ~/reports (owner-gated), never on the "
        "unauthenticated static mount."
    )

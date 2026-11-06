"""SHE-146: folder and file names are text, never HTML, on first-party pages."""

from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


def test_knowledge_labels_are_text():
    # A folder named `<img src=x onerror=…>` is legal on Linux and became markup.
    src = (FRONTEND / "knowledge.html").read_text()
    assert "b.innerHTML = label" not in src
    assert "b.textContent = label" in src


def test_cli_errors_are_escaped_in_settings():
    src = (FRONTEND / "dashboard.html").read_text()
    assert "${escapeHtml(resp.error || 'Test failed')}" in src

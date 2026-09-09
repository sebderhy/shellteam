"""Tests for the laptop wizard (scripts/mirror-import.sh).

The PR that introduced the wizard claimed "credentials never reach a saved
file (contract-tested)", but the only tests covered mirror-inventory.sh —
`--pack` honouring a section list it is *given*, and the bare script's default
mode. The decision that actually enforces the contract lives one layer up, in
the wizard's ``run_save``, and had no test at all. Same for the box pinning and
the https-only rule, both of which decide where credentials get sent.

The wizard is a bash wrapper around one ``python3 - <<'PYEOF'`` heredoc; these
tests load that heredoc as a module so the real code is exercised, not a copy.
"""

import re
import types
from pathlib import Path

import pytest

WIZARD = Path(__file__).resolve().parent.parent / "scripts" / "mirror-import.sh"


def load_wizard(monkeypatch, tmp_path, *, box="", cred=""):
    """Import the wizard's embedded Python as a module.

    Its import-time code reads a staged manifest and parses the box link out of
    the environment, so both are provided here.
    """
    source = WIZARD.read_text()
    body = re.search(r"python3 - <<'PYEOF'\n(.*?)\nPYEOF", source, re.S)
    assert body, "the wizard's Python heredoc moved — update this test"
    # Stop before the run phase: everything below binds the socket, opens a
    # browser and blocks in serve_forever. The definitions above it are what
    # these tests exercise.
    code, marker, _ = body.group(1).partition("\n# --- Run ---")
    if not marker:
        code = body.group(1).split("\nserver = ThreadingHTTPServer(")[0]

    stage = tmp_path / "stage"
    stage.mkdir()
    (stage / "manifest.json").write_text('{"created": "20260727-000000"}')
    (stage / "summary.json").write_text("{}")
    monkeypatch.setenv("MIRROR_STAGE", str(stage))
    monkeypatch.setenv("MIRROR_INVENTORY", "/bin/true")
    monkeypatch.setenv("MIRROR_BOX", box)
    monkeypatch.setenv("MIRROR_CRED", cred)
    monkeypatch.setenv("HOME", str(tmp_path))

    module = types.ModuleType("mirror_wizard")
    module.__dict__["__name__"] = "mirror_wizard"
    exec(compile(code, str(WIZARD), "exec"), module.__dict__)  # noqa: S102
    return module


class TestSaveModeContract:
    """A SAVED tarball is shareable — it must never contain the secure sections
    (agent logins, MCP tokens, chat history) no matter what the caller asks for.
    This is the wizard-level filter the contract actually depends on."""

    def test_save_drops_every_secure_section(self, monkeypatch, tmp_path):
        w = load_wizard(monkeypatch, tmp_path)
        packed = {}
        monkeypatch.setattr(w, "pack", lambda sections, out: packed.setdefault("sections", sections))
        monkeypatch.setattr(w, "set_state", lambda **kw: None)

        w.run_save(["packages", "logins", "history", "shell-history", "dotfiles"])

        assert packed["sections"] == ["packages", "dotfiles"]
        for secure in w.SECURE_SECTIONS:
            assert secure not in packed["sections"]

    def test_save_of_only_secure_sections_packs_nothing_sensitive(self, monkeypatch, tmp_path):
        w = load_wizard(monkeypatch, tmp_path)
        packed = {}
        monkeypatch.setattr(w, "pack", lambda sections, out: packed.setdefault("sections", sections))
        monkeypatch.setattr(w, "set_state", lambda **kw: None)

        w.run_save(list(w.SECURE_SECTIONS))

        assert packed["sections"] == []

    def test_the_two_section_lists_are_disjoint(self, monkeypatch, tmp_path):
        w = load_wizard(monkeypatch, tmp_path)
        assert not set(w.SAFE_SECTIONS) & set(w.SECURE_SECTIONS)


class TestBoxLink:
    def test_refuses_a_cleartext_box_url(self, monkeypatch, tmp_path):
        """The upload carries OAuth credentials and chat history and the UI
        promises TLS in so many words — honouring a pasted http:// link would
        put all of it on the wire in the clear while the page said otherwise."""
        w = load_wizard(monkeypatch, tmp_path)
        with pytest.raises(ValueError, match="https"):
            w.parse_box_link("http://mybox.local:8000", "mirror-v1.1.abc")

    def test_bare_hostname_is_upgraded_to_https(self, monkeypatch, tmp_path):
        w = load_wizard(monkeypatch, tmp_path)
        box, _ = w.parse_box_link("mybox.shellteam.sh", "c")
        assert box == "https://mybox.shellteam.sh"

    def test_welcome_link_token_becomes_the_credential(self, monkeypatch, tmp_path):
        w = load_wizard(monkeypatch, tmp_path)
        box, cred = w.parse_box_link("https://mybox.shellteam.sh/?token=abc123")
        assert (box, cred) == ("https://mybox.shellteam.sh", "abc123")


class TestRedirectHandling:
    def test_authorization_is_dropped_when_a_redirect_changes_host(self, monkeypatch, tmp_path):
        """CPython's default redirect handler forwards Authorization verbatim, so
        a 302 from the box URL would hand the import credential (or the master
        token, for a pasted welcome link) to whatever host it names."""
        import urllib.request

        w = load_wizard(monkeypatch, tmp_path)
        handler = w._NoCredentialLeakRedirect()
        req = urllib.request.Request(
            "https://mybox.shellteam.sh/api/mirror/upload",
            headers={"Authorization": "Bearer mirror-v1.1.secret"},
        )
        new = handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/x")
        assert new is not None
        assert new.get_header("Authorization") is None

    def test_authorization_survives_a_same_host_redirect(self, monkeypatch, tmp_path):
        import urllib.request

        w = load_wizard(monkeypatch, tmp_path)
        handler = w._NoCredentialLeakRedirect()
        req = urllib.request.Request(
            "https://mybox.shellteam.sh/api/mirror/upload",
            headers={"Authorization": "Bearer mirror-v1.1.secret"},
        )
        new = handler.redirect_request(req, None, 302, "Found", {}, "https://mybox.shellteam.sh/v2")
        assert new.get_header("Authorization") == "Bearer mirror-v1.1.secret"


class TestInventoryFetchSource:
    """The wizard downloads its inventory engine when it isn't a repo sibling.
    That download must come from the BOX when a box URL is given — the box
    serves the scripts at its own installed version, so the pair can't skew
    and no third party sits in the path of code that reads the laptop."""

    def _run_and_capture_fetch_url(self, tmp_path, *args, env_extra=None):
        import os
        import subprocess

        # A fake curl that records its URL argument and fails, so the wizard
        # (set -e) stops right after the fetch attempt.
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        log = tmp_path / "curl-url.txt"
        fake_curl = bin_dir / "curl"
        fake_curl.write_text(
            "#!/bin/sh\nfor a in \"$@\"; do case \"$a\" in http*) echo \"$a\" >> %s;; esac; done\nexit 22\n"
            % log
        )
        fake_curl.chmod(0o755)
        # Copy the wizard away from the repo so the sibling check misses.
        script = tmp_path / "mirror-import.sh"
        script.write_text(WIZARD.read_text())
        env = {
            "HOME": str(tmp_path),
            "PATH": f"{bin_dir}:/usr/bin:/bin",
            "TMPDIR": str(tmp_path),
            **(env_extra or {}),
        }
        subprocess.run(
            ["bash", str(script), *args], env=env,
            capture_output=True, text=True, timeout=60,
        )
        return log.read_text().strip() if log.exists() else ""

    def test_fetches_inventory_from_the_box_when_a_box_url_is_given(self, tmp_path):
        url = self._run_and_capture_fetch_url(tmp_path, "https://mybox.example.com")
        assert url == "https://mybox.example.com/api/mirror/mirror-inventory.sh"

    def test_falls_back_to_github_only_without_a_box(self, tmp_path):
        url = self._run_and_capture_fetch_url(tmp_path)
        assert re.fullmatch(
            r"https://raw\.githubusercontent\.com/sebderhy/shellteam/v\d+\.\d+\.\d+"
            r"/scripts/mirror-inventory\.sh",
            url,
        ), f"boxless fallback must fetch a pinned release tag, got {url}"

    def test_the_github_fallback_never_tracks_a_mutable_ref(self):
        """Whoever can move a branch would otherwise control code that reads
        every user's laptop. The fallback must name a tag, not main/HEAD."""
        assert "/shellteam/main/" not in WIZARD.read_text()

    def test_the_pinned_fallback_tag_matches_the_current_release(self):
        """The pin has to be bumped when a release is tagged; make forgetting
        it a red test rather than a checklist line nobody reads."""
        pinned = re.search(r'MIRROR_FALLBACK_REF="(v[^"]+)"', WIZARD.read_text()).group(1)
        changelog = (WIZARD.parent.parent / "CHANGELOG.md").read_text()
        latest = re.search(r"^## \[(\d+\.\d+\.\d+)\]", changelog, re.M).group(1)
        assert pinned == f"v{latest}", (
            f"mirror-import.sh pins {pinned} but CHANGELOG's latest release is v{latest}"
        )

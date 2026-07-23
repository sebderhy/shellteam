"""Regression tests for frontend HTML/CSS bugs.

These tests parse the static HTML files directly to catch bugs that
can be detected structurally without a browser.

BUG-4: terminal.onData() inside connectTerminalWS() caused duplicate
       keystroke listeners to stack on every reconnect.
"""

import re
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


# ---------------------------------------------------------------------------
# BUG-4: Duplicate terminal keystroke listeners on reconnect
# ---------------------------------------------------------------------------
class TestBug4TerminalDuplicateKeystrokes:
    """terminal.onData() must be registered in initTerminal(), NOT inside
    connectTerminalWS(). Since connectTerminalWS() runs on every reconnect,
    placing onData() there stacks duplicate listeners — each one sends the
    same keystroke to the shared `ws` variable, causing every character to
    appear N times after N reconnections."""

    def setup_method(self):
        self.html = (FRONTEND / "terminal.html").read_text()
        match = re.search(
            r"function connectTerminalWS\(\)\s*\{(.*?)\n        \}",
            self.html,
            re.DOTALL,
        )
        assert match, "Could not find connectTerminalWS function"
        self.connect_ws_body = match.group(1)

        match = re.search(
            r"function initTerminal\(\)\s*\{(.*?)\n        \}",
            self.html,
            re.DOTALL,
        )
        assert match, "Could not find initTerminal function"
        self.init_terminal_body = match.group(1)

    def test_ondata_not_in_connect_ws(self):
        """terminal.onData() must NOT be inside connectTerminalWS()."""
        assert "onData" not in self.connect_ws_body, (
            "BUG-4 regression: terminal.onData() is inside connectTerminalWS(). "
            "This causes duplicate keystroke listeners on every reconnect — "
            "move it to initTerminal() where it runs exactly once."
        )

    def test_ondata_in_init_terminal(self):
        """terminal.onData() must be registered in initTerminal()."""
        assert "onData" in self.init_terminal_body, (
            "BUG-4 regression: terminal.onData() is not in initTerminal(). "
            "It must be registered exactly once, in initTerminal()."
        )


# ---------------------------------------------------------------------------
# SHE-36: no Cloud-era "included / free" claims about OpenCode in OSS
# ---------------------------------------------------------------------------
class TestShe36NoCloudIncludedCopy:
    """In OSS the user's own Fireworks key pays for OpenCode. Copy claiming it
    is 'included'/'free' is a shellteam-cloud leftover that has already
    regressed once (the honest-copy fix was overwritten by the Settings
    feature-keys rewrite) — pin it."""

    def test_dashboard_never_claims_opencode_is_included(self):
        html = (FRONTEND / "dashboard.html").read_text()
        for phrase in (
            "included free",
            "Frontier models, included",
            "no per-user API key needed",
            "pays the bill",
        ):
            assert phrase not in html, (
                f"SHE-36 regression: dashboard.html claims OpenCode is bundled "
                f"({phrase!r}) — in OSS it runs on the user's own Fireworks key."
            )


# ---------------------------------------------------------------------------
# QA audit P2: recovery copy must not point at nonexistent installer flags
# ---------------------------------------------------------------------------
class TestNoNonexistentInstallerFlags:
    """install.sh accepts --minimal / --full / --experimental (modules otherwise
    via MODULES= in .env). `--with-browser` never existed — user-facing recovery
    copy and current-tense docs must give commands that actually work.
    Decision docs / archives are historical records and are exempt."""

    CURRENT_TENSE_DOCS = ("ARCHITECTURE.md", "ROADMAP.md")

    def test_browser_tab_recovery_copy_gives_real_commands(self):
        html = (FRONTEND / "browser.html").read_text()
        assert "--with-browser" not in html, (
            "browser.html tells the user to run './install.sh --with-browser', "
            "which install.sh does not accept. Use './install.sh --full' or "
            "MODULES=browser in .env + re-run ./install.sh."
        )
        assert "--full" in html and "MODULES=" in html, (
            "browser.html's module-missing recovery copy must give the real "
            "enable commands (./install.sh --full, or browser in MODULES= in .env)."
        )

    def test_current_docs_never_reference_with_star_flags(self):
        docs = FRONTEND.parent / "docs"
        for name in self.CURRENT_TENSE_DOCS:
            doc = docs / name
            if not doc.exists():
                continue  # pruned from the public snapshot (lab-only doc)
            text = doc.read_text()
            for flag in ("--with-browser", "--with-composio", "--with-dreaming"):
                assert flag not in text, (
                    f"docs/{name} references {flag}, which install.sh does not "
                    f"accept — point at './install.sh --full' / MODULES= instead."
                )


# ---------------------------------------------------------------------------
# QA-09 / QA-12: API unit — banner masking + clean-restart exit status
# ---------------------------------------------------------------------------
class TestApiUnitContract:
    """uvicorn adds its "server: uvicorn" header BELOW the ASGI app, so
    middleware cannot mask it — SECURITY.md's stack-banner claim holds only if
    the unit passes --no-server-header (QA-09). And a planned SIGTERM stop
    makes the uv wrapper exit 143, which systemd logs as a false "Failed with
    result 'exit-code'" unless SuccessExitStatus covers it (QA-12)."""

    def setup_method(self):
        unit = FRONTEND.parent / "deploy" / "systemd" / "shellteam-api.service"
        self.text = unit.read_text()

    def test_uvicorn_banner_is_masked_at_the_transport_level(self):
        exec_line = next(
            line for line in self.text.splitlines() if line.startswith("ExecStart=")
        )
        assert "--no-server-header" in exec_line, (
            "QA-09: shellteam-api.service must pass --no-server-header — "
            "application middleware cannot remove uvicorn's transport-level "
            "Server header, and SECURITY.md claims the stack banner is masked."
        )

    def test_planned_stops_are_not_recorded_as_failures(self):
        assert "SuccessExitStatus=143" in self.text, (
            "QA-12: without SuccessExitStatus=143 every planned restart logs "
            "'Failed with result exit-code' for a clean SIGTERM shutdown."
        )


# ---------------------------------------------------------------------------
# QA-10: dashboard deep links — knowledge tab + module-gated hashes
# ---------------------------------------------------------------------------
class TestQa10HashRouting:
    """#knowledge deep links were rewritten to #agents (the hash allowlist
    predated the Knowledge tab), and a hard-coded list would let a disabled
    module's hash activate a hidden tab. The routing must validate against the
    actual tab element's visibility, after awaiting the knowledge probe."""

    def setup_method(self):
        self.html = (FRONTEND / "dashboard.html").read_text()

    def test_initial_hash_validates_against_tab_visibility(self):
        assert "const valid = ['agents', 'terminal', 'files'" not in self.html, (
            "QA-10 regression: the initial-tab logic is back on a hard-coded "
            "hash allowlist — it must check the tab element's visibility so "
            "module tabs (knowledge, browser) are honored exactly when enabled."
        )
        assert 'tab[data-tab="${CSS.escape(hash)}"]' in self.html
        assert "style.display !== 'none'" in self.html

    def test_initial_tab_waits_for_the_knowledge_probe(self):
        assert "await knowledgeProbe" in self.html, (
            "QA-10: without awaiting the knowledge probe, a #knowledge deep "
            "link races the tab reveal and falls back to #agents."
        )

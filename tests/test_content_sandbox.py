"""Content-sandbox + Origin-gate hardening (docs/decisions/20260717-served-content-sandbox.md).

Closes the pre-launch review's one HIGH: agent/owner HTML served on the dashboard
origin could ride the ambient HttpOnly master cookie into the terminal WS,
/api/auth/enroll (durable-session mint), /share, or /_api/ writes. The fix:
  1. served content HTML gets `Content-Security-Policy: sandbox` (opaque origin →
     the host-only master cookie is never attached), and
  2. those four capability sinks reject any present, non-dashboard Origin.
"""

import httpx
import pytest
import respx
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from api.main import app, _wants_content_sandbox, CONTENT_SANDBOX_CSP
from api.services.auth import origin_is_trusted

MASTER = "fake-jwt-token"  # conftest's pinned OWNER_TOKEN
LOCAL = {"host": "localhost"}
BEARER = {"Authorization": f"Bearer {MASTER}"}
FILE_ORIGIN = "http://127.0.0.1:80"  # FILE_PORT defaults to 80 in tests


# --- origin_is_trusted ------------------------------------------------------------

class TestOriginIsTrusted:
    def test_absent_origin_allowed(self):
        # Non-browser clients (curl, in-box tooling) send no Origin; the ambient
        # cookie attack requires a browser, which always sends one on these.
        assert origin_is_trusted(None) is True
        assert origin_is_trusted("") is True

    def test_main_hosts_allowed(self):
        assert origin_is_trusted("http://localhost") is True
        assert origin_is_trusted("http://localhost:8000") is True
        assert origin_is_trusted("http://127.0.0.1:3456") is True

    def test_sandboxed_null_origin_refused(self):
        # A content-sandboxed report sends exactly this.
        assert origin_is_trusted("null") is False

    def test_external_and_subdomain_refused(self):
        assert origin_is_trusted("https://evil.com") is False
        assert origin_is_trusted("https://alice.localhost") is False  # content subdomain


# --- _wants_content_sandbox -------------------------------------------------------

def _req(path, host="localhost"):
    r = MagicMock()
    r.headers = {"host": host}
    r.url = MagicMock()
    r.url.path = path
    return r


def _resp(ctype="text/html"):
    r = MagicMock()
    r.headers = {"content-type": ctype}
    return r


class TestWantsContentSandbox:
    def test_served_html_is_sandboxed(self):
        assert _wants_content_sandbox(_req("/reports/r.html"), _resp()) is True
        assert _wants_content_sandbox(_req("/public/index.html"), _resp()) is True

    def test_dashboard_shell_not_sandboxed(self):
        # `/` gets the dashboard CSP instead (its own security posture).
        assert _wants_content_sandbox(_req("/"), _resp()) is False

    def test_trusted_file_ui_not_sandboxed(self):
        # These make credentialed same-origin fetches — must keep the real origin.
        for p in ("/_editor/x.py", "/_ls/tmp", "/_files/", "/_api/save",
                  "/api/computers/cockpit/github.html"):
            assert _wants_content_sandbox(_req(p), _resp()) is False, p

    def test_non_html_not_sandboxed(self):
        assert _wants_content_sandbox(_req("/tmp/chart.png"), _resp("image/png")) is False
        assert _wants_content_sandbox(_req("/api/x"), _resp("application/json")) is False

    def test_subdomain_content_not_sandboxed_here(self):
        # Content subdomains are cookie-isolated already; this main-host header
        # doesn't apply to them.
        assert _wants_content_sandbox(_req("/reports/r.html", host="alice.localhost"), _resp()) is False

    def test_sandbox_csp_withholds_same_origin(self):
        # The one token that must never appear — it would restore the real origin
        # and undo the whole fix.
        assert "sandbox" in CONTENT_SANDBOX_CSP
        assert "allow-scripts" in CONTENT_SANDBOX_CSP
        assert "allow-same-origin" not in CONTENT_SANDBOX_CSP


# --- The exemption lists stay first-party ------------------------------------------

class TestSandboxExemptionsAreFirstParty:
    """The sandbox CSP is LOAD-BEARING for the auth model, not just
    defense-in-depth: since 2026-07-19 the files credential may mutate on
    cockpit/app ports from a trusted Origin, and it is the sandbox's opaque
    origin (`Origin: null`) that keeps served owner/agent HTML untrusted. An
    exemption that ever points at owner-authored content would run that content
    on the trusted main origin — able to drive the agents.

    See docs/decisions/20260719-cockpit-ws-origin-boundary.md ("Consequences").
    """

    @respx.mock
    def test_csp_paths_are_shell_pages_not_served_files(self):
        """Every _CSP_PATHS exemption must be a ShellTeam shell page, never a
        path that falls through to the owner-file catch-all. Behavioral, not
        route introspection (the catch-all hides inside an _IncludedRouter and
        route.matches() can't see it): no mock is registered for the file
        server, so if an exempt path ever proxies owner content the request
        errors instead of rendering — and a served file would carry the sandbox
        CSP, which we assert is absent."""
        from api.main import _CSP_PATHS

        with TestClient(app) as client:
            for path in _CSP_PATHS:
                # Status is not the property under test (/guest 409s without a
                # guest token); the CSP class is — shell pages carry the
                # dashboard CSP on every response, served files the sandbox.
                resp = client.get(path, headers={**LOCAL, **BEARER})
                csp = resp.headers.get("content-security-policy", "")
                assert "default-src" in csp and "sandbox" not in csp, (
                    f"{path}: sandbox-exempt but not serving the dashboard "
                    f"shell (CSP={csp!r}) — an exemption must never serve "
                    f"owner/agent content"
                )


    def test_no_exemption_prefix_covers_content_dirs(self):
        """No trusted-UI prefix may shadow the directories owner/agent HTML is
        actually served from."""
        from api.main import _TRUSTED_FILE_UI_PREFIXES, _CSP_PATHS

        content_roots = ("/reports", "/public", "/tmp", "/projects")
        exemptions = tuple(_TRUSTED_FILE_UI_PREFIXES) + tuple(_CSP_PATHS)
        for root in content_roots:
            for ex in exemptions:
                if ex == "/":
                    continue  # exact-match only in _wants_dashboard_csp
                assert not root.startswith(ex.rstrip("/")), (
                    f"exemption {ex!r} covers content dir {root!r}"
                )


# --- Integration: the header actually lands (through the middleware) ---------------

class TestSandboxHeaderIntegration:
    @respx.mock
    def test_served_report_gets_sandbox_header(self):
        respx.get(f"{FILE_ORIGIN}/reports/r.html").mock(
            return_value=httpx.Response(200, text="<h1>r</h1>", headers={"content-type": "text/html"})
        )
        with TestClient(app) as client:
            resp = client.get("/reports/r.html", headers={**LOCAL, **BEARER})
        assert resp.status_code == 200
        csp = resp.headers.get("content-security-policy", "")
        assert "sandbox" in csp and "allow-same-origin" not in csp

    def test_dashboard_shell_not_sandboxed(self):
        with TestClient(app) as client:
            resp = client.get("/", headers=LOCAL)
        csp = resp.headers.get("content-security-policy", "")
        assert "sandbox" not in csp
        assert "default-src" in csp  # it's the dashboard CSP

    @respx.mock
    def test_editor_not_sandboxed(self):
        respx.get(f"{FILE_ORIGIN}/_editor/").mock(
            return_value=httpx.Response(200, text="<html>monaco</html>", headers={"content-type": "text/html"})
        )
        with TestClient(app) as client:
            resp = client.get("/_editor/", headers={**LOCAL, **BEARER})
        assert "sandbox" not in resp.headers.get("content-security-policy", "")


# --- /knowledge is a first-party shell, never sandboxed content --------------------

class TestKnowledgeIsFirstPartyShell:
    """P1-NEW-01 (release recheck 2026-07-20): /knowledge is a real app shell
    (frontend/knowledge.html) that fetches /api/knowledge/* same-origin, but it
    was missing from _CSP_PATHS — so it fell through to CONTENT_SANDBOX_CSP,
    got an opaque origin, and every fetch died as `Origin: null` CORS. The tab
    shipped completely unusable while all suites stayed green.

    These tests name /knowledge explicitly: the generic loop over _CSP_PATHS
    proves listed entries are safe but can never detect an omitted route."""

    @pytest.fixture
    def dreaming(self, monkeypatch):
        from api import config
        monkeypatch.setattr(config, "MODULES", frozenset({"dreaming"}))

    def test_knowledge_page_gets_dashboard_csp_not_sandbox(self, dreaming):
        with TestClient(app) as client:
            resp = client.get("/knowledge", headers={**LOCAL, **BEARER})
        assert resp.status_code == 200
        csp = resp.headers.get("content-security-policy", "")
        assert "default-src" in csp, f"/knowledge lacks the dashboard CSP: {csp!r}"
        assert "sandbox" not in csp, (
            "/knowledge is sandboxed — its opaque origin turns every "
            "/api/knowledge/* fetch into an Origin:null CORS failure"
        )

    def test_knowledge_is_explicitly_in_csp_paths(self):
        # Belt-and-suspenders against the omission recurring in a refactor of
        # how _wants_dashboard_csp matches paths.
        from api.main import _CSP_PATHS, _wants_dashboard_csp

        assert "/knowledge" in _CSP_PATHS
        assert _wants_dashboard_csp(_req("/knowledge")) is True
        assert _wants_content_sandbox(_req("/knowledge"), _resp()) is False

    @respx.mock
    def test_owner_html_stays_sandboxed_alongside_the_exemption(self, dreaming):
        # The counterweight: exempting the shell must not loosen the sandbox on
        # owner/agent-authored HTML one directory over.
        respx.get(f"{FILE_ORIGIN}/reports/knowledge-notes.html").mock(
            return_value=httpx.Response(200, text="<h1>notes</h1>",
                                        headers={"content-type": "text/html"})
        )
        with TestClient(app) as client:
            resp = client.get("/reports/knowledge-notes.html", headers={**LOCAL, **BEARER})
        csp = resp.headers.get("content-security-policy", "")
        assert "sandbox" in csp and "allow-same-origin" not in csp


# --- Integration: the four capability sinks reject cross-origin --------------------

class TestSinkOriginGates:
    def test_enroll_rejects_cross_origin(self):
        with TestClient(app) as client:
            resp = client.post("/api/auth/enroll", headers={**LOCAL, **BEARER, "origin": "null"})
        assert resp.status_code == 403

    def test_enroll_allows_same_origin(self):
        with TestClient(app) as client:
            resp = client.post("/api/auth/enroll", headers={**LOCAL, **BEARER, "origin": "http://localhost"})
        assert resp.status_code == 200  # minted (not 403)

    def test_share_rejects_cross_origin(self):
        with TestClient(app) as client:
            resp = client.get("/api/auth/share?path=tmp/x.png",
                              headers={**LOCAL, **BEARER, "origin": "https://evil.com"})
        assert resp.status_code == 403

    @respx.mock
    def test_file_write_rejects_cross_origin(self):
        route = respx.post(f"{FILE_ORIGIN}/_api/save").mock(return_value=httpx.Response(200))
        with TestClient(app) as client:
            resp = client.post("/_api/save", headers={**LOCAL, **BEARER, "origin": "null"})
        assert resp.status_code == 401  # login-required, never forwarded
        assert not route.called

    def test_terminal_ws_rejects_cross_origin(self):
        with TestClient(app) as client:
            with pytest.raises(Exception):
                with client.websocket_connect(
                    "/api/terminal", headers={"origin": "https://evil.com"}
                ) as ws:
                    ws.receive_text()


# --- Integration: same-origin GitHub widget proxy ---------------------------------

class TestCockpitProxy:
    def test_cockpit_proxy_serves_github_html_same_origin(self):
        html = "<div class='card'>GitHub</div>"
        with (
            patch("api.routers.computers.containers.get_container_ip",
                  new_callable=AsyncMock, return_value="172.20.0.5"),
            respx.mock(assert_all_called=False) as mock,
        ):
            mock.get("http://172.20.0.5:3456/github.html").mock(
                return_value=httpx.Response(200, text=html, headers={"content-type": "text/html"})
            )
            with TestClient(app) as client:
                resp = client.get("/api/computers/cockpit/github.html", headers={**LOCAL, **BEARER})
        assert resp.status_code == 200
        assert "GitHub" in resp.text
        # Exempt from the content sandbox (it needs the real origin to auth).
        assert "sandbox" not in resp.headers.get("content-security-policy", "")

"""Tests for security hardening — round 3.

Covers:
1. Invalid JWT returns 401, not 500 (verify_token must catch JWT exceptions)
2. Content-Security-Policy header present on HTML responses
"""

import os


import pytest
from unittest.mock import patch, MagicMock
from fastapi import HTTPException


# ---------------------------------------------------------------------------
# 1. verify_token — must return 401 for invalid/malformed JWTs
# ---------------------------------------------------------------------------
class TestVerifyTokenInvalidJWT:
    """verify_token must raise HTTPException(401) for any invalid token,
    never let raw jwt exceptions propagate as 500."""

    def test_garbage_token_raises_401(self):
        """A completely garbage string should return 401, not 500."""
        from api.services.auth import verify_token

        with pytest.raises(HTTPException) as exc_info:
            verify_token("not-a-jwt-at-all")
        assert exc_info.value.status_code == 401

    def test_empty_token_raises_401(self):
        """An empty string should return 401."""
        from api.services.auth import verify_token

        with pytest.raises(HTTPException) as exc_info:
            verify_token("")
        assert exc_info.value.status_code == 401

    def test_wrong_token_raises_401(self):
        """Any token that is not the owner token should return 401."""
        from api.services.auth import verify_token

        with pytest.raises(HTTPException) as exc_info:
            verify_token("definitely-not-the-owner-token")
        assert exc_info.value.status_code == 401


class TestInvalidTokenIntegration:
    """Integration test: hitting API endpoints with invalid tokens should
    return 401, not 500."""

    def test_auth_me_with_garbage_token(self):
        """GET /api/auth/me with garbage token should return 401."""
        from fastapi.testclient import TestClient
        from api.main import app

        with TestClient(app) as c:
            resp = c.get(
                "/api/auth/me",
                headers={"Authorization": "Bearer garbage-not-a-jwt"},
            )
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"

    def test_computers_status_with_garbage_token(self):
        """GET /api/computers/status with garbage token should return 401."""
        from fastapi.testclient import TestClient
        from api.main import app

        with TestClient(app) as c:
            resp = c.get(
                "/api/computers/status",
                headers={"Authorization": "Bearer garbage-not-a-jwt"},
            )
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"


# ---------------------------------------------------------------------------
# 2. Content-Security-Policy header on main-domain HTML responses
# ---------------------------------------------------------------------------
class TestContentSecurityPolicy:
    """Main-domain responses should include a Content-Security-Policy header."""

    def test_health_endpoint_has_no_csp(self, client):
        """The dashboard CSP is scoped to the app's own HTML shells. JSON API
        responses don't need it, and proxied owner files must NOT get it — it
        blocked the /_editor Monaco CDN and broke editor deep links (SHE-41)."""
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.headers.get("content-security-policy") is None

    def test_terminal_page_has_csp(self, client):
        """Served HTML cockpit pages should include CSP header."""
        resp = client.get("/terminal", headers={"host": "localhost"})
        assert resp.status_code == 200
        csp = resp.headers.get("content-security-policy")
        assert csp is not None, "CSP header missing on terminal page"

    def test_root_dashboard_has_csp(self, client):
        """The dashboard served at / must carry the CSP header."""
        resp = client.get("/", headers={"host": "localhost"})
        assert resp.status_code == 200
        assert resp.headers.get("content-security-policy") is not None

    def test_csp_includes_default_src(self, client):
        """CSP must restrict default-src."""
        resp = client.get("/", headers={"host": "localhost"})
        csp = resp.headers.get("content-security-policy", "")
        assert "default-src" in csp, f"CSP missing default-src: {csp}"

    def test_csp_includes_script_src(self, client):
        """CSP must restrict script-src (allows CDN for xterm.js etc)."""
        resp = client.get("/", headers={"host": "localhost"})
        csp = resp.headers.get("content-security-policy", "")
        assert "script-src" in csp, f"CSP missing script-src: {csp}"

    def test_csp_denies_jsdelivr(self, client):
        """CSP must NOT allow cdn.jsdelivr.net — all vendor assets are self-hosted under
        /static/vendor/ and /vendor/. Adding jsdelivr back = regression."""
        resp = client.get("/", headers={"host": "localhost"})
        csp = resp.headers.get("content-security-policy", "")
        assert "cdn.jsdelivr.net" not in csp, f"CSP must not allow jsdelivr: {csp}"

    def test_csp_allows_google_fonts(self, client):
        """CSP style-src must allow Google Fonts."""
        resp = client.get("/", headers={"host": "localhost"})
        csp = resp.headers.get("content-security-policy", "")
        assert "fonts.googleapis.com" in csp, f"CSP must allow Google Fonts: {csp}"

    def test_csp_allows_subdomain_frames(self, client):
        """CSP frame-src must allow *.localhost for container iframes."""
        resp = client.get("/", headers={"host": "localhost"})
        csp = resp.headers.get("content-security-policy", "")
        assert "localhost" in csp, f"CSP must allow subdomain frames: {csp}"

    def test_csp_allows_sibling_cockpit_on_localhost(self, client):
        """In localhost mode the Agents tab iframes the cockpit at the sibling
        port localhost:3456 (cross-origin) — CSP must allow that origin."""
        csp = client.get("/", headers={"host": "localhost"}).headers.get("content-security-policy", "")
        assert "http://localhost:3456" in csp, f"sibling cockpit origin missing: {csp}"

    def test_csp_allows_sibling_cockpit_on_bare_ip(self, app):
        """On a bare-IP host (e.g. a Tailscale 100.x address) there is no
        wildcard DNS, so the cockpit is framed at <ip>:3456. CSP frame-src must
        list that cross-origin sibling or the browser blocks the Agents tab."""
        from fastapi.testclient import TestClient

        # 127.0.0.1 is a main host that uses sibling ports — same code path as a
        # tailnet IP, but already in MAIN_HOSTS so is_main_host() applies the CSP.
        with TestClient(app, base_url="http://127.0.0.1") as c:
            csp = c.get("/").headers.get("content-security-policy", "")
        assert "http://127.0.0.1:3456" in csp, f"sibling cockpit origin missing: {csp}"
        frame_src = csp.split("frame-src")[1].split(";")[0]
        assert "127.0.0.1:3456" in frame_src, f"cockpit not in frame-src: {frame_src}"


class TestDashboardCspScope:
    """`_wants_dashboard_csp` must match app shells exactly, never as a bare
    prefix — otherwise owner files like /static-site/ and /enrollment-report.html
    inherit the CDN-blocking dashboard CSP (the SHE-41 breakage)."""

    @staticmethod
    def _req(path):
        from starlette.requests import Request
        scope = {
            "type": "http", "method": "GET", "path": path,
            "headers": [(b"host", b"localhost")], "query_string": b"",
        }
        return Request(scope)

    def test_app_shells_get_csp(self):
        from api.main import _wants_dashboard_csp
        for path in ("/", "/terminal", "/browser", "/static/app.js",
                     "/enroll", "/enroll/device"):
            assert _wants_dashboard_csp(self._req(path)), path

    def test_owner_files_never_get_csp(self):
        from api.main import _wants_dashboard_csp
        # Bare-prefix false positives the exact-or-slash guard must exclude.
        for path in ("/static-site/index.html", "/enrollment-report.html",
                     "/staticx", "/tmp/report.html", "/enrollments"):
            assert not _wants_dashboard_csp(self._req(path)), path

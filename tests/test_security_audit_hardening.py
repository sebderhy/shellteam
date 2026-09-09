"""Regression pack for the 2026-07-18 security audit hardening.

One test per repo finding that got a code fix, asserting the NEW (safe) behavior
so the footgun can't silently return. Findings covered here: H1 (client-IP from
the validated peer), M3/L5 (report-publish confinement + dotfile block), M4
(cert regex pinned to owner), M8 (docs off), L1 (security headers), L4 (non-ASCII
token), and the fail-closed public-bind boot guard (H2 repo-side / L10).
"""

import importlib
import os

import pytest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.main import app
from api.routers.proxy import _get_client_ip


# --- H1: in-box trust from the validated transport peer, not a raw header ---------

def _req(client_host, xff=None):
    headers = {}
    if xff:
        headers["x-forwarded-for"] = xff
    return SimpleNamespace(
        client=SimpleNamespace(host=client_host) if client_host else None,
        headers=headers,
    )


class TestClientIpFromPeer:
    def test_uses_transport_peer_not_header(self):
        # A spoofed X-Forwarded-For: 127.0.0.1 must NOT become the reported client
        # IP — only the validated peer counts (uvicorn --forwarded-allow-ips).
        assert _get_client_ip(_req("203.0.113.9", xff="127.0.0.1")) == "203.0.113.9"

    def test_loopback_peer_reported(self):
        assert _get_client_ip(_req("127.0.0.1")) == "127.0.0.1"

    def test_no_client_is_none(self):
        assert _get_client_ip(_req(None)) is None


# --- M3 / L5: report publishing confined to reports/** + public/**, no dotfiles ---

class TestReportPublishConfinement:
    def _resolve(self, rel, tmp_path):
        from api.services.reports import resolve_report_path
        return resolve_report_path(tmp_path, rel)

    def test_reports_and_public_allowed(self, tmp_path):
        (tmp_path / "reports").mkdir()
        (tmp_path / "reports" / "r.html").write_text("<h1>r</h1>")
        (tmp_path / "public").mkdir()
        (tmp_path / "public" / "p.html").write_text("<h1>p</h1>")
        assert self._resolve("reports/r.html", tmp_path) == "reports/r.html"
        assert self._resolve("public/p.html", tmp_path) == "public/p.html"

    def test_arbitrary_home_file_refused(self, tmp_path):
        # ~/backup.sql has no leading dot, so only the subtree allowlist stops it
        # from becoming a public URL (M3).
        (tmp_path / "backup.sql").write_text("secret")
        with pytest.raises(ValueError):
            self._resolve("backup.sql", tmp_path)

    def test_dotfile_refused(self, tmp_path):
        (tmp_path / "reports").mkdir()
        with pytest.raises(ValueError):
            self._resolve("reports/.env", tmp_path)

    def test_norm_rejects_dotfile_segment(self):
        from api.services.reports import _norm
        with pytest.raises(ValueError):
            _norm("reports/.ssh/id_rsa")


# --- M4: on-demand-TLS cert issuance pinned to the owner's labels -----------------

class TestCertRegexPinnedToOwner:
    def test_only_owner_labels_match(self):
        from api.routers.internal import _VALID_SUBDOMAIN_RE
        from api.config import OWNER_USERNAME, APP_DOMAIN

        assert _VALID_SUBDOMAIN_RE.match(f"{OWNER_USERNAME}.{APP_DOMAIN}")
        assert _VALID_SUBDOMAIN_RE.match(f"{OWNER_USERNAME}-3000.{APP_DOMAIN}")
        # A stranger's label must NOT trigger an ACME order.
        assert not _VALID_SUBDOMAIN_RE.match(f"aaa1.{APP_DOMAIN}")
        assert not _VALID_SUBDOMAIN_RE.match(f"attacker.{APP_DOMAIN}")


# --- M8: OpenAPI schema / docs are off by default ---------------------------------

class TestDocsOff:
    def test_openapi_and_docs_closed(self):
        with TestClient(app) as client:
            assert client.get("/openapi.json").status_code == 404
            assert client.get("/docs").status_code == 404
            assert client.get("/redoc").status_code == 404


# --- L1: security headers on the dashboard shell ----------------------------------

class TestSecurityHeaders:
    def test_dashboard_headers(self):
        with TestClient(app) as client:
            r = client.get("/", headers={"host": "localhost"})
        csp = r.headers.get("content-security-policy", "")
        assert "frame-ancestors 'self'" in csp
        assert r.headers.get("x-frame-options") == "SAMEORIGIN"
        # Permissions-Policy denies the risky features but MUST delegate the
        # microphone to the cross-origin cockpit iframe, or voice input breaks
        # (regression: `microphone=(self)` alone blocked the cockpit's getUserMedia).
        pp = r.headers.get("permissions-policy", "")
        assert "camera=()" in pp and "geolocation=()" in pp
        # Delegated to the cockpit origin (localhost:3456 in the hermetic env,
        # <owner>-3456.<domain> in domain mode) — never bare `microphone=(self)`.
        assert 'microphone=(self "' in pp and ":3456" in pp
        assert pp.count("microphone=(self)") == 0
        # Stack banner is masked on every response.
        assert r.headers.get("server") == "ShellTeam"


# --- L4: a non-ASCII Authorization value must not 500 -----------------------------

class TestNonAsciiToken:
    def test_token_is_owner_handles_non_ascii(self):
        from api.services.auth import token_is_owner, token_grants_files_read

        # uvicorn decodes header bytes as latin-1, so a junk Authorization value
        # reaches these as a non-ASCII str. The old str-vs-str compare_digest
        # raised TypeError → unhandled 500; the bytes compare is total (L4).
        assert token_is_owner("Ünïcödé-☃") is False
        assert token_grants_files_read("Ünïcödé-☃") is False
        # verify_token wraps it into a clean 401, never a crash.
        from api.services.auth import verify_token
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as e:
            verify_token("Ünïcödé-☃")
        assert e.value.status_code == 401


# --- Fail-closed public bind without a token (H2 repo-side / structural theme) -----

class TestPublicBindGuard:
    def _reload_main(self, monkeypatch, app_domain, token, allow=""):
        monkeypatch.setenv("APP_DOMAIN", app_domain)
        monkeypatch.setenv("OWNER_TOKEN", token)
        if allow:
            monkeypatch.setenv("ALLOW_TOKENLESS_PUBLIC", allow)
        else:
            monkeypatch.delenv("ALLOW_TOKENLESS_PUBLIC", raising=False)
        import api.config as cfg
        importlib.reload(cfg)
        import api.main as m
        importlib.reload(m)
        return m

    def test_public_bind_without_token_refuses_to_boot(self, monkeypatch):
        m = self._reload_main(monkeypatch, "box.example.com", "")
        with pytest.raises(RuntimeError, match="public bind"):
            with TestClient(m.app):
                pass
        # Restore the hermetic module state for the rest of the session.
        self._reload_main(monkeypatch, "localhost", "fake-jwt-token")

    def test_public_bind_with_token_boots(self, monkeypatch):
        m = self._reload_main(monkeypatch, "box.example.com", "a-strong-token")
        with TestClient(m.app):
            pass
        self._reload_main(monkeypatch, "localhost", "fake-jwt-token")

    def test_escape_hatch_allows_tokenless_public(self, monkeypatch):
        m = self._reload_main(monkeypatch, "box.example.com", "", allow="1")
        with TestClient(m.app):
            pass
        self._reload_main(monkeypatch, "localhost", "fake-jwt-token")

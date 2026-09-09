"""Regression tests for the exposure-audit hardening (2026-07-28).

F4: ~/public is no longer an ambient world-readable mount — publishing is the
only path to a public URL, and a published DIRECTORY covers its children.
F5: published/served home content carries X-Robots-Tag: noindex; robots.txt is
served unauthenticated with Disallow: /.
F3: reports.exposure() enumerates every world-readable path.
Uniform-401: a private path and a nonexistent path are byte-identical.
"""

import httpx
import pytest
import respx
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from api.main import app
from api.services import reports


# --- F4: directory publishing + no ambient grant ---------------------------------

class TestPublishedDirectoryCoversChildren:
    def test_directory_entry_matches_children_by_segment(self, monkeypatch):
        monkeypatch.setattr(reports, "_public_reports", {"owner": {"public/logos"}})
        assert reports.is_report_public("owner", "public/logos") is True
        assert reports.is_report_public("owner", "public/logos/a.svg") is True
        assert reports.is_report_public("owner", "public/logos/sub/b.svg") is True
        # Segment prefix, never a substring — logos must not grant logos-secret.
        assert reports.is_report_public("owner", "public/logos-secret/x") is False
        assert reports.is_report_public("owner", "public/other.html") is False

    def test_bare_public_write_is_not_public(self, monkeypatch):
        monkeypatch.setattr(reports, "_public_reports", {})
        assert reports.is_report_public("owner", "public/anything.html") is False


class TestMigrationAndExposure:
    def test_migration_publishes_existing_public_content_once(self, tmp_path, monkeypatch):
        monkeypatch.setattr(reports, "_public_reports", {})
        monkeypatch.setattr(reports, "DATA_DIR", tmp_path / "data")
        home = tmp_path / "home"
        (home / "public" / "logos").mkdir(parents=True)
        (home / "public" / "logos" / "a.svg").write_text("<svg/>")
        (home / "public" / "site.html").write_text("<h1>hi</h1>")
        (home / "public" / ".hidden").write_text("no")

        migrated = reports.migrate_ambient_public_grant("owner", home)
        assert set(migrated) == {"public/logos", "public/site.html"}
        # Dotfiles are never auto-published.
        assert "public/.hidden" not in migrated
        # Idempotent: a second run does nothing (marker written).
        assert reports.migrate_ambient_public_grant("owner", home) == []

    def test_exposure_reports_file_counts(self, tmp_path, monkeypatch):
        monkeypatch.setattr(reports, "_public_reports", {"owner": {"public/logos", "reports/r.html"}})
        home = tmp_path
        (home / "public" / "logos").mkdir(parents=True)
        (home / "public" / "logos" / "a.svg").write_text("x")
        (home / "public" / "logos" / "b.svg").write_text("y")
        (home / "reports").mkdir()
        (home / "reports" / "r.html").write_text("<h1/>")

        entries = {e["path"]: e for e in reports.exposure("owner", home)}
        assert entries["public/logos"]["kind"] == "directory"
        assert entries["public/logos"]["files"] == 2
        assert entries["reports/r.html"]["kind"] == "file"


# --- F5: noindex + robots.txt ----------------------------------------------------

class TestNoIndex:
    def test_robots_txt_is_unauthenticated_disallow_all(self):
        with TestClient(app) as client:
            r = client.get("/robots.txt")
        assert r.status_code == 200
        assert "Disallow: /" in r.text

    @respx.mock
    def test_served_home_file_carries_noindex_header(self):
        respx.get("http://127.0.0.1:80/reports/pub.html").mock(
            return_value=httpx.Response(200, text="<h1>report</h1>",
                                        headers={"content-type": "text/html"})
        )
        with patch("api.routers.proxy.reports.is_report_public", return_value=True):
            with TestClient(app) as client:
                r = client.get("/reports/pub.html", headers={"host": "localhost"})
        assert r.status_code == 200
        assert r.headers.get("x-robots-tag") == "noindex, nofollow"

    def test_dashboard_shell_is_not_noindexed(self):
        with TestClient(app) as client:
            r = client.get("/", headers={"host": "localhost"})
        assert r.headers.get("x-robots-tag") is None


# --- Uniform 401: private vs nonexistent are indistinguishable --------------------

class TestUniform401:
    @respx.mock
    def test_private_and_nonexistent_are_byte_identical(self, monkeypatch):
        # Neither path is published, so both are refused before any upstream hit.
        monkeypatch.setattr(reports, "_public_reports", {})
        with TestClient(app) as client:
            private = client.get("/reports/real-but-private.html", headers={"host": "localhost"})
            missing = client.get("/reports/does-not-exist.html", headers={"host": "localhost"})
        assert private.status_code == missing.status_code == 401
        assert private.content == missing.content

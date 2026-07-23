"""Report visibility: the private→public allowlist + the proxy auth gate that
honors it. Mirrors the ports model (see test_proxy.py / ports)."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import respx

from api.services import reports
from api.routers.proxy import proxy_subdomain, FILE_PORT


@pytest.fixture(autouse=True)
def _clean_reports():
    """Isolate the module-level visibility state between tests."""
    reports._public_reports.clear()
    yield
    reports._public_reports.clear()


# --- Service ------------------------------------------------------------------

class TestReportsService:
    def test_default_is_private(self):
        assert reports.is_report_public("owner", "reports/x.html") is False

    def test_publish_then_unpublish(self):
        reports.DATA_DIR  # noqa: B018 (module attr exists)
        reports._public_reports["owner"] = {"reports/x.html"}
        assert reports.is_report_public("owner", "reports/x.html") is True
        reports._public_reports["owner"].discard("reports/x.html")
        assert reports.is_report_public("owner", "reports/x.html") is False

    def test_leading_slash_normalized_on_lookup(self):
        reports._public_reports["owner"] = {"reports/x.html"}
        assert reports.is_report_public("owner", "/reports/x.html") is True

    def test_set_visibility_persists_and_seeds(self, tmp_path, monkeypatch):
        monkeypatch.setattr(reports, "DATA_DIR", tmp_path)
        result = reports.set_report_visibility("owner", "reports/x.html", True)
        assert result == {"reports/x.html"}
        assert (tmp_path / "owner" / "public_reports.json").exists()
        # Fresh process would re-load it:
        reports._public_reports.clear()
        reports.seed_from_disk()
        assert reports.is_report_public("owner", "reports/x.html") is True
        # Unpublish removes the file.
        reports.set_report_visibility("owner", "reports/x.html", False)
        assert not (tmp_path / "owner" / "public_reports.json").exists()

    def test_traversal_rejected(self):
        with pytest.raises(ValueError):
            reports.set_report_visibility("owner", "../etc/passwd", True)

    def test_cap_enforced(self, tmp_path, monkeypatch):
        monkeypatch.setattr(reports, "DATA_DIR", tmp_path)
        monkeypatch.setattr(reports, "MAX_PUBLIC_REPORTS", 2)
        reports.set_report_visibility("owner", "a.html", True)
        reports.set_report_visibility("owner", "b.html", True)
        with pytest.raises(ValueError, match="Maximum"):
            reports.set_report_visibility("owner", "c.html", True)


# --- Proxy auth gate ----------------------------------------------------------

def _remote_request(path: str):
    """A request from a non-local client (so the localhost-trust bypass doesn't
    apply) with no auth cookie — i.e. a stranger with the link."""
    request = MagicMock()
    request.headers = {"host": "alice.localhost", "x-forwarded-for": "203.0.113.7"}
    request.cookies = {}
    request.method = "GET"
    request.url = MagicMock()
    request.url.query = ""
    request.body = AsyncMock(return_value=b"")
    return request


class TestProxyReportGate:
    @pytest.mark.asyncio
    async def test_unpublished_report_requires_auth(self):
        request = _remote_request("reports/secret.html")
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner"),
        ):
            resp = await proxy_subdomain(request, "reports/secret.html")
        # No cookie → login required (401), never reaches the file server.
        assert resp.status_code == 401

    @pytest.mark.asyncio
    @respx.mock
    async def test_published_report_is_served_without_auth(self):
        reports._public_reports["owner"] = {"reports/secret.html"}
        respx.get(f"http://172.20.0.5:{FILE_PORT}/reports/secret.html").mock(
            return_value=httpx.Response(200, text="<h1>report</h1>",
                                        headers={"content-type": "text/html"})
        )
        request = _remote_request("reports/secret.html")
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner"),
        ):
            resp = await proxy_subdomain(request, "reports/secret.html")
        assert resp.status_code == 200
        assert b"report" in resp.body

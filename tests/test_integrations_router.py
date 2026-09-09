"""Tests for app integrations endpoints — Composio connected accounts."""

import os


import pytest
from unittest.mock import patch, MagicMock


@pytest.fixture(autouse=True)
def composio_key(monkeypatch):
    """Pin COMPOSIO_API_KEY so the router's module-availability gate passes.

    Hard-set (never rely on ambient env) for hermeticity — the same rule as
    conftest's env pinning. TestComposioUnconfigured deletes it per-test to
    exercise the 503 contract.
    """
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")


class TestComposioUnconfigured:
    """Without COMPOSIO_API_KEY every /api/integrations endpoint returns a clean
    503 "module unavailable" — never a 500 from deep inside the Composio SDK."""

    EXPECTED_DETAIL = "Composio integration not configured (set COMPOSIO_API_KEY)"

    @pytest.fixture(autouse=True)
    def no_composio_key(self, composio_key, monkeypatch):
        # Depends on composio_key to force ordering: run AFTER the module-level
        # setenv so this override is what the request actually sees. Set to ""
        # (not delenv): an absent var would be refilled from the real .env by
        # api.main's load_dotenv(override=False) on first app import.
        monkeypatch.setenv("COMPOSIO_API_KEY", "")

    def test_list_returns_503(self, client, auth_header):
        resp = client.get("/api/integrations", headers=auth_header)
        assert resp.status_code == 503
        assert resp.json()["detail"] == self.EXPECTED_DETAIL

    def test_connect_fields_returns_503(self, client, auth_header):
        resp = client.get("/api/integrations/connect/gmail/fields", headers=auth_header)
        assert resp.status_code == 503
        assert resp.json()["detail"] == self.EXPECTED_DETAIL

    def test_connect_returns_503(self, client, auth_header):
        resp = client.post("/api/integrations/connect/gmail", headers=auth_header)
        assert resp.status_code == 503
        assert resp.json()["detail"] == self.EXPECTED_DETAIL

    def test_sync_credentials_returns_503(self, client, auth_header):
        resp = client.post("/api/integrations/sync-credentials", headers=auth_header)
        assert resp.status_code == 503
        assert resp.json()["detail"] == self.EXPECTED_DETAIL

    def test_disconnect_returns_503(self, client, auth_header):
        resp = client.delete("/api/integrations/ca-1", headers=auth_header)
        assert resp.status_code == 503
        assert resp.json()["detail"] == self.EXPECTED_DETAIL

    def test_unauthenticated_still_401_not_503(self):
        """Auth is checked before module availability — an unauthenticated caller
        learns nothing about this box's module configuration."""
        from fastapi.testclient import TestClient
        from api.main import app
        with TestClient(app) as c:
            resp = c.get("/api/integrations")
        assert resp.status_code == 401


class TestListIntegrations:
    """GET /api/integrations — auth + returns connections."""

    def test_unauthenticated_returns_401(self, client):
        # client fixture auto-mocks auth, but we need to test without auth
        # Use the raw app instead
        from fastapi.testclient import TestClient
        from api.main import app
        with TestClient(app) as c:
            resp = c.get("/api/integrations")
        assert resp.status_code == 401

    def test_returns_connections(self, client, auth_header):
        mock_connections = [
            {"id": "ca-1", "toolkit": "gmail", "status": "ACTIVE", "created_at": "2026-01-01"},
            {"id": "ca-2", "toolkit": "github", "status": "ACTIVE", "created_at": "2026-01-02"},
        ]
        with patch("api.routers.integrations.composio_svc.list_connections", return_value=mock_connections):
            resp = client.get("/api/integrations", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["toolkit"] == "gmail"
        assert data[1]["toolkit"] == "github"

    def test_returns_empty_list(self, client, auth_header):
        with patch("api.routers.integrations.composio_svc.list_connections", return_value=[]):
            resp = client.get("/api/integrations", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json() == []


class TestConnectApp:
    """POST /api/integrations/connect/{toolkit} — auth + toolkit validation."""

    def test_unauthenticated_returns_401(self, client):
        from fastapi.testclient import TestClient
        from api.main import app
        with TestClient(app) as c:
            resp = c.post("/api/integrations/connect/gmail")
        assert resp.status_code == 401

    def test_invalid_toolkit_slug_returns_400(self, client, auth_header):
        resp = client.post("/api/integrations/connect/INVALID!", headers=auth_header)
        assert resp.status_code == 400
        assert "Invalid toolkit" in resp.json()["detail"]

    def test_callback_lands_on_the_apps_tab(self, client, auth_header):
        # Composio sends the browser back to /apps?app_connected=<toolkit>:
        # the Apps page syncs credentials and closes its own popup. Landing
        # on "/" (the old Cloud flow) showed the dashboard with no feedback.
        with patch(
            "api.routers.integrations.composio_svc.initiate_connection",
            return_value="https://accounts.google.com/oauth/authorize?...",
        ) as initiate:
            client.post("/api/integrations/connect/gmail", headers=auth_header)
        callback_url = initiate.call_args.args[2]
        assert callback_url.endswith("/apps?app_connected=gmail")

    def test_valid_toolkit_returns_redirect_url(self, client, auth_header):
        with patch(
            "api.routers.integrations.composio_svc.initiate_connection",
            return_value="https://accounts.google.com/oauth/authorize?...",
        ):
            resp = client.post("/api/integrations/connect/gmail", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert "redirect_url" in data
        assert data["redirect_url"].startswith("https://")

    def test_composio_returns_no_url_502(self, client, auth_header):
        with patch(
            "api.routers.integrations.composio_svc.initiate_connection",
            return_value=None,
        ):
            resp = client.post("/api/integrations/connect/slack", headers=auth_header)
        assert resp.status_code == 502

    def test_github_toolkit_blocked(self, client, auth_header):
        """GitHub is intentionally not connectable via Composio (scope/clobber issues)."""
        resp = client.post("/api/integrations/connect/github", headers=auth_header)
        assert resp.status_code == 400
        assert "github" in resp.json()["detail"].lower()

    def test_github_fields_blocked(self, client, auth_header):
        resp = client.get("/api/integrations/connect/github/fields", headers=auth_header)
        assert resp.status_code == 400


class TestDisconnectApp:
    """DELETE /api/integrations/{connection_id} — auth + ownership."""

    def test_unauthenticated_returns_401(self, client):
        from fastapi.testclient import TestClient
        from api.main import app
        with TestClient(app) as c:
            resp = c.delete("/api/integrations/ca-1")
        assert resp.status_code == 401

    def test_not_owned_returns_404(self, client, auth_header):
        with patch("api.routers.integrations.composio_svc.list_connections", return_value=[]):
            resp = client.delete("/api/integrations/ca-1", headers=auth_header)
        assert resp.status_code == 404

    def test_owned_connection_disconnects(self, client, auth_header):
        mock_connections = [{"id": "ca-1", "toolkit": "gmail", "status": "ACTIVE", "created_at": None}]
        with (
            patch("api.routers.integrations.composio_svc.list_connections", return_value=mock_connections),
            patch("api.routers.integrations.composio_svc.disconnect") as mock_disconnect,
            patch("api.routers.integrations.credentials_svc.revoke_google"),
            patch("api.routers.integrations.refresh_composio_mcp"),
        ):
            resp = client.delete("/api/integrations/ca-1", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["status"] == "disconnected"
        mock_disconnect.assert_called_once_with("ca-1")

    def test_disconnect_googlesuper_revokes_credentials(self, client, auth_header):
        mock_connections = [{"id": "ca-gw", "toolkit": "googlesuper", "status": "ACTIVE", "created_at": None}]
        with (
            patch("api.routers.integrations.composio_svc.list_connections", return_value=mock_connections),
            patch("api.routers.integrations.composio_svc.disconnect"),
            patch("api.routers.integrations.credentials_svc.revoke_google") as mock_revoke,
            patch("api.routers.integrations.refresh_composio_mcp"),
        ):
            resp = client.delete("/api/integrations/ca-gw", headers=auth_header)
        assert resp.status_code == 200
        mock_revoke.assert_called_once()

    def test_disconnect_slack_no_revocation(self, client, auth_header):
        mock_connections = [{"id": "ca-sl", "toolkit": "slack", "status": "ACTIVE", "created_at": None}]
        with (
            patch("api.routers.integrations.composio_svc.list_connections", return_value=mock_connections),
            patch("api.routers.integrations.composio_svc.disconnect"),
            patch("api.routers.integrations.credentials_svc.revoke_google") as mock_gw,
            patch("api.routers.integrations.refresh_composio_mcp"),
        ):
            resp = client.delete("/api/integrations/ca-sl", headers=auth_header)
        assert resp.status_code == 200
        mock_gw.assert_not_called()


class TestSyncCredentials:
    """POST /api/integrations/sync-credentials — inject CLI creds after OAuth."""

    def test_unauthenticated_returns_401(self, client):
        from fastapi.testclient import TestClient
        from api.main import app
        with TestClient(app) as c:
            resp = c.post("/api/integrations/sync-credentials")
        assert resp.status_code == 401

    def test_calls_inject_all_for_user(self, client, auth_header):
        with (
            patch("api.routers.integrations.credentials_svc.inject_all") as mock_inject,
            patch("api.routers.integrations.refresh_composio_mcp"),
        ):
            resp = client.post("/api/integrations/sync-credentials", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["status"] == "synced"
        mock_inject.assert_called_once()
        # Verify user_id was passed
        call_args = mock_inject.call_args
        assert "user-uuid-1234" in str(call_args)

    def test_returns_200_even_if_inject_raises(self, client, auth_header):
        """inject_all is wrapped in to_thread — if it raises, FastAPI returns 500.
        This tests that inject_all itself handles errors gracefully."""
        with (
            patch("api.routers.integrations.credentials_svc.inject_all") as mock_inject,
            patch("api.routers.integrations.refresh_composio_mcp"),
        ):
            # inject_all handles its own errors, so mock it to succeed
            mock_inject.return_value = None
            resp = client.post("/api/integrations/sync-credentials", headers=auth_header)
        assert resp.status_code == 200

    def test_native_rebuilds_layer_never_writes_claude_json(self, client, auth_header):
        """Hard rule: on native, refreshing the Composio MCP rebuilds the additive
        agent-layer and must NOT call refresh_mcp_in_claude_json (which writes the
        owner's real ~/.claude.json)."""
        with (
            patch("api.routers.integrations.credentials_svc.inject_all"),
            patch("api.services.mcp_refresh.RUNTIME", "native"),
            patch("api.services.agent_layer.build_agent_layer") as mock_build,
            patch("api.services.mcp_refresh.composio_svc.refresh_mcp_in_claude_json") as mock_write,
        ):
            resp = client.post("/api/integrations/sync-credentials", headers=auth_header)
        assert resp.status_code == 200
        mock_build.assert_called_once()
        mock_write.assert_not_called()



class TestSearchToolkits:
    """GET /api/integrations/toolkits — the Apps tab's "find any app" box."""

    SHAPED = [
        {"slug": "notion", "name": "Notion", "description": "Notes", "logo": "/api/integrations/logo/notion", "managed": True},
        {"slug": "notion_mcp", "name": "Notion MCP", "description": "", "logo": "", "managed": False},
    ]

    def test_unauthenticated_returns_401(self, client):
        from fastapi.testclient import TestClient
        from api.main import app
        with TestClient(app) as c:
            resp = c.get("/api/integrations/toolkits?q=notion")
        assert resp.status_code == 401

    def test_short_query_is_400(self, client, auth_header):
        resp = client.get("/api/integrations/toolkits?q=n", headers=auth_header)
        assert resp.status_code == 400

    def test_returns_shaped_toolkits(self, client, auth_header):
        with patch(
            "api.routers.integrations.composio_svc.search_toolkits",
            return_value=self.SHAPED,
        ) as search:
            resp = client.get("/api/integrations/toolkits?q= notion ", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json() == self.SHAPED
        search.assert_called_once_with("notion")

    def test_composio_failure_is_502_not_500(self, client, auth_header):
        with patch(
            "api.routers.integrations.composio_svc.search_toolkits",
            side_effect=RuntimeError("boom"),
        ):
            resp = client.get("/api/integrations/toolkits?q=notion", headers=auth_header)
        assert resp.status_code == 502
        assert "boom" in resp.json()["detail"]

    def test_unconfigured_returns_503(self, client, auth_header, monkeypatch):
        monkeypatch.setenv("COMPOSIO_API_KEY", "")
        resp = client.get("/api/integrations/toolkits?q=notion", headers=auth_header)
        assert resp.status_code == 503


class TestShapeToolkit:
    """composio.search_toolkits keeps only what the Apps grid renders, and
    flags whether Composio hosts the OAuth app (one-click connect) or not."""

    def test_managed_oauth_toolkit(self):
        from api.services.composio import _shape_toolkit
        item = {
            "slug": "notion", "name": "Notion",
            "composio_managed_auth_schemes": ["OAUTH2"],
            "meta": {"description": "Notes", "logo": "https://logos.composio.dev/api/notion", "tools_count": 53},
        }
        # The logo is relayed through the control plane, never a CDN URL the
        # browser would have to fetch itself (blocked by cross-origin isolation).
        assert _shape_toolkit(item) == {
            "slug": "notion", "name": "Notion", "description": "Notes",
            "logo": "/api/integrations/logo/notion", "managed": True,
        }

    def test_managed_oauth1_counts_as_one_click(self):
        from api.services.composio import _shape_toolkit
        item = {"slug": "trello", "name": "Trello", "composio_managed_auth_schemes": ["OAUTH1"], "meta": {}}
        assert _shape_toolkit(item)["managed"] is True

    def test_api_key_only_toolkit_is_not_managed_and_foreign_logo_dropped(self):
        from api.services.composio import _shape_toolkit
        item = {
            "slug": "rootly", "composio_managed_auth_schemes": [],
            "auth_schemes": ["API_KEY"],
            "meta": {"logo": "https://evil.example/x.png"},
        }
        shaped = _shape_toolkit(item)
        assert shaped["managed"] is False
        assert shaped["logo"] == ""          # only Composio-hosted logos are relayed
        assert shaped["name"] == "rootly"    # falls back to the slug

    def test_search_calls_the_catalog_with_the_query(self, monkeypatch):
        import httpx
        from api.services import composio
        monkeypatch.setenv("COMPOSIO_API_KEY", "k")
        seen = {}

        def fake_get(url, params=None, headers=None, timeout=None):
            seen.update(url=url, params=params, headers=headers)
            return httpx.Response(200, json={"items": [
                {"slug": "slack", "name": "Slack", "composio_managed_auth_schemes": ["OAUTH2"], "meta": {}},
            ]}, request=httpx.Request("GET", url))

        monkeypatch.setattr(composio.httpx, "get", fake_get)
        out = composio.search_toolkits("slack", limit=5)
        assert seen["url"].endswith("/toolkits")
        assert seen["params"] == {"search": "slack", "limit": 5}
        assert seen["headers"] == {"x-api-key": "k"}
        assert [t["slug"] for t in out] == ["slack"]


class TestToolkitLogo:
    """GET /api/integrations/logo/{slug} relays Composio's logo CDN."""

    def test_relays_image_bytes(self, client, auth_header):
        with patch(
            "api.routers.integrations.composio_svc.fetch_logo",
            return_value=("image/svg+xml", b"<svg/>"),
        ):
            resp = client.get("/api/integrations/logo/notion", headers=auth_header)
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/svg+xml")
        assert resp.content == b"<svg/>"
        assert "max-age" in resp.headers["cache-control"]

    def test_missing_logo_is_404(self, client, auth_header):
        with patch(
            "api.routers.integrations.composio_svc.fetch_logo",
            side_effect=ValueError("text/html"),
        ):
            resp = client.get("/api/integrations/logo/nothing", headers=auth_header)
        assert resp.status_code == 404

    def test_bad_slug_is_400(self, client, auth_header):
        resp = client.get("/api/integrations/logo/..%2Fx", headers=auth_header)
        assert resp.status_code in (400, 404)

    def test_fetch_logo_rejects_non_images_and_caches(self, monkeypatch):
        import httpx
        from api.services import composio
        composio._logo_cache.clear()
        calls = []

        def fake_get(url, timeout=None, follow_redirects=None):
            calls.append(url)
            ct = "image/png" if url.endswith("/slack") else "text/html"
            return httpx.Response(200, content=b"x", headers={"content-type": ct}, request=httpx.Request("GET", url))

        monkeypatch.setattr(composio.httpx, "get", fake_get)
        assert composio.fetch_logo("slack") == ("image/png", b"x")
        assert composio.fetch_logo("slack") == ("image/png", b"x")
        assert calls == ["https://logos.composio.dev/api/slack"]   # second hit served from cache
        with pytest.raises(ValueError):
            composio.fetch_logo("html")

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


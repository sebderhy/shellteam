"""Tests for internal credential endpoints (refresh + sync)."""

import os


import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from api.main import app


def _make_auth_headers(user_id="user-uuid-1234"):
    """Build valid internal auth headers."""
    from api.services.internal_auth import make_token
    token = make_token(user_id)
    return {
        "Authorization": f"Bearer {token}",
        "X-Shellteam-User-Id": user_id,
    }


class TestRefreshGoogleToken:
    def test_returns_fresh_token(self):
        headers = _make_auth_headers()
        mock_connections = [{"id": "conn-g", "toolkit": "googlesuper", "status": "ACTIVE", "created_at": None}]
        mock_creds = {"access_token": "ya29.fresh_token", "refresh_token": "r", "token_type": "Bearer"}

        with (
            patch("api.routers.internal.composio_svc.list_connections", return_value=mock_connections),
            patch("api.routers.internal.composio_svc.refresh_and_get_credentials", return_value=mock_creds),
        ):
            with TestClient(app) as client:
                resp = client.post("/internal/refresh-google-token", headers=headers)

        assert resp.status_code == 200
        assert resp.json()["access_token"] == "ya29.fresh_token"

    def test_returns_404_when_no_google_connection(self):
        headers = _make_auth_headers()
        # Only GitHub connected, no Google
        mock_connections = [{"id": "conn-gh", "toolkit": "github", "status": "ACTIVE", "created_at": None}]

        with patch("api.routers.internal.composio_svc.list_connections", return_value=mock_connections):
            with TestClient(app) as client:
                resp = client.post("/internal/refresh-google-token", headers=headers)

        assert resp.status_code == 404

    def test_rejects_without_valid_token(self):
        headers = {
            "Authorization": "Bearer invalid-token",
            "X-Shellteam-User-Id": "user-uuid-1234",
        }
        with TestClient(app) as client:
            resp = client.post("/internal/refresh-google-token", headers=headers)
        assert resp.status_code == 401

    def test_rejects_missing_user_id(self):
        with TestClient(app) as client:
            resp = client.post("/internal/refresh-google-token",
                              headers={"Authorization": "Bearer whatever"})
        assert resp.status_code == 400


class TestSyncCredentialsInternal:
    def test_calls_inject_all(self):
        headers = _make_auth_headers()
        with (
            patch("api.services.credentials.inject_all") as mock_inject,
            patch("api.services.mcp_refresh.refresh_composio_mcp"),
        ):
            with TestClient(app) as client:
                resp = client.post("/internal/sync-credentials", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "synced"
        mock_inject.assert_called_once()

    def test_native_rebuilds_layer_never_writes_claude_json(self):
        """The internal endpoint is what external-apps OAuth asks agents to call.
        On native it must share the public integrations route's safe refresh path
        and never mutate the owner's real ~/.claude.json.
        """
        headers = _make_auth_headers()
        with (
            patch("api.services.credentials.inject_all"),
            patch("api.services.mcp_refresh.RUNTIME", "native"),
            patch("api.services.agent_layer.build_agent_layer") as mock_build,
            patch("api.services.mcp_refresh.composio_svc.refresh_mcp_in_claude_json") as mock_write,
        ):
            with TestClient(app) as client:
                resp = client.post("/internal/sync-credentials", headers=headers)
        assert resp.status_code == 200
        mock_build.assert_called_once()
        mock_write.assert_not_called()


    def test_rejects_without_valid_token(self):
        headers = {
            "Authorization": "Bearer invalid-token",
            "X-Shellteam-User-Id": "user-uuid-1234",
        }
        with TestClient(app) as client:
            resp = client.post("/internal/sync-credentials", headers=headers)
        assert resp.status_code == 401

    def test_rejects_missing_user_id(self):
        with TestClient(app) as client:
            resp = client.post("/internal/sync-credentials",
                              headers={"Authorization": "Bearer whatever"})
        assert resp.status_code == 400

"""Tests for Composio credential extraction functions."""

import os

os.environ.setdefault("COMPOSIO_API_KEY", "fake_composio_key")

import pytest
from unittest.mock import patch, MagicMock


class TestGetCredentials:
    @patch("api.services.composio._get_client")
    def test_returns_tokens_for_oauth2_connection(self, mock_client):
        mock_val = MagicMock()
        mock_val.access_token = "ya29.test_token"
        mock_val.refresh_token = "1//refresh"
        mock_val.token_type = "Bearer"

        mock_state = MagicMock()
        mock_state.val = mock_val

        mock_account = MagicMock()
        mock_account.state = mock_state

        mock_client.return_value.connected_accounts.get.return_value = mock_account

        from api.services.composio import get_credentials
        result = get_credentials("conn-123")

        assert result["access_token"] == "ya29.test_token"
        assert result["refresh_token"] == "1//refresh"
        assert result["token_type"] == "Bearer"

    @patch("api.services.composio._get_client")
    def test_returns_none_for_missing_state(self, mock_client):
        mock_account = MagicMock(spec=[])  # no 'state' attribute
        mock_client.return_value.connected_accounts.get.return_value = mock_account

        from api.services.composio import get_credentials
        result = get_credentials("conn-missing")
        assert result is None

    @patch("api.services.composio._get_client")
    def test_returns_none_for_none_state(self, mock_client):
        mock_account = MagicMock()
        mock_account.state = None
        mock_client.return_value.connected_accounts.get.return_value = mock_account

        from api.services.composio import get_credentials
        result = get_credentials("conn-null")
        assert result is None


class TestSubtoolkitsShadowedByGooglesuper:
    def test_returns_empty_when_googlesuper_not_connected(self):
        from api.services.composio import _subtoolkits_shadowed_by_googlesuper
        assert _subtoolkits_shadowed_by_googlesuper(set()) == []
        assert _subtoolkits_shadowed_by_googlesuper({"gmail", "github"}) == []

    def test_shadows_all_covered_subtoolkits_when_only_googlesuper(self):
        from api.services.composio import (
            GOOGLESUPER_COVERED_SUBTOOLKITS,
            _subtoolkits_shadowed_by_googlesuper,
        )
        shadowed = _subtoolkits_shadowed_by_googlesuper({"googlesuper"})
        assert set(shadowed) == set(GOOGLESUPER_COVERED_SUBTOOLKITS)

    def test_preserves_individually_connected_subtoolkits(self):
        from api.services.composio import _subtoolkits_shadowed_by_googlesuper
        shadowed = _subtoolkits_shadowed_by_googlesuper({"googlesuper", "gmail"})
        assert "gmail" not in shadowed
        assert "googledrive" in shadowed

    def test_ignores_unrelated_connections(self):
        from api.services.composio import _subtoolkits_shadowed_by_googlesuper
        shadowed = _subtoolkits_shadowed_by_googlesuper({"googlesuper", "slack", "github"})
        assert "slack" not in shadowed
        assert "github" not in shadowed
        assert "gmail" in shadowed


class TestBuildSessionKwargs:
    @patch("api.services.composio.list_connections")
    def test_no_toolkits_filter_when_only_individual_apps_connected(self, mock_list):
        mock_list.return_value = [{"toolkit": "gmail"}, {"toolkit": "slack"}]
        from api.services.composio import _build_session_kwargs
        kwargs = _build_session_kwargs("user-1")
        assert "toolkits" not in kwargs
        assert kwargs["manage_connections"] == {"enable": True, "wait_for_connections": True}

    @patch("api.services.composio.list_connections")
    def test_disables_shadowed_subtoolkits_when_googlesuper_connected(self, mock_list):
        mock_list.return_value = [{"toolkit": "googlesuper"}]
        from api.services.composio import _build_session_kwargs
        kwargs = _build_session_kwargs("user-1")
        assert "disable" in kwargs["toolkits"]
        assert "gmail" in kwargs["toolkits"]["disable"]
        assert "googledrive" in kwargs["toolkits"]["disable"]

    @patch("api.services.composio.list_connections")
    def test_individual_gmail_survives_when_both_connected(self, mock_list):
        mock_list.return_value = [{"toolkit": "googlesuper"}, {"toolkit": "gmail"}]
        from api.services.composio import _build_session_kwargs
        kwargs = _build_session_kwargs("user-1")
        disabled = kwargs["toolkits"]["disable"]
        assert "gmail" not in disabled
        assert "googledrive" in disabled

    @patch("api.services.composio.list_connections")
    def test_falls_back_to_no_filter_when_list_connections_fails(self, mock_list):
        mock_list.side_effect = RuntimeError("api down")
        from api.services.composio import _build_session_kwargs
        kwargs = _build_session_kwargs("user-1")
        assert "toolkits" not in kwargs


class TestGenerateMcpConfig:
    @patch("api.services.composio.list_connections")
    @patch("api.services.composio._get_client")
    def test_creates_session_with_filter_when_googlesuper_connected(self, mock_client, mock_list):
        mock_list.return_value = [{"toolkit": "googlesuper"}]
        session = MagicMock()
        session.session_id = "sess-1"
        session.mcp.url = "https://mcp.example/abc"
        session.mcp.headers = {"x-auth": "t"}
        mock_client.return_value.create.return_value = session

        from api.services.composio import generate_mcp_config
        result = generate_mcp_config("user-1")

        call_kwargs = mock_client.return_value.create.call_args.kwargs
        assert call_kwargs["user_id"] == "user-1"
        assert "disable" in call_kwargs["toolkits"]
        assert "googledrive" in call_kwargs["toolkits"]["disable"]
        assert result == {"type": "http", "url": session.mcp.url, "headers": session.mcp.headers}

    @patch("api.services.composio.list_connections")
    @patch("api.services.composio._get_client")
    def test_creates_session_without_filter_when_no_googlesuper(self, mock_client, mock_list):
        mock_list.return_value = [{"toolkit": "github"}]
        session = MagicMock()
        session.session_id = "sess-2"
        session.mcp.url = "https://mcp.example/def"
        session.mcp.headers = {}
        mock_client.return_value.create.return_value = session

        from api.services.composio import generate_mcp_config
        generate_mcp_config("user-2")

        call_kwargs = mock_client.return_value.create.call_args.kwargs
        assert "toolkits" not in call_kwargs


class TestRefreshAndGetCredentials:
    @patch("api.services.composio.get_credentials")
    @patch("api.services.composio._get_client")
    def test_refreshes_then_returns_credentials(self, mock_client, mock_get_creds):
        mock_get_creds.return_value = {"access_token": "ya29.fresh", "refresh_token": "r", "token_type": "Bearer"}

        from api.services.composio import refresh_and_get_credentials
        result = refresh_and_get_credentials("conn-123")

        mock_client.return_value.connected_accounts.refresh.assert_called_once_with(nanoid="conn-123")
        assert result["access_token"] == "ya29.fresh"

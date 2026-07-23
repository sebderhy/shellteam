"""Tests for CLI credential injection service."""

import os


import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock, call

from api.services.credentials import (
    inject_google,
    inject_all,
    revoke_google,
    GOOGLE_TOOLKIT,
)


class TestInjectGoogle:
    def test_writes_token_file(self, tmp_path):
        inject_google(tmp_path, "ya29.test_token")
        token = (tmp_path / ".config" / "shellteam" / "google-token").read_text()
        assert token == "ya29.test_token"

    def test_creates_config_dir(self, tmp_path):
        inject_google(tmp_path, "ya29.tok")
        assert (tmp_path / ".config" / "shellteam").is_dir()

    def test_overwrites_on_repeated_injection(self, tmp_path):
        inject_google(tmp_path, "ya29.first")
        inject_google(tmp_path, "ya29.second")
        token = (tmp_path / ".config" / "shellteam" / "google-token").read_text()
        assert token == "ya29.second"



class TestInjectAll:
    def _mock_connections(self, toolkits):
        return [
            {"id": f"conn-{t}", "toolkit": t, "status": "ACTIVE"}
            for t in toolkits
        ]

    @patch("api.services.credentials.inject_google")
    @patch("api.services.credentials.composio_svc")
    def test_injects_google_for_active_connection(self, mock_composio, mock_inject, tmp_path):
        mock_composio.list_connections.return_value = self._mock_connections(["googlesuper"])
        mock_composio.get_credentials.return_value = {"access_token": "ya29.tok", "refresh_token": "refresh", "token_type": "bearer"}

        inject_all(tmp_path, "user-1")
        mock_inject.assert_called_once_with(tmp_path, "ya29.tok", None)

    @patch("api.services.credentials.inject_google")
    @patch("api.services.credentials.composio_svc")
    def test_skips_unsupported_toolkits(self, mock_composio, mock_google, tmp_path):
        mock_composio.list_connections.return_value = self._mock_connections(["slack", "notion"])
        inject_all(tmp_path, "user-1")
        mock_google.assert_not_called()

    @patch("api.services.credentials.inject_google")
    @patch("api.services.credentials.composio_svc")
    def test_skips_github_even_if_connected(self, mock_composio, mock_google, tmp_path):
        """GitHub is intentionally excluded — Composio tokens have narrower scopes
        than user PATs and re-injecting clobbers manual `gh auth login` credentials."""
        mock_composio.list_connections.return_value = self._mock_connections(["github"])
        inject_all(tmp_path, "user-1")
        mock_google.assert_not_called()
        # And we don't touch git credentials at all
        assert not (tmp_path / ".git-credentials").exists()
        assert not (tmp_path / ".config" / "gh" / "hosts.yml").exists()

    @patch("api.services.credentials.composio_svc")
    def test_composio_failure_does_not_crash(self, mock_composio, tmp_path):
        mock_composio.list_connections.side_effect = RuntimeError("API down")
        # Should not raise
        inject_all(tmp_path, "user-1")

    @patch("api.services.credentials.inject_google")
    @patch("api.services.credentials.composio_svc")
    def test_no_connections_is_noop(self, mock_composio, mock_google, tmp_path):
        mock_composio.list_connections.return_value = []
        inject_all(tmp_path, "user-1")
        mock_google.assert_not_called()




class TestRevokeGoogle:
    def test_removes_token_file(self, tmp_path):
        token_dir = tmp_path / ".config" / "shellteam"
        token_dir.mkdir(parents=True)
        token_file = token_dir / "google-token"
        token_file.write_text("ya29.tok")
        revoke_google(tmp_path)
        assert not token_file.exists()

    def test_noop_when_no_token(self, tmp_path):
        # Should not raise
        revoke_google(tmp_path)


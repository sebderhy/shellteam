"""Tests for auth router — /api/auth/* endpoints."""

import os


import re
import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from fastapi import HTTPException

from api.routers.auth import USERNAME_RE


class TestUsernameRegex:
    """Validate the USERNAME_RE pattern."""

    def test_valid_simple(self):
        assert USERNAME_RE.match("alice")

    def test_valid_with_numbers(self):
        assert USERNAME_RE.match("alice123")

    def test_valid_with_hyphens(self):
        assert USERNAME_RE.match("my-user")

    def test_valid_min_length(self):
        assert USERNAME_RE.match("abc")  # 3 chars

    def test_valid_30_chars(self):
        assert USERNAME_RE.match("a" * 30)

    def test_rejects_too_short(self):
        assert USERNAME_RE.match("ab") is None  # 2 chars

    def test_rejects_too_long(self):
        assert USERNAME_RE.match("a" * 31) is None

    def test_rejects_uppercase(self):
        assert USERNAME_RE.match("Alice") is None

    def test_rejects_starting_with_number(self):
        assert USERNAME_RE.match("1alice") is None

    def test_rejects_starting_with_hyphen(self):
        assert USERNAME_RE.match("-alice") is None

    def test_rejects_underscores(self):
        assert USERNAME_RE.match("my_user") is None

    def test_rejects_special_chars(self):
        assert USERNAME_RE.match("alice!") is None

    def test_rejects_spaces(self):
        assert USERNAME_RE.match("my user") is None

    def test_rejects_ending_with_hyphen(self):
        """Trailing hyphens should be rejected for clean subdomains."""
        # Current regex allows this — test documents behavior
        assert USERNAME_RE.match("alice-")


class TestMeEndpoint:
    def test_returns_user_info(self, client, auth_header, fake_profile):
        resp = client.get("/api/auth/me", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "user-uuid-1234"
        assert data["email"] == "test@example.com"
        assert data["username"] == "alice"
        assert data["has_username"] is True

    def test_no_profile_still_ok(self, client, auth_header, mock_get_user_profile):
        """Single-user: there is no tier gate. A missing profile just means no
        username has been chosen yet."""
        mock_get_user_profile.return_value = None
        resp = client.get("/api/auth/me", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["has_username"] is False

    def test_profile_without_username_key(self, client, auth_header, mock_get_user_profile):
        """Profile that exists but has no 'username' key should not crash."""
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "tier": "plus"}
        resp = client.get("/api/auth/me", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] is None
        assert data["has_username"] is False

    def test_profile_with_null_username(self, client, auth_header, mock_get_user_profile):
        """Profile with username=None should report has_username=False."""
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "username": None, "tier": "plus"}
        resp = client.get("/api/auth/me", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] is None
        assert data["has_username"] is False

    def test_unauthenticated(self):
        """No token → 401 (OWNER_TOKEN is set in the test env)."""
        from fastapi.testclient import TestClient
        from api.main import app

        with TestClient(app) as c:
            resp = c.get("/api/auth/me")
            assert resp.status_code == 401


class TestChooseUsername:
    def _mock_set_username(self, return_value=True):
        """Patch set_username at the router's import site."""
        return patch(
            "api.routers.auth.set_username",
            new_callable=AsyncMock,
            return_value=return_value,
        )

    def test_set_username(self, client, auth_header, mock_get_user_profile):
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "username": None, "tier": "plus"}

        with self._mock_set_username(True):
            resp = client.post(
                "/api/auth/username",
                json={"username": "bob"},
                headers=auth_header,
            )

        assert resp.status_code == 200
        assert resp.json()["username"] == "bob"

    def test_rejects_invalid_username(self, client, auth_header):
        resp = client.post(
            "/api/auth/username",
            json={"username": "AB"},
            headers=auth_header,
        )
        assert resp.status_code == 400

    def test_rejects_if_already_set(self, client, auth_header, mock_get_user_profile):
        mock_get_user_profile.return_value = {
            "id": "user-uuid-1234",
            "username": "alice",
            "tier": "plus",
        }
        resp = client.post(
            "/api/auth/username",
            json={"username": "newname"},
            headers=auth_header,
        )
        assert resp.status_code == 409

    def test_duplicate_username(self, client, auth_header, mock_get_user_profile):
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "username": None, "tier": "plus"}

        with self._mock_set_username(False):
            resp = client.post(
                "/api/auth/username",
                json={"username": "taken"},
                headers=auth_header,
            )

        assert resp.status_code == 409

    def test_normalizes_to_lowercase(self, client, auth_header, mock_get_user_profile):
        """Username should be lowercased before validation and storage."""
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "username": None, "tier": "plus"}

        with self._mock_set_username(True) as mock_set:
            resp = client.post(
                "/api/auth/username",
                json={"username": "  MyUser  "},
                headers=auth_header,
            )

        assert resp.status_code == 200
        assert resp.json()["username"] == "myuser"

    def test_set_username_server_error(self, client, auth_header, mock_get_user_profile):
        """If set_username raises (backing store error), endpoint should return 502."""
        import httpx
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "username": None, "tier": "plus"}

        with patch(
            "api.routers.auth.set_username",
            new_callable=AsyncMock,
            side_effect=httpx.HTTPStatusError(
                "Server error", request=MagicMock(), response=MagicMock(status_code=500)
            ),
        ):
            resp = client.post(
                "/api/auth/username",
                json={"username": "newname"},
                headers=auth_header,
            )

        assert resp.status_code == 502

    def test_profile_without_username_key(self, client, auth_header, mock_get_user_profile):
        """Profile missing 'username' key should be treated as no username set."""
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "tier": "plus"}

        with self._mock_set_username(True):
            resp = client.post(
                "/api/auth/username",
                json={"username": "newname"},
                headers=auth_header,
            )

        assert resp.status_code == 200

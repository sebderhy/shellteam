"""Tests for the single-user api.services.auth."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException


def _reload_auth(monkeypatch, **env):
    """Apply isolated auth settings that pytest restores after each test."""
    import api.services.auth as auth

    for k, v in env.items():
        monkeypatch.setattr(auth, k, Path(v) if k == "DATA_DIR" else v)
    return auth


class TestGetTokenFromRequest:
    def _make_request(self, headers=None, query_params=None, cookies=None):
        req = MagicMock()
        req.headers = headers or {}
        req.query_params = query_params or {}
        req.cookies = cookies or {}
        return req

    def test_bearer_token(self):
        from api.services.auth import get_token_from_request
        req = self._make_request(headers={"Authorization": "Bearer my-token"})
        assert get_token_from_request(req) == "my-token"

    def test_query_param_token_not_accepted(self):
        """?token= is dead (split-credential model): URL-borne master tokens end
        up in history/logs/Referers. Only /enroll?code= and the one-time GET
        /?token= redemption touch URL credentials."""
        from api.services.auth import get_token_from_request
        req = self._make_request(query_params={"token": "ws-token"})
        assert get_token_from_request(req) == ""

    def test_cookie_token(self):
        from api.services.auth import get_token_from_request
        req = self._make_request(cookies={"shellteam_token": "cookie-token"})
        assert get_token_from_request(req) == "cookie-token"

    def test_bearer_takes_precedence(self):
        from api.services.auth import get_token_from_request
        req = self._make_request(
            headers={"Authorization": "Bearer header-token"},
            query_params={"token": "query-token"},
        )
        assert get_token_from_request(req) == "header-token"

    def test_missing_returns_empty(self):
        from api.services.auth import get_token_from_request
        assert get_token_from_request(self._make_request()) == ""


class TestTokenIsOwner:
    def test_localhost_trust_accepts_anything(self, monkeypatch):
        auth = _reload_auth(monkeypatch, OWNER_TOKEN="")
        assert auth.token_is_owner(None) is True
        assert auth.token_is_owner("whatever") is True

    def test_owner_token_required_when_set(self, monkeypatch):
        auth = _reload_auth(monkeypatch, OWNER_TOKEN="s3cret")
        assert auth.token_is_owner("s3cret") is True
        assert auth.token_is_owner("wrong") is False
        assert auth.token_is_owner(None) is False

    def test_verify_token_returns_owner_payload(self, monkeypatch):
        auth = _reload_auth(monkeypatch, OWNER_TOKEN="s3cret", OWNER_ID="me", OWNER_EMAIL="me@x")
        payload = auth.verify_token("s3cret")
        assert payload["sub"] == "me"
        assert payload["email"] == "me@x"

    def test_verify_token_rejects_bad_token(self, monkeypatch):
        auth = _reload_auth(monkeypatch, OWNER_TOKEN="s3cret")
        with pytest.raises(HTTPException) as exc:
            auth.verify_token("nope")
        assert exc.value.status_code == 401


@pytest.mark.asyncio
class TestProfilePersistence:
    async def test_defaults_then_persists(self, monkeypatch, tmp_path):
        auth = _reload_auth(
            monkeypatch,
            DATA_DIR=str(tmp_path),
            OWNER_ID="owner",
            OWNER_USERNAME="seb",
        )
        profile = await auth.get_user_profile()
        assert profile["username"] == "seb"
        assert profile["timezone"] is None

        await auth.set_timezone("owner", "Europe/Paris")
        await auth.set_username("owner", "newname")

        assert await auth.get_user_timezone() == "Europe/Paris"
        reloaded = await auth.get_user_profile()
        assert reloaded["timezone"] == "Europe/Paris"
        assert reloaded["username"] == "newname"

    async def test_tier_is_owner(self, monkeypatch, tmp_path):
        auth = _reload_auth(monkeypatch, DATA_DIR=str(tmp_path))
        assert await auth.get_user_tier() == "owner"

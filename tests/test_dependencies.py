"""Tests for shared dependencies (api.dependencies)."""

import pytest
from unittest.mock import MagicMock, patch
from fastapi import HTTPException

from api.dependencies import get_current_user


def _request(headers=None, query_params=None, cookies=None):
    req = MagicMock()
    req.headers = headers or {}
    req.query_params = query_params or {}
    req.cookies = cookies or {}
    return req


@pytest.mark.asyncio
class TestGetCurrentUser:
    async def test_returns_owner_with_full_features(self):
        # conftest pins OWNER_TOKEN="fake-jwt-token"
        req = _request(headers={"Authorization": "Bearer fake-jwt-token"})
        result = await get_current_user(req)

        assert result["id"] == "user-uuid-1234"
        assert result["email"] == "test@example.com"
        assert result["token"] == "fake-jwt-token"
        assert result["tier"] == "owner"
        # The owner always gets the full (all-true) feature set.
        assert result["features"]["coo_model"] == "claude-opus-4-8"
        assert set(result["features"]) == {"coo_model"}

    async def test_rejects_wrong_token(self):
        req = _request(headers={"Authorization": "Bearer not-the-owner"})
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(req)
        assert exc_info.value.status_code == 401

    async def test_rejects_missing_token(self):
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(_request())
        assert exc_info.value.status_code == 401

    async def test_localhost_trust_allows_no_token(self):
        """When OWNER_TOKEN is unset, any caller is the owner."""
        with patch("api.dependencies.token_is_owner", return_value=True):
            result = await get_current_user(_request())
        assert result["id"] == "user-uuid-1234"

    async def test_repeated_bad_tokens_escalate_to_429(self):
        """Brute-forcing the shared token gets rate-limited per IP.

        The first `rate` wrong tokens still return 401; once the per-IP failed-
        attempt budget is spent the dependency escalates to 429.
        """
        from api.services.ratelimit import auth_failure_limiter

        auth_failure_limiter.reset()
        req = _request(headers={"Authorization": "Bearer wrong"})
        req.client.host = "203.0.113.7"  # fixed IP → same bucket across calls

        for _ in range(10):  # auth_failure_limiter rate=10/60s
            with pytest.raises(HTTPException) as exc:
                await get_current_user(req)
            assert exc.value.status_code == 401

        with pytest.raises(HTTPException) as exc:
            await get_current_user(req)
        assert exc.value.status_code == 429
        auth_failure_limiter.reset()

    async def test_correct_token_never_consumes_failure_budget(self):
        """A caller with the right token is never throttled, even after attacks."""
        from api.services.ratelimit import auth_failure_limiter

        auth_failure_limiter.reset()
        bad = _request(headers={"Authorization": "Bearer wrong"})
        bad.client.host = "203.0.113.8"
        for _ in range(20):  # exhaust the bucket for this IP
            with pytest.raises(HTTPException):
                await get_current_user(bad)

        good = _request(headers={"Authorization": "Bearer fake-jwt-token"})
        good.client.host = "203.0.113.8"  # same IP, but valid token
        result = await get_current_user(good)
        assert result["tier"] == "owner"
        auth_failure_limiter.reset()

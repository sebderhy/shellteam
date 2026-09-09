"""Tests for the token-bucket rate limiter."""

import time
from unittest.mock import patch

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from api.services.ratelimit import RateLimiter


# -- Unit tests for the bucket logic --


class TestTokenBucket:
    def test_allows_up_to_rate(self):
        rl = RateLimiter(rate=3, period=60)
        for _ in range(3):
            assert rl._allow("k") is True
        assert rl._allow("k") is False

    def test_refills_over_time(self):
        rl = RateLimiter(rate=2, period=10)
        assert rl._allow("k") is True
        assert rl._allow("k") is True
        assert rl._allow("k") is False

        # Advance time by 5s → should refill 1 token (rate=2 per 10s)
        rl._buckets["k"].last_refill -= 5
        assert rl._allow("k") is True
        assert rl._allow("k") is False

    def test_separate_keys(self):
        rl = RateLimiter(rate=1, period=60)
        assert rl._allow("a") is True
        assert rl._allow("a") is False
        assert rl._allow("b") is True  # different key, separate bucket

    def test_tokens_dont_exceed_rate(self):
        rl = RateLimiter(rate=2, period=10)
        assert rl._allow("k") is True
        # Advance far into the future — tokens should cap at rate
        rl._buckets["k"].last_refill -= 1000
        assert rl._allow("k") is True
        assert rl._allow("k") is True
        assert rl._allow("k") is False  # 2 is the cap

    def test_cleanup_removes_stale_buckets(self):
        rl = RateLimiter(rate=5, period=60)
        rl._allow("fresh")
        rl._allow("stale")
        # Make "stale" old
        rl._buckets["stale"].last_refill -= 700
        # Force cleanup
        rl._last_cleanup -= 700
        rl._allow("trigger")
        assert "fresh" in rl._buckets
        assert "stale" not in rl._buckets


# -- Integration tests with FastAPI --


@pytest.fixture
def rate_limited_app():
    """A minimal FastAPI app with a rate-limited endpoint."""
    _limit = RateLimiter(rate=3, period=60)

    app = FastAPI()

    @app.get("/limited")
    async def limited(request: Request, _=Depends(_limit)):
        return {"ok": True}

    @app.get("/unlimited")
    async def unlimited():
        return {"ok": True}

    return app


class TestRateLimitEndpoint:
    def test_allows_within_limit(self, rate_limited_app):
        with TestClient(rate_limited_app) as client:
            for _ in range(3):
                resp = client.get("/limited")
                assert resp.status_code == 200

    def test_blocks_over_limit(self, rate_limited_app):
        with TestClient(rate_limited_app) as client:
            for _ in range(3):
                client.get("/limited")
            resp = client.get("/limited")
            assert resp.status_code == 429
            assert "Too many requests" in resp.json()["detail"]

    def test_unlimited_endpoint_unaffected(self, rate_limited_app):
        with TestClient(rate_limited_app) as client:
            # Exhaust the limited endpoint
            for _ in range(3):
                client.get("/limited")
            assert client.get("/limited").status_code == 429
            # Unlimited should still work
            assert client.get("/unlimited").status_code == 200


class TestUserKeyedRateLimit:
    def test_keys_by_user_id(self):
        """When key='user', bucket key uses request.state.rate_limit_user_id."""
        _limit = RateLimiter(rate=1, period=60, key="user")

        app = FastAPI()

        @app.get("/u")
        async def endpoint(request: Request, _=Depends(_limit)):
            return {"ok": True}

        @app.middleware("http")
        async def set_user(request: Request, call_next):
            request.state.rate_limit_user_id = request.headers.get("X-User-Id")
            return await call_next(request)

        with TestClient(app) as client:
            assert client.get("/u", headers={"X-User-Id": "alice"}).status_code == 200
            assert client.get("/u", headers={"X-User-Id": "alice"}).status_code == 429
            # Different user is fine
            assert client.get("/u", headers={"X-User-Id": "bob"}).status_code == 200

    def test_falls_back_to_ip_when_no_user(self):
        _limit = RateLimiter(rate=1, period=60, key="user")

        app = FastAPI()

        @app.get("/u")
        async def endpoint(request: Request, _=Depends(_limit)):
            return {"ok": True}

        with TestClient(app) as client:
            assert client.get("/u").status_code == 200
            assert client.get("/u").status_code == 429

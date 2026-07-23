"""Tests for security and quality hardening changes.

Each test class targets a specific fix and is written BEFORE the fix
to verify the issue exists (TDD red phase).
"""

import os


import pytest
import httpx
import respx
from unittest.mock import patch, AsyncMock, MagicMock, call


# ---------------------------------------------------------------------------
# 1. Socket leak in _wait_until_ready
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 2. JWT algorithm restriction
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 3. CORS configuration tightening
# ---------------------------------------------------------------------------
class TestCorsConfiguration:
    """CORS middleware should use explicit method/header lists, not wildcards."""

    def test_cors_methods_are_explicit(self):
        """allow_methods should not be ['*']."""
        from api.main import app

        cors_middleware = None
        for middleware in app.user_middleware:
            if middleware.cls.__name__ == "CORSMiddleware":
                cors_middleware = middleware
                break

        assert cors_middleware is not None, "CORSMiddleware not found"
        methods = cors_middleware.kwargs.get("allow_methods", [])
        assert methods != ["*"], f"CORS allow_methods should be explicit, got {methods}"

    def test_cors_headers_are_explicit(self):
        """allow_headers should not be ['*']."""
        from api.main import app

        cors_middleware = None
        for middleware in app.user_middleware:
            if middleware.cls.__name__ == "CORSMiddleware":
                cors_middleware = middleware
                break

        assert cors_middleware is not None
        headers = cors_middleware.kwargs.get("allow_headers", [])
        assert headers != ["*"], f"CORS allow_headers should be explicit, got {headers}"

    def test_cors_allows_required_methods(self):
        """Must still allow the HTTP methods the API uses."""
        from api.main import app

        cors_middleware = None
        for middleware in app.user_middleware:
            if middleware.cls.__name__ == "CORSMiddleware":
                cors_middleware = middleware
                break

        methods = cors_middleware.kwargs.get("allow_methods", [])
        for required in ("GET", "POST", "PUT", "DELETE", "PATCH"):
            assert required in methods, f"{required} must be allowed"


# ---------------------------------------------------------------------------
# 4. Proxy header whitelist (don't leak auth headers to containers)
# ---------------------------------------------------------------------------
class TestProxyHeaderForwarding:
    """Verify proxy preserves app auth while stripping platform-only state."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_authorization_header_forwarded(self):
        """Authorization headers belong to the proxied app and must be preserved."""
        from api.routers.proxy import proxy_subdomain

        route = respx.get("http://172.20.0.5:80/public/page").mock(
            return_value=httpx.Response(200, text="ok")
        )

        request = MagicMock()
        request.headers = {
            "host": "alice.localhost",
            "authorization": "Bearer secret-jwt-token",
            "content-type": "text/html",
        }
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/page")

        assert resp.status_code == 200
        forwarded = {k.lower(): v for k, v in route.calls[0].request.headers.items()}
        assert forwarded.get("authorization") == "Bearer secret-jwt-token"

    @pytest.mark.asyncio
    @respx.mock
    async def test_cookie_header_strips_only_shellteam_cookie(self):
        """App cookies should survive, but the platform auth cookie should not leak."""
        from api.routers.proxy import proxy_subdomain

        route = respx.get("http://172.20.0.5:80/public/page").mock(
            return_value=httpx.Response(200, text="ok")
        )

        request = MagicMock()
        request.headers = {
            "host": "alice.localhost",
            "cookie": "shellteam_token=secret; session=abc",
            "accept": "text/html",
        }
        request.cookies = {"shellteam_token": "secret"}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/page")

        assert resp.status_code == 200
        forwarded = {k.lower(): v for k, v in route.calls[0].request.headers.items()}
        assert forwarded.get("cookie") == "session=abc"

    @pytest.mark.asyncio
    @respx.mock
    async def test_safe_headers_are_forwarded(self):
        """Content-Type, Accept, User-Agent etc. should still be forwarded."""
        from api.routers.proxy import proxy_subdomain

        route = respx.get("http://172.20.0.5:80/public/page").mock(
            return_value=httpx.Response(200, text="ok")
        )

        request = MagicMock()
        request.headers = {
            "host": "alice.localhost",
            "content-type": "application/json",
            "accept": "text/html",
            "user-agent": "Mozilla/5.0",
            "accept-language": "en-US",
        }
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/page")

        forwarded = {k.lower(): v for k, v in route.calls[0].request.headers.items()}
        assert forwarded.get("content-type") == "application/json"
        assert forwarded.get("user-agent") == "Mozilla/5.0"
        assert forwarded.get("accept-language") == "en-US"


# ---------------------------------------------------------------------------
# 5. Entrypoint /etc/environment truncation
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 6. Proxy error handling — catch all httpx errors, not just ConnectError
# ---------------------------------------------------------------------------
class TestProxyErrorHandling:
    """Proxy should return proper error responses for all httpx failures."""

    @pytest.mark.asyncio
    async def test_timeout_returns_504(self):
        """httpx.ReadTimeout should return 504 Gateway Timeout, not 500."""
        from api.routers.proxy import proxy_subdomain

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "httpx.AsyncClient.request",
                side_effect=httpx.ReadTimeout("read timed out"),
            ),
        ):
            resp = await proxy_subdomain(request, "public/page")

        assert resp.status_code == 504, f"Expected 504 for timeout, got {resp.status_code}"

    @pytest.mark.asyncio
    async def test_generic_httpx_error_returns_502(self):
        """Other httpx errors should return 502 Bad Gateway."""
        from api.routers.proxy import proxy_subdomain

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "httpx.AsyncClient.request",
                side_effect=httpx.RemoteProtocolError("connection reset"),
            ),
        ):
            resp = await proxy_subdomain(request, "public/page")

        assert resp.status_code == 502, f"Expected 502, got {resp.status_code}"

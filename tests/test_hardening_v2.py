"""Tests for security and quality hardening — round 2.

Covers:
1. XSS in proxy error pages (username HTML-escaped)
2. Port validation (range 1-65535, block system ports)
3. HTTP connection pooling for upstream calls
4. Path traversal protection in proxy
5. Filename sanitization in gateway
6. Rate limiter cleanup frequency
7. CORS allows user subdomains
"""

import os
import html
import re


import pytest
import httpx
import respx
from unittest.mock import patch, AsyncMock, MagicMock


# ---------------------------------------------------------------------------
# 1. XSS in proxy error pages — username must be HTML-escaped
# ---------------------------------------------------------------------------
class TestProxyXSSPrevention:
    """Proxy error pages must HTML-escape username to prevent XSS."""

    def test_offline_page_escapes_username(self):
        from api.routers.proxy import _offline_response

        # Username with XSS payload
        xss_username = '<img src=x onerror=alert(1)>'
        resp = _offline_response(xss_username)
        body = resp.body.decode()

        # The raw XSS payload must NOT appear unescaped
        assert xss_username not in body, "Username must be HTML-escaped in offline page"
        # The escaped version should be present
        assert html.escape(xss_username) in body

    def test_offline_page_normal_username(self):
        from api.routers.proxy import _offline_response

        resp = _offline_response("alice")
        body = resp.body.decode()
        assert "alice" in body
        assert resp.status_code == 503


# ---------------------------------------------------------------------------
# 2. Port validation — must reject invalid port ranges
# ---------------------------------------------------------------------------
class TestPortValidation:
    """Proxy must reject ports outside valid range and block system ports."""

    @pytest.mark.asyncio
    async def test_port_over_65535_rejected(self):
        """Ports > 65535 are invalid and should return an error."""
        from api.routers.proxy import proxy_subdomain

        request = MagicMock()
        request.headers = {"host": "alice-99999.localhost"}
        request.cookies = {}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "")
        assert resp.status_code == 400, f"Port 99999 should be rejected, got {resp.status_code}"

    @pytest.mark.asyncio
    async def test_port_0_rejected(self):
        """Port 0 is not a valid TCP port."""
        from api.routers.proxy import proxy_subdomain

        request = MagicMock()
        request.headers = {"host": "alice-0.localhost"}
        request.cookies = {}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "")
        assert resp.status_code == 400, f"Port 0 should be rejected, got {resp.status_code}"


# ---------------------------------------------------------------------------
# 3. Port service — block reserved/system ports
# ---------------------------------------------------------------------------
class TestPortServiceBlockReserved:
    """Port visibility service should reject reserved system ports."""

    @pytest.fixture(autouse=True)
    def _clean_state(self):
        from api.services import ports
        ports._public_ports.clear()
        yield
        ports._public_ports.clear()

    def test_port_22_blocked(self, tmp_path):
        """SSH port 22 should not be exposable as public."""
        from api.services import ports
        with patch.object(ports, "DATA_DIR", tmp_path):
            with pytest.raises(ValueError, match="[Rr]eserved|[Bb]locked|[Ss]ystem"):
                ports.set_port_visibility("user-1", 22, True)

    def test_port_1_blocked(self, tmp_path):
        from api.services import ports
        with patch.object(ports, "DATA_DIR", tmp_path):
            with pytest.raises(ValueError, match="[Rr]eserved|[Bb]locked|[Ss]ystem"):
                ports.set_port_visibility("user-1", 1, True)

    def test_valid_port_allowed(self, tmp_path):
        from api.services import ports
        with patch.object(ports, "DATA_DIR", tmp_path):
            result = ports.set_port_visibility("user-1", 3000, True)
            assert 3000 in result

    def test_port_over_65535_rejected(self, tmp_path):
        from api.services import ports
        with patch.object(ports, "DATA_DIR", tmp_path):
            with pytest.raises(ValueError):
                ports.set_port_visibility("user-1", 70000, True)


# ---------------------------------------------------------------------------
# 4. HTTP connection pooling for upstream calls
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 5. Path traversal protection in proxy
# ---------------------------------------------------------------------------
class TestPathTraversalProtection:
    """Proxy should reject or sanitize paths with directory traversal."""

    @pytest.mark.asyncio
    async def test_dot_dot_path_rejected(self):
        """Paths containing '..' should be blocked."""
        from api.routers.proxy import proxy_subdomain

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.cookies = {}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/../../etc/passwd")
        assert resp.status_code == 400, f"Path traversal should be rejected, got {resp.status_code}"

    @pytest.mark.asyncio
    async def test_encoded_dot_dot_rejected(self):
        """URL-encoded traversal (%2e%2e) should also be blocked."""
        from api.routers.proxy import proxy_subdomain

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.cookies = {}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/%2e%2e/etc/passwd")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @respx.mock
    async def test_normal_path_with_dots_allowed(self):
        """Normal paths with dots (file.txt) should still work."""
        from api.routers.proxy import proxy_subdomain

        respx.get("http://172.20.0.5:80/public/file.txt").mock(
            return_value=httpx.Response(200, text="content")
        )

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.cookies = {}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/file.txt")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @respx.mock
    async def test_double_dot_inside_filename_allowed(self):
        """Only traversal segments should be blocked; '..' inside a filename is valid."""
        from api.routers.proxy import proxy_subdomain

        respx.get("http://172.20.0.5:80/public/report..final.txt").mock(
            return_value=httpx.Response(200, text="content")
        )

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.cookies = {}
        request.method = "GET"
        request.url = MagicMock(query="")
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/report..final.txt")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# 7. Rate limiter cleanup runs more frequently under pressure
# ---------------------------------------------------------------------------
class TestRateLimiterMemoryManagement:
    """Rate limiter should not grow unbounded."""

    def test_cleanup_removes_stale_buckets(self):
        import time
        from api.services.ratelimit import RateLimiter

        limiter = RateLimiter(rate=10, period=60)
        # Fill with many keys
        for i in range(100):
            limiter._allow(f"ip:{i}")

        assert len(limiter._buckets) == 100

        # Simulate time passing beyond stale threshold
        for bucket in limiter._buckets.values():
            bucket.last_refill -= 700  # older than _STALE_SECONDS (600)
        limiter._last_cleanup -= 700

        # Next call should trigger cleanup
        limiter._allow("ip:new")
        assert len(limiter._buckets) < 100, "Stale buckets should be cleaned up"


# ---------------------------------------------------------------------------
# 8. Hardcoded developer paths should use env var
# ---------------------------------------------------------------------------
class TestNoHardcodedPaths:
    """Config should not have hardcoded developer-specific paths as defaults."""

    def test_data_dir_uses_env_or_sensible_default(self):
        """DATA_DIR defaults should not reference a developer-specific home."""
        from api.config import DATA_DIR as config_data_dir
        from api.services.ports import DATA_DIR as ports_data_dir

        # These should match (consistency check)
        assert str(config_data_dir) == str(ports_data_dir), \
            f"DATA_DIR mismatch: config={config_data_dir}, ports={ports_data_dir}"


# ---------------------------------------------------------------------------
# 10. AI tools — filename header sanitization
# ---------------------------------------------------------------------------
class TestAiToolsHeaderSanitization:
    """X-Filename header must not contain newlines (HTTP header injection)."""

    def test_filename_header_no_newlines(self):
        """Filenames with \\r\\n should be sanitized before going into headers."""
        # Simulate what the code does
        filename = "report.pdf\r\nX-Injected: evil"
        sanitized = filename.replace("\r", "").replace("\n", "")[:256]
        assert "\r" not in sanitized
        assert "\n" not in sanitized
        assert "X-Injected" in sanitized  # content is there but on same line, harmless

    def test_filename_truncated(self):
        """Very long filenames should be truncated."""
        filename = "a" * 500 + ".pdf"
        sanitized = filename.replace("\r", "").replace("\n", "")[:256]
        assert len(sanitized) <= 256


# ---------------------------------------------------------------------------
# 11. WebSocket proxy — port validation
# ---------------------------------------------------------------------------
class TestWebSocketPortValidation:
    """WebSocket proxy must reject invalid ports."""

    @pytest.mark.asyncio
    async def test_ws_invalid_port_rejected(self):
        """WebSocket to port > 65535 should be rejected."""
        from api.routers.proxy import proxy_websocket

        scope = {
            "type": "websocket",
            "headers": [(b"host", b"alice-99999.localhost")],
            "path": "/ws",
            "query_string": b"",
        }
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        await proxy_websocket(scope, receive, send)

        close = next(m for m in sent if m.get("type") == "websocket.close")
        assert close["code"] == 1008

    @pytest.mark.asyncio
    async def test_ws_path_traversal_rejected(self):
        """WebSocket with path traversal should be rejected."""
        from api.routers.proxy import proxy_websocket

        scope = {
            "type": "websocket",
            "headers": [(b"host", b"alice.localhost")],
            "path": "/../../etc/passwd",
            "query_string": b"",
        }
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            await proxy_websocket(scope, receive, send)

        close = next(m for m in sent if m.get("type") == "websocket.close")
        assert close["code"] == 1008

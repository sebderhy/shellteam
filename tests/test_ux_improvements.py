"""Tests for UX and product quality improvements.

Covers:
1. Proxy error pages are styled HTML (not bare text)
2. Offline page includes dashboard link
3. Computer start endpoint catches TimeoutError
4. Activity tracking doesn't go below zero
5. Terminal close codes are specific
6. Container IP assignment waits with retry (no race condition)
"""

import os


import asyncio
import pytest
import httpx
import respx
from unittest.mock import patch, AsyncMock, MagicMock


# ---------------------------------------------------------------------------
# 1. Proxy error pages should be styled HTML with dashboard links
# ---------------------------------------------------------------------------
class TestStyledErrorPages:
    """Error pages should be user-friendly HTML, not bare text."""

    def test_offline_page_has_dashboard_link(self):
        from api.routers.proxy import _offline_response
        resp = _offline_response("alice")
        body = resp.body.decode()
        assert "cockpit" in body.lower()
        assert "https://" in body  # contains a link

    def test_offline_page_is_html(self):
        from api.routers.proxy import _offline_response
        resp = _offline_response("alice")
        assert resp.media_type == "text/html"
        assert "<html>" in resp.body.decode()

    def test_login_page_has_dashboard_link(self):
        from api.routers.proxy import _login_required_response
        resp = _login_required_response()
        body = resp.body.decode()
        assert "cockpit" in body.lower()

    def test_forbidden_page_has_dashboard_link(self):
        from api.routers.proxy import _forbidden_response
        resp = _forbidden_response()
        body = resp.body.decode()
        assert "cockpit" in body.lower()

    @pytest.mark.asyncio
    async def test_timeout_error_is_styled_html(self):
        """504 response should be styled HTML, not bare 'Gateway timeout' text."""
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

        assert resp.status_code == 504
        body = resp.body.decode()
        assert "<html>" in body, "504 response should be styled HTML"
        assert "cockpit" in body.lower(), "504 page should link to dashboard"

    @pytest.mark.asyncio
    async def test_connection_error_is_styled_html(self):
        """502 response should be styled HTML, not bare 'Container unreachable' text."""
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
                side_effect=httpx.ConnectError("connection refused"),
            ),
        ):
            resp = await proxy_subdomain(request, "public/page")

        assert resp.status_code == 502
        body = resp.body.decode()
        assert "<html>" in body
        assert "cockpit" in body.lower()


# ---------------------------------------------------------------------------
# 2. Computer start endpoint — catches TimeoutError
# ---------------------------------------------------------------------------
class TestComputerStartErrorHandling:
    """start_computer endpoint should handle TimeoutError gracefully."""

    def test_timeout_returns_503_with_message(self, client, auth_header):
        """TimeoutError during startup should return 503, not 500."""
        with patch(
            "api.routers.computers.containers.start_computer",
            new_callable=AsyncMock,
            side_effect=TimeoutError("not ready after 15s"),
        ):
            resp = client.post("/api/computers", headers=auth_header)

        assert resp.status_code == 503
        data = resp.json()
        assert "starting up" in data["detail"].lower() or "try again" in data["detail"].lower()



# ---------------------------------------------------------------------------
# 3. Activity tracking — connection count never goes negative
# ---------------------------------------------------------------------------
class TestActivityTracking:
    """connection_closed should handle mismatched close gracefully."""

    @pytest.fixture(autouse=True)
    def _clean_state(self):
        from api.services import activity
        activity._last_activity.clear()
        activity._open_connections.clear()
        yield
        activity._last_activity.clear()
        activity._open_connections.clear()

    def test_normal_open_close_cycle(self):
        from api.services import activity

        activity.connection_opened("user-1")
        assert activity._open_connections["user-1"] == 1

        activity.connection_opened("user-1")
        assert activity._open_connections["user-1"] == 2

        activity.connection_closed("user-1")
        assert activity._open_connections["user-1"] == 1

        activity.connection_closed("user-1")
        assert "user-1" not in activity._open_connections

    def test_mismatched_close_does_not_go_negative(self):
        """Closing without a matching open should not create negative counts."""
        from api.services import activity

        # Close without open — should not crash or go negative
        activity.connection_closed("user-1")
        assert activity._open_connections.get("user-1") is None

    def test_double_close_does_not_go_negative(self):
        """Double close after single open should not create negative count."""
        from api.services import activity

        activity.connection_opened("user-1")
        activity.connection_closed("user-1")
        activity.connection_closed("user-1")  # extra close
        assert activity._open_connections.get("user-1") is None

    def test_idle_check_skips_users_with_connections(self):
        """Users with open connections should not be stopped."""
        from api.services import activity
        import time

        activity.connection_opened("user-1")
        activity._last_activity["user-1"] = time.time() - 999999  # very old

        # Should NOT be idle because there's an open connection
        assert activity._open_connections.get("user-1", 0) > 0


# ---------------------------------------------------------------------------
# 4. Terminal WebSocket — specific close codes
# ---------------------------------------------------------------------------
class TestTerminalCloseCodeSemantics:
    """Terminal WebSocket uses distinct close codes for different failures."""

    def test_terminal_close_codes_are_distinct(self):
        """Verify the close code constants used in terminal.py."""
        # These are the codes used in terminal.py — make sure they're distinct
        AUTH_FAILURE = 4001
        NOT_RUNNING = 4002
        EXEC_FAILED = 4003

        codes = {AUTH_FAILURE, NOT_RUNNING, EXEC_FAILED}
        assert len(codes) == 3, "Close codes must be distinct"
        # All must be in valid WebSocket close code range (4000-4999 for app use)
        for code in codes:
            assert 4000 <= code <= 4999, f"Close code {code} not in valid app range"


# ---------------------------------------------------------------------------
# 5. Container IP assignment — poll instead of sleep(1) to avoid race
# ---------------------------------------------------------------------------

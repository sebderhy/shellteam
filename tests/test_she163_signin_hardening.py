"""SHE-163: sign-in hardening from the 2026-11-10 audit."""

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from api.routers import proxy
from api.services import enrollment


def test_a_non_ascii_enroll_code_is_a_miss_not_a_crash():
    enrollment.mint_code()
    assert enrollment.peek_code("cödé-ünïcode") is False


def test_forwarded_urls_are_not_logged_at_info():
    import api.main  # noqa: F401  (sets the levels)

    # httpx prints "HTTP Request: GET http://…?sig=…" at INFO for every forward.
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() >= logging.WARNING


@pytest.mark.asyncio
async def test_the_share_signature_is_not_passed_on_to_the_file_server():
    request = MagicMock()
    request.url = MagicMock(query="sig=abc123&exp=1900000000&download=1")
    request.method = "GET"
    request.headers = {}
    request.body = AsyncMock(return_value=b"")
    upstream = MagicMock(status_code=200, content=b"x", headers=__import__("httpx").Headers())
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.request = AsyncMock(return_value=upstream)
    with patch("api.routers.proxy.httpx.AsyncClient", return_value=client), \
         patch("api.routers.proxy._sanitize_forwarded_headers", return_value={}):
        await proxy._forward_http(request, "http://127.0.0.1:8081/reports/a.html")
    assert client.request.call_args.kwargs["url"] == "http://127.0.0.1:8081/reports/a.html?download=1"

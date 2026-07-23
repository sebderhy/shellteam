"""Tests for proxy router — subdomain regex, routing, HTTP forwarding, and auth gate."""

import os
from types import SimpleNamespace


import pytest
import httpx
import respx
from fastapi import HTTPException
from unittest.mock import patch, AsyncMock, MagicMock

from api.routers.proxy import (
    SUBDOMAIN_RE, RESERVED_SUBDOMAINS, _parse_host, proxy_subdomain, proxy_websocket,
    _is_public_path, _extract_cookie, _authorize,
    AUTH_OK, AUTH_NO_TOKEN, AUTH_BAD_TOKEN, AUTH_FORBIDDEN,
)
from api.services import ports as port_service
from starlette.websockets import WebSocket


class TestSubdomainRegex:
    """Test the SUBDOMAIN_RE pattern matching."""

    def test_simple_username(self):
        m = SUBDOMAIN_RE.match("alice.localhost")
        assert m is not None
        assert m.group("username") == "alice"
        assert m.group("port") is None

    def test_username_with_numbers(self):
        m = SUBDOMAIN_RE.match("alice123.localhost")
        assert m is not None
        assert m.group("username") == "alice123"

    def test_username_with_hyphens(self):
        m = SUBDOMAIN_RE.match("my-user.localhost")
        assert m is not None
        assert m.group("username") == "my-user"

    def test_port_forwarding(self):
        m = SUBDOMAIN_RE.match("alice-3000.localhost")
        assert m is not None
        assert m.group("username") == "alice"
        assert m.group("port") == "3000"

    def test_port_80(self):
        m = SUBDOMAIN_RE.match("alice-80.localhost")
        assert m is not None
        assert m.group("username") == "alice"
        assert m.group("port") == "80"

    def test_high_port(self):
        m = SUBDOMAIN_RE.match("alice-8080.localhost")
        assert m is not None
        assert m.group("port") == "8080"

    def test_rejects_main_domain(self):
        assert SUBDOMAIN_RE.match("localhost") is None

    def test_rejects_wrong_domain(self):
        assert SUBDOMAIN_RE.match("alice.example.com") is None

    def test_rejects_uppercase(self):
        assert SUBDOMAIN_RE.match("Alice.localhost") is None

    def test_rejects_starting_with_number(self):
        assert SUBDOMAIN_RE.match("123alice.localhost") is None

    def test_rejects_single_char(self):
        # Username regex requires at least 2+ chars after the first letter
        assert SUBDOMAIN_RE.match("a.localhost") is None

    def test_two_char_username(self):
        m = SUBDOMAIN_RE.match("ab.localhost")
        assert m is not None
        assert m.group("username") == "ab"

    def test_username_with_complex_port(self):
        m = SUBDOMAIN_RE.match("my-app-8080.localhost")
        assert m is not None
        assert m.group("username") == "my-app"
        assert m.group("port") == "8080"


class TestParseHost:
    """Test _parse_host extracts hostname without port."""

    def test_plain_host(self):
        scope = {"headers": [(b"host", b"alice.localhost")]}
        assert _parse_host(scope) == "alice.localhost"

    def test_host_with_port(self):
        scope = {"headers": [(b"host", b"alice.localhost:443")]}
        assert _parse_host(scope) == "alice.localhost"

    def test_empty_host(self):
        scope = {"headers": []}
        assert _parse_host(scope) == ""

    def test_port_subdomain_with_port_header(self):
        scope = {"headers": [(b"host", b"alice-3456.localhost:443")]}
        assert _parse_host(scope) == "alice-3456.localhost"


class TestReservedSubdomains:
    """Test that reserved subdomains are properly defined."""

    def test_contains_app(self):
        assert "app" in RESERVED_SUBDOMAINS

    def test_contains_api(self):
        assert "api" in RESERVED_SUBDOMAINS

    def test_contains_www(self):
        assert "www" in RESERVED_SUBDOMAINS


class TestProxyRouting:
    """Test proxy_subdomain function behavior."""

    @pytest.mark.asyncio
    async def test_returns_404_for_non_matching_host(self):
        # An unknown host that is neither a main host nor a `<user>.<domain>`
        # subdomain gets the branded 404. (Main hosts serve the owner's files —
        # see TestMainHostFileServing.)
        request = MagicMock()
        request.headers = {"host": "sub.example.com"}
        resp = await proxy_subdomain(request, "")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_404_for_reserved_subdomains(self):
        for name in ("app", "api", "www"):
            request = MagicMock()
            request.headers = {"host": f"{name}.localhost"}
            resp = await proxy_subdomain(request, "")
            assert resp.status_code == 404, f"{name} should return 404"

    @pytest.mark.asyncio
    async def test_returns_503_when_container_offline(self):
        request = MagicMock()
        request.headers = {"host": "alice.localhost"}

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=(None, None),
        ):
            resp = await proxy_subdomain(request, "public/index.html")

        assert resp.status_code == 503
        assert "offline" in resp.body.decode().lower()

    @pytest.mark.asyncio
    async def test_503_includes_username(self):
        """Offline page should mention the username."""
        request = MagicMock()
        request.headers = {"host": "bob.localhost"}

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=(None, None),
        ):
            resp = await proxy_subdomain(request, "public/index.html")

        assert "bob" in resp.body.decode()


class TestSessionCookiesNeverReachUpstreams:
    """The credential model's no-exfiltration guarantee, pinned.

    The Origin gate on cockpit/app ports (20260719-cockpit-ws-origin-boundary)
    is browser-enforced — a non-browser client holding a stolen files credential
    could forge Origin. The reason that isn't a live path is that the HttpOnly
    session cookies have no exfiltration route: this class pins the two proxy
    paths that would otherwise hand them to arbitrary upstream apps.
    """

    def test_http_forwarding_strips_all_session_cookies(self):
        from api.routers.proxy import _sanitize_forwarded_headers, _SESSION_COOKIES

        request = MagicMock()
        request.headers = {
            "host": "alice-8080.localhost",
            "cookie": "; ".join(
                [f"{c}=secret-{c}" for c in _SESSION_COOKIES] + ["app_pref=dark"]
            ),
            "x-forwarded-by": "nginx",
        }
        headers = _sanitize_forwarded_headers(request)
        forwarded_cookie = headers.get("cookie", "")
        for c in _SESSION_COOKIES:
            assert c not in forwarded_cookie, f"{c} leaked to the upstream app"
        # The app's own cookies still flow.
        assert "app_pref=dark" in forwarded_cookie

    def test_ws_forwarding_sends_no_browser_headers_upstream(self):
        """The WS proxy must connect upstream with NO headers derived from the
        browser's request — websockets.connect(url) only. If someone ever adds
        header pass-through (e.g. extra_headers=...), this fails and forces them
        to strip _SESSION_COOKIES first."""
        import inspect
        from api.routers import proxy as proxy_mod

        src = inspect.getsource(proxy_mod.proxy_websocket)
        connect_call = src[src.index("websockets.connect("):]
        connect_call = connect_call[:connect_call.index("\n")]
        for forbidden in ("extra_headers", "additional_headers", "cookie"):
            assert forbidden not in connect_call, (
                f"WS upstream connect now passes {forbidden!r} — session "
                f"cookies must be stripped before any header pass-through"
            )


class TestProxyForwarding:
    """Test actual HTTP request forwarding to containers."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_forwards_get_request(self):
        """GET request should be proxied to the container."""
        respx.get("http://172.20.0.5:80/public/index.html").mock(
            return_value=httpx.Response(200, text="<h1>Hello</h1>", headers={"content-type": "text/html"})
        )

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.method = "GET"
        request.url = MagicMock()
        request.url.query = ""
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/index.html")

        assert resp.status_code == 200
        assert b"Hello" in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_forwards_post_with_body(self):
        """POST request body should be forwarded."""
        route = respx.post("http://172.20.0.5:80/public/api/data").mock(
            return_value=httpx.Response(201, json={"ok": True})
        )

        request = MagicMock()
        request.headers = {"host": "alice.localhost", "content-type": "application/json"}
        request.method = "POST"
        request.url = MagicMock()
        request.url.query = ""
        request.body = AsyncMock(return_value=b'{"key":"value"}')

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/api/data")

        assert resp.status_code == 201

    @pytest.mark.asyncio
    @respx.mock
    async def test_forwards_query_string(self):
        """Query string should be appended to proxied URL."""
        respx.get("http://172.20.0.5:80/public/search?q=hello&page=2").mock(
            return_value=httpx.Response(200, text="results")
        )

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.method = "GET"
        request.url = MagicMock()
        request.url.query = "q=hello&page=2"
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/search")

        assert resp.status_code == 200

    @pytest.mark.asyncio
    @respx.mock
    async def test_port_forwarding(self):
        """username-3000 subdomain should proxy to port 3000."""
        respx.get("http://172.20.0.5:3000/").mock(
            return_value=httpx.Response(200, text="dev server")
        )

        request = MagicMock()
        # Simulate self-access: the VALIDATED transport peer (request.client.host,
        # from uvicorn) matches the container IP → in-box trust, cookie auth
        # bypassed. A raw X-Forwarded-For no longer grants this (H1).
        request.headers = {"host": "alice-3000.localhost"}
        request.client = SimpleNamespace(host="172.20.0.5")
        request.cookies = {}
        request.method = "GET"
        request.url = MagicMock()
        request.url.query = ""
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "")

        assert resp.status_code == 200
        assert b"dev server" in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_strips_hop_by_hop_headers(self):
        """Response should not include hop-by-hop or content-encoding headers."""
        respx.get("http://172.20.0.5:80/public/page").mock(
            return_value=httpx.Response(
                200,
                text="ok",
                headers={
                    "content-type": "text/html",
                    "x-custom": "kept",
                },
            )
        )

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.method = "GET"
        request.url = MagicMock()
        request.url.query = ""
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/page")

        # Hop-by-hop headers should be stripped
        assert "transfer-encoding" not in resp.headers
        assert "content-encoding" not in resp.headers
        # Starlette auto-adds correct content-length from body — that's fine
        # Custom headers should be kept
        assert resp.headers.get("x-custom") == "kept"

    @pytest.mark.asyncio
    @respx.mock
    async def test_removes_host_from_forwarded_headers(self):
        """Host header should not be forwarded to container."""
        route = respx.get("http://172.20.0.5:80/public/page").mock(
            return_value=httpx.Response(200, text="ok")
        )

        request = MagicMock()
        request.headers = {
            "host": "alice.localhost",
            "user-agent": "test-browser",
            "accept": "text/html",
        }
        request.method = "GET"
        request.url = MagicMock()
        request.url.query = ""
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            await proxy_subdomain(request, "public/page")

        # Verify host was stripped from forwarded request headers
        forwarded_headers = {k.lower(): v for k, v in route.calls[0].request.headers.items()}
        assert forwarded_headers.get("host") != "alice.localhost"

    @pytest.mark.asyncio
    @respx.mock
    async def test_upstream_error_forwarded(self):
        """Upstream 500 errors should be forwarded to client."""
        respx.get("http://172.20.0.5:80/public/page").mock(
            return_value=httpx.Response(500, text="Internal Server Error")
        )

        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.method = "GET"
        request.url = MagicMock()
        request.url.query = ""
        request.body = AsyncMock(return_value=b"")

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/page")

        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_upstream_connection_error(self):
        """Connection error to container should return 502."""
        request = MagicMock()
        request.headers = {"host": "alice.localhost"}
        request.method = "GET"
        request.url = MagicMock()
        request.url.query = ""
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

    @pytest.mark.asyncio
    @respx.mock
    async def test_records_port_hit_only_after_successful_http_proxy(self):
        """Port activity should be recorded only after upstream request succeeds."""
        port_service._public_ports["owner-1"] = {3000}
        respx.get("http://172.20.0.5:3000/").mock(
            return_value=httpx.Response(200, text="ok")
        )

        request = _make_request(
            "alice-3000.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch("api.routers.proxy.ports.record_port_hit") as record_port_hit,
        ):
            resp = await proxy_subdomain(request, "")

        assert resp.status_code == 200
        record_port_hit.assert_called_once_with("owner-1", 3000)

    @pytest.mark.asyncio
    async def test_does_not_record_port_hit_when_http_proxy_fails(self):
        """Failed upstream connects must not refresh port activity."""
        port_service._public_ports["owner-1"] = {3000}
        request = _make_request(
            "alice-3000.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )

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
            patch("api.routers.proxy.ports.record_port_hit") as record_port_hit,
        ):
            resp = await proxy_subdomain(request, "")

        assert resp.status_code == 502
        record_port_hit.assert_not_called()


# --- Helpers for auth gate tests ---

def _make_request(host, path="", cookies=None, forwarded_for=None, client_ip=None):
    """Build a mock Request for proxy_subdomain calls.

    ``client_ip`` sets ``request.client.host`` (uvicorn's validated peer, what the
    in-box trust gate reads since H1). ``forwarded_for`` still sets the raw header
    but that no longer grants trust — kept so tests can assert it's ignored.
    """
    request = MagicMock()
    headers = {"host": host}
    if forwarded_for:
        headers["x-forwarded-for"] = forwarded_for
    request.headers = headers
    request.cookies = cookies or {}
    request.method = "GET"
    request.url = MagicMock(query="")
    request.body = AsyncMock(return_value=b"")
    request.client = SimpleNamespace(host=client_ip) if client_ip else None
    return request


class TestProxyAuthGate:
    """Test the ownership/cookie auth gate on non-public paths."""

    @pytest.mark.asyncio
    async def test_private_path_no_token_returns_401(self):
        """Non-public path without shellteam_token cookie → 401."""
        request = _make_request("alice.localhost", cookies={})
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "secret/file.txt")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_private_path_invalid_token_returns_401(self):
        """Bad cookie → verify_token raises HTTPException(401) → 401."""
        request = _make_request("alice.localhost", cookies={"shellteam_token": "bad"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                side_effect=HTTPException(status_code=401, detail="Invalid or expired token"),
            ),
        ):
            resp = await proxy_subdomain(request, "secret/file.txt")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_private_path_unexpected_error_returns_401(self):
        """Any verify_token failure (including unexpected errors) returns 401."""
        request = _make_request("alice.localhost", cookies={"shellteam_token": "bad"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                side_effect=RuntimeError("unexpected crash"),
            ),
        ):
            resp = await proxy_subdomain(request, "secret/file.txt")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_private_path_wrong_user_returns_403(self):
        """Valid JWT but sub != owner_id → 403."""
        request = _make_request("alice.localhost", cookies={"shellteam_token": "valid"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "other-user"},
            ),
        ):
            resp = await proxy_subdomain(request, "secret/file.txt")
        assert resp.status_code == 403

    @pytest.mark.asyncio
    @respx.mock
    async def test_private_path_correct_owner_proxies(self):
        """Valid JWT + matching sub → proxied successfully."""
        respx.get("http://172.20.0.5:80/secret/file.txt").mock(
            return_value=httpx.Response(200, text="secret content")
        )
        request = _make_request("alice.localhost", cookies={"shellteam_token": "valid"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "owner-1"},
            ),
        ):
            resp = await proxy_subdomain(request, "secret/file.txt")
        assert resp.status_code == 200
        assert b"secret content" in resp.body

    @pytest.mark.asyncio
    async def test_port_forwarded_no_token_returns_401(self):
        """Port-forwarded subdomain from external IP, no cookie → 401."""
        port_service._public_ports.pop("owner-1", None)
        request = _make_request(
            "alice-3000.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_port_forwarded_wrong_user_returns_403(self):
        """Port-forwarded subdomain, valid token, wrong user → 403."""
        port_service._public_ports.pop("owner-1", None)
        request = _make_request(
            "alice-3000.localhost",
            cookies={"shellteam_token": "valid"},
            forwarded_for="203.0.113.99",
        )
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "wrong-user"},
            ),
        ):
            resp = await proxy_subdomain(request, "")
        assert resp.status_code == 403

    @pytest.mark.asyncio
    @respx.mock
    async def test_self_access_bypass_matches_ip(self):
        """Validated peer (request.client.host) = container IP → proxied without cookie."""
        respx.get("http://172.20.0.5:80/app/data").mock(
            return_value=httpx.Response(200, text="ok")
        )
        request = _make_request(
            "alice.localhost",
            cookies={},
            client_ip="172.20.0.5",
        )
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "app/data")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_self_access_bypass_different_ip_requires_auth(self):
        """X-Forwarded-For != container IP, no cookie → 401."""
        request = _make_request(
            "alice.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "app/data")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_private_path_container_offline_returns_503(self):
        """resolve_username_owner returns (None, None) → 503."""
        request = _make_request("alice.localhost")
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=(None, None),
        ):
            resp = await proxy_subdomain(request, "secret/file.txt")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    @respx.mock
    async def test_public_path_skips_ownership_check(self):
        """Public path uses resolve_username_owner but skips auth check."""
        respx.get("http://172.20.0.5:80/public/index.html").mock(
            return_value=httpx.Response(200, text="public page")
        )
        request = _make_request("alice.localhost", cookies={})
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "public/index.html")
        assert resp.status_code == 200


# --- Helpers for WebSocket auth tests ---

def _ws_scope(host, path="/", cookies=None, forwarded_for=None, client_ip=None,
              origin=None):
    """Build an ASGI websocket scope.

    ``client_ip`` sets ``scope["client"]`` (uvicorn's validated peer, read by the
    in-box trust gate since H1); ``forwarded_for`` sets the raw header, which no
    longer grants trust. ``origin`` sets the browser Origin header, which is the
    boundary the files credential is gated on for non-read methods.
    """
    headers = [(b"host", host.encode())]
    if cookies:
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
        headers.append((b"cookie", cookie_str.encode()))
    if forwarded_for:
        headers.append((b"x-forwarded-for", forwarded_for.encode()))
    if origin:
        headers.append((b"origin", origin.encode()))
    scope = {
        "type": "websocket",
        "headers": headers,
        "path": path,
        "query_string": b"",
    }
    if client_ip:
        scope["client"] = (client_ip, 54321)
    return scope


class TestWebSocketProxyAuth:
    """Test WebSocket proxy auth gate — rejects before upstream connection."""

    @pytest.mark.asyncio
    async def test_ws_no_cookie_closes_1008(self):
        """No shellteam_token in Cookie header → close 1008."""
        scope = _ws_scope("alice.localhost", path="/terminal")
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

    @pytest.mark.asyncio
    async def test_ws_invalid_token_closes_1008(self):
        """Bad token → verify_token raises HTTPException(401) → close 1008."""
        scope = _ws_scope("alice.localhost", path="/terminal", cookies={"shellteam_token": "bad"})
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                side_effect=HTTPException(status_code=401, detail="Invalid or expired token"),
            ),
        ):
            await proxy_websocket(scope, receive, send)

        close = next(m for m in sent if m.get("type") == "websocket.close")
        assert close["code"] == 1008

    @pytest.mark.asyncio
    async def test_ws_unexpected_error_closes_1008(self):
        """Any verify_token failure (including unexpected errors) closes with 1008."""
        scope = _ws_scope("alice.localhost", path="/terminal", cookies={"shellteam_token": "bad"})
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                side_effect=RuntimeError("unexpected crash"),
            ),
        ):
            await proxy_websocket(scope, receive, send)
        # Any verify_token failure closes with 1008 "Invalid token"
        close_msg = next((m for m in sent if m.get("type") == "websocket.close"), None)
        assert close_msg is not None
        assert close_msg.get("code") == 1008

    @pytest.mark.asyncio
    async def test_ws_wrong_user_closes_1008(self):
        """Valid token, sub != owner_id → close 1008 'Access denied'."""
        scope = _ws_scope("alice.localhost", path="/terminal", cookies={"shellteam_token": "valid"})
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "wrong-user"},
            ),
        ):
            await proxy_websocket(scope, receive, send)

        close = next(m for m in sent if m.get("type") == "websocket.close")
        assert close["code"] == 1008

    @pytest.mark.asyncio
    async def test_ws_container_offline_closes_1013(self):
        """No container → close 1013."""
        scope = _ws_scope("alice.localhost", path="/terminal")
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=(None, None),
        ):
            await proxy_websocket(scope, receive, send)

        close = next(m for m in sent if m.get("type") == "websocket.close")
        assert close["code"] == 1013

    @pytest.mark.asyncio
    async def test_ws_self_access_bypass(self):
        """Validated peer = container IP → no close (proceeds to connect upstream).

        We mock websockets.connect to raise immediately, proving auth was passed.
        """
        scope = _ws_scope(
            "alice.localhost",
            path="/terminal",
            cookies={},
            client_ip="172.20.0.5",
        )
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.websockets.connect",
                side_effect=ConnectionRefusedError("no upstream"),
            ),
        ):
            await proxy_websocket(scope, receive, send)

        # If auth had failed, we'd see code 1008. Instead, the WS was accepted
        # (websocket.accept sent) and then the upstream connection failed.
        close_msgs = [m for m in sent if m.get("type") == "websocket.close"]
        accept_msgs = [m for m in sent if m.get("type") == "websocket.accept"]
        assert accept_msgs, "WebSocket should have been accepted (auth passed)"
        # No 1008 close
        for m in close_msgs:
            assert m.get("code") != 1008

    @pytest.mark.asyncio
    async def test_ws_cockpit_from_external_browser_passes_auth(self):
        """REGRESSION (2026-07-19): the cockpit socket must survive the FULL WS
        path for a client that does NOT get in-box trust.

        This is the test that would have caught the M1 breakage. Verifying from
        the box itself is a FALSE PASS: uvicorn's peer is then the owner IP, the
        in-box-trust branch short-circuits, and `_authorize` never runs — so
        curl-from-the-VPS reports a healthy cockpit while every real browser is
        refused. Here the peer is a public IP, so the credential gate is real.
        """
        from api.services.auth import files_token

        host = "alice-3456.localhost"
        scope = _ws_scope(
            host,
            path="/ws",
            cookies={"shellteam_files": files_token()},
            client_ip="203.0.113.9",          # external peer — no in-box trust
            origin=f"https://{host}",          # the cockpit driving itself
        )
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.websockets.connect",
                side_effect=ConnectionRefusedError("no upstream"),
            ),
        ):
            await proxy_websocket(scope, receive, send)

        # Auth passed if we reached the upstream connect (which we made fail).
        # A 1008 close means the credential gate refused the cockpit's own socket.
        for m in sent:
            if m.get("type") == "websocket.close":
                assert m.get("code") != 1008, (
                    "cockpit WebSocket refused for an external browser — the "
                    "files credential is the only one it carries"
                )

    @pytest.mark.asyncio
    async def test_ws_records_port_hit_only_after_upstream_connect(self):
        """WebSocket port activity should be recorded only after upstream connect succeeds."""
        port_service._public_ports["owner-1"] = {3000}
        scope = _ws_scope(
            "alice-3000.localhost",
            path="/ws",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        sent = []

        class _MockContainerWS:
            async def send(self, _data):
                return None

            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        class _ConnectCtx:
            async def __aenter__(self):
                return _MockContainerWS()

            async def __aexit__(self, exc_type, exc, tb):
                return False

        messages = iter(
            [
                {"type": "websocket.connect"},
                {"type": "websocket.disconnect"},
            ]
        )

        async def receive():
            return next(messages)

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch("api.routers.proxy.websockets.connect", return_value=_ConnectCtx()),
            patch("api.routers.proxy.ports.record_port_hit") as record_port_hit,
        ):
            await proxy_websocket(scope, receive, send)

        accept_msgs = [m for m in sent if m.get("type") == "websocket.accept"]
        assert accept_msgs
        record_port_hit.assert_called_once_with("owner-1", 3000)

    @pytest.mark.asyncio
    async def test_ws_does_not_record_port_hit_when_upstream_connect_fails(self):
        """Failed WebSocket upstream connects must not refresh port activity."""
        port_service._public_ports["owner-1"] = {3000}
        scope = _ws_scope(
            "alice-3000.localhost",
            path="/ws",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.websockets.connect",
                side_effect=ConnectionRefusedError("no upstream"),
            ),
            patch("api.routers.proxy.ports.record_port_hit") as record_port_hit,
        ):
            await proxy_websocket(scope, receive, send)

        record_port_hit.assert_not_called()


class TestFileBrowserIsolation:
    """Test cross-user isolation for FileBrowser (/_files/) paths.

    FileBrowser runs in noauth mode inside each container, so all security
    depends on the proxy auth gate rejecting cross-user requests before
    they reach the container.
    """

    @pytest.mark.asyncio
    async def test_files_no_cookie_returns_401(self):
        """/_files/ without shellteam_token cookie → 401."""
        request = _make_request("alice.localhost", cookies={})
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "_files/")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_files_wrong_user_returns_403(self):
        """/_files/ with valid JWT belonging to another user → 403."""
        request = _make_request("alice.localhost", cookies={"shellteam_token": "valid"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "attacker-user"},
            ),
        ):
            resp = await proxy_subdomain(request, "_files/")
        assert resp.status_code == 403

    @pytest.mark.asyncio
    @respx.mock
    async def test_files_correct_owner_proxies(self):
        """/_files/ with matching owner JWT → proxied successfully."""
        respx.get("http://172.20.0.5:80/_files/").mock(
            return_value=httpx.Response(200, text="<html>FileBrowser</html>")
        )
        request = _make_request("alice.localhost", cookies={"shellteam_token": "valid"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "owner-1"},
            ),
        ):
            resp = await proxy_subdomain(request, "_files/")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_files_api_wrong_user_returns_403(self):
        """/_files/api/resources/ (FileBrowser API) with wrong user → 403."""
        request = _make_request("alice.localhost", cookies={"shellteam_token": "valid"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "attacker-user"},
            ),
        ):
            resp = await proxy_subdomain(request, "_files/api/resources/")
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_files_path_traversal_blocked(self):
        """/_files/../../etc/passwd → 400 (path traversal blocked at proxy)."""
        request = _make_request("alice.localhost", cookies={"shellteam_token": "valid"})
        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.verify_token",
                return_value={"sub": "owner-1"},
            ),
        ):
            resp = await proxy_subdomain(request, "_files/../../etc/passwd")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_files_not_public(self):
        """/_files/ is NOT in the public paths list — always requires auth."""
        request = _make_request(
            "alice.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "_files/")
        assert resp.status_code == 401


class TestPublicPortBypass:
    """Test that public ports skip auth on both HTTP and WebSocket."""

    @pytest.fixture(autouse=True)
    def _clean_ports(self):
        port_service._public_ports.clear()
        yield
        port_service._public_ports.clear()

    @pytest.mark.asyncio
    @respx.mock
    async def test_public_port_skips_auth_http(self):
        """Port marked public → no cookie needed, request proxied."""
        port_service._public_ports["owner-1"] = {3000}
        respx.get("http://172.20.0.5:3000/").mock(
            return_value=httpx.Response(200, text="public app")
        )
        request = _make_request(
            "alice-3000.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "")
        assert resp.status_code == 200
        assert b"public app" in resp.body

    @pytest.mark.asyncio
    async def test_non_public_port_still_requires_auth(self):
        """Port NOT marked public → still needs cookie."""
        port_service._public_ports["owner-1"] = {3000}
        request = _make_request(
            "alice-8000.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    @respx.mock
    async def test_port80_private_path_unaffected(self):
        """Port 80 non-public path stays private even if port 80 were in public_ports."""
        port_service._public_ports["owner-1"] = {80}
        request = _make_request(
            "alice.localhost",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ):
            resp = await proxy_subdomain(request, "secret/file.txt")
        # port == 80, so the public_ports check is skipped (port != 80 guard)
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_public_port_skips_auth_websocket(self):
        """WebSocket on public port → accepted without cookie."""
        port_service._public_ports["owner-1"] = {3000}
        scope = _ws_scope(
            "alice-3000.localhost",
            path="/ws",
            cookies={},
            forwarded_for="203.0.113.99",
        )
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        with (
            patch(
                "api.routers.proxy.resolve_username_owner",
                new_callable=AsyncMock,
                return_value=("172.20.0.5", "owner-1"),
            ),
            patch(
                "api.routers.proxy.websockets.connect",
                side_effect=ConnectionRefusedError("no upstream"),
            ),
        ):
            await proxy_websocket(scope, receive, send)

        accept_msgs = [m for m in sent if m.get("type") == "websocket.accept"]
        assert accept_msgs, "WebSocket should be accepted on public port"
        for m in sent:
            if m.get("type") == "websocket.close":
                assert m.get("code") != 1008

    @pytest.mark.asyncio
    async def test_ws_non_public_port_still_requires_auth(self):
        """WebSocket on non-public port → close 1008."""
        scope = _ws_scope(
            "alice-8000.localhost",
            path="/ws",
            cookies={},
            forwarded_for="203.0.113.99",
        )
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


class TestIsPublicPath:
    """Handles both HTTP (no leading slash) and WS (leading slash) forms."""

    def test_public_folder_http(self):
        assert _is_public_path("public/index.html", 80) is True
        assert _is_public_path("public", 80) is True

    def test_public_folder_ws(self):
        assert _is_public_path("/public/foo", 80) is True

    def test_old_guest_chat_paths_no_longer_public(self):
        """The guest-chat feature was removed (docs/decisions/20260707-scoped-guest-cockpit.md);
        its bypass paths must no longer skip auth."""
        assert _is_public_path("chatwithme", 80) is False
        assert _is_public_path("/ws/guest/abc", 80) is False

    def test_private_path(self):
        assert _is_public_path("projects/secret", 80) is False

    def test_non_port_80(self):
        assert _is_public_path("public/index.html", 3000) is False


class TestExtractCookie:
    def test_extracts_token(self):
        assert _extract_cookie("shellteam_token=abc.def.ghi", "shellteam_token") == "abc.def.ghi"

    def test_extracts_from_multiple(self):
        assert _extract_cookie("foo=bar; shellteam_token=xyz; baz=1", "shellteam_token") == "xyz"

    def test_extracts_files_cookie(self):
        assert _extract_cookie("shellteam_token=a; shellteam_files=b", "shellteam_files") == "b"

    def test_missing_returns_none(self):
        assert _extract_cookie("foo=bar; baz=1", "shellteam_token") is None

    def test_empty_header(self):
        assert _extract_cookie("", "shellteam_token") is None


def _auth(master=None, files=None, owner="seb", port=80, method="GET",
          origin=None, host="seb.localhost"):
    """_authorize with keyword ergonomics for the split-credential matrix."""
    return _authorize(master, files, owner, port, method, origin, host)


class TestAuthorize:
    def test_no_token(self):
        assert _auth() == AUTH_NO_TOKEN
        assert _auth(master="", files="") == AUTH_NO_TOKEN

    def test_trust_mode_passes_legit_requests(self):
        """OWNER_TOKEN empty = localhost-trust mode: no credential exists to mint,
        so the token requirement is skipped and legit requests pass — otherwise
        `owner.localhost` files and `owner-<port>.localhost` app previews 401 on
        a default laptop install (found by fresh-box QA, 2026-07-05)."""
        with patch("api.routers.proxy.OWNER_TOKEN", ""):
            # Header-less GETs (top-level navigations) and same-origin/dashboard
            # requests are the legitimate traffic — they pass.
            assert _auth() == AUTH_OK                                   # no Origin, file host GET
            assert _auth(port=3456, method="WEBSOCKET") == AUTH_OK      # cockpit WS, no Origin
            assert _auth(port=9777, method="GET") == AUTH_OK            # app preview, no Origin
            assert _auth(origin="http://seb.localhost", host="seb.localhost") == AUTH_OK  # same-origin
            assert _auth(origin="http://localhost") == AUTH_OK          # dashboard (MAIN_HOSTS)
            # stale cookies are irrelevant in trust mode — still passes
            assert _auth(master="stale", files="stale") == AUTH_OK

    def test_trust_mode_still_blocks_csrf(self):
        """Trust mode skips the TOKEN check but keeps the CSRF gates: *.localhost
        resolves to 127.0.0.1, so a page the owner visits must not ride a
        cross-origin request into the cockpit or write to the file host."""
        with patch("api.routers.proxy.OWNER_TOKEN", ""):
            # Cross-origin (evil.com) into the cockpit / an app port — refused.
            assert _auth(port=3456, method="WEBSOCKET", origin="http://evil.com") == AUTH_FORBIDDEN
            assert _auth(port=9777, method="GET", origin="http://evil.com") == AUTH_FORBIDDEN
            # Non-read method against the file host — refused (read-only host).
            assert _auth(method="POST") == AUTH_FORBIDDEN
            assert _auth(method="DELETE", origin="http://evil.com") == AUTH_FORBIDDEN

    def test_bad_master(self):
        with patch("api.routers.proxy.verify_token", side_effect=ValueError("bad")):
            assert _auth(master="junk") == AUTH_BAD_TOKEN

    def test_owner_master_allowed_everything(self):
        with patch("api.routers.proxy.verify_token", return_value={"sub": "seb"}):
            assert _auth(master="tok") == AUTH_OK
            assert _auth(master="tok", method="POST") == AUTH_OK
            assert _auth(master="tok", port=3000, method="WEBSOCKET") == AUTH_OK

    def test_non_owner_forbidden(self):
        with patch("api.routers.proxy.verify_token", return_value={"sub": "alex"}):
            assert _auth(master="tok") == AUTH_FORBIDDEN

    def test_non_owner_forbidden_on_forwarded_port(self):
        with patch("api.routers.proxy.verify_token", return_value={"sub": "alex"}):
            assert _auth(master="tok", port=3000) == AUTH_FORBIDDEN


class TestAuthorizeFilesCredential:
    """The derived read-only credential: reads yes, writes/cockpit-riding no."""

    def _files_cred(self):
        from api.services.auth import files_token
        return files_token()

    def test_files_cred_reads_file_host(self):
        assert _auth(files=self._files_cred()) == AUTH_OK
        assert _auth(files=self._files_cred(), method="HEAD") == AUTH_OK

    def test_files_cred_cannot_write_file_host(self):
        assert _auth(files=self._files_cred(), method="POST") == AUTH_FORBIDDEN
        assert _auth(files=self._files_cred(), method="PUT") == AUTH_FORBIDDEN
        assert _auth(files=self._files_cred(), method="WEBSOCKET") == AUTH_FORBIDDEN

    def test_files_cred_wrong_value_rejected(self):
        assert _auth(files="not-the-derived-credential") == AUTH_BAD_TOKEN

    def test_files_cred_master_value_is_not_files_cred(self):
        # The raw master in the files slot still works (token_grants_files_read
        # accepts the master) — it IS the stronger credential.
        assert _auth(files="fake-jwt-token") == AUTH_OK

    def test_cockpit_port_drives_from_its_own_origin(self):
        """REGRESSION (2026-07-19): the cockpit's own WebSocket must authorize.

        The cockpit is served as a cross-origin sibling at
        `<owner>-<AI_CHAT_PORT>.<APP_DOMAIN>`, and the master cookie is host-only
        on the dashboard — so the files credential is the ONLY credential the
        cockpit iframe carries, and its WS/POST authenticate with it. The M1
        hardening refused every non-read method on every port, which left the
        cockpit loading (GET ok) but dead (socket forbidden) on every deploy with
        OWNER_TOKEN set. Origin — not method — is the boundary on this port.
        """
        cred = self._files_cred()
        host = "alice-3456.localhost"
        same = f"https://{host}"
        # Read from a trusted origin / no-Origin navigation — allowed.
        assert _auth(files=cred, port=3456, host=host) == AUTH_OK
        assert _auth(files=cred, port=3456, method="GET", origin=same, host=host) == AUTH_OK
        # The cockpit driving ITSELF — the live-broken case. Must be allowed.
        assert _auth(files=cred, port=3456, method="WEBSOCKET", origin=same, host=host) == AUTH_OK
        assert _auth(files=cred, port=3456, method="POST", origin=same, host=host) == AUTH_OK
        # The dashboard origin (MAIN_HOSTS) may also drive it.
        assert _auth(files=cred, port=3456, method="POST",
                     origin="https://localhost", host=host) == AUTH_OK

    def test_cockpit_port_mutation_requires_an_explicit_origin(self):
        """A header-less mutation is never a legitimate browser flow — browsers
        always attach Origin to WS/POST — so it stays refused. This keeps M1's
        defense-in-depth against a non-browser client that exfiltrated the
        HttpOnly cookie, without breaking the cockpit's own socket."""
        cred = self._files_cred()
        host = "alice-3456.localhost"
        assert _auth(files=cred, port=3456, method="WEBSOCKET", host=host) == AUTH_FORBIDDEN
        assert _auth(files=cred, port=3456, method="POST", host=host) == AUTH_FORBIDDEN
        # Reads keep the lenient rule (top-level navigations carry no Origin).
        assert _auth(files=cred, port=3456, method="GET", host=host) == AUTH_OK

    def test_cockpit_port_blocks_riding_from_served_content(self):
        """XSS on a served file page must not drive the agents. This is the
        escalation M1 targeted, and the Origin gate — not the method gate — is
        what actually stops it."""
        cred = self._files_cred()
        host = "alice-3456.localhost"
        evil = "https://alice.localhost"  # the file subdomain — serves user content
        assert _auth(files=cred, port=3456, method="POST", origin=evil, host=host) == AUTH_FORBIDDEN
        assert _auth(files=cred, port=3456, method="WEBSOCKET", origin=evil, host=host) == AUTH_FORBIDDEN
        assert _auth(files=cred, port=3456, method="GET", origin=evil, host=host) == AUTH_FORBIDDEN
        assert _auth(files=cred, port=3456, method="POST", origin="null", host=host) == AUTH_FORBIDDEN

    def test_app_port_files_cred_follows_the_same_origin_rule(self):
        """Agent-built apps are full web apps — they need POST from their own
        origin. Cross-origin mutations stay refused."""
        cred = self._files_cred()
        host = "alice-8080.localhost"
        assert _auth(files=cred, port=8080, method="GET",
                     origin=f"https://{host}", host=host) == AUTH_OK
        assert _auth(files=cred, port=8080, method="POST",
                     origin=f"https://{host}", host=host) == AUTH_OK
        # Riding in from the content-serving file subdomain — refused.
        assert _auth(files=cred, port=8080, method="POST",
                     origin="https://alice.localhost", host=host) == AUTH_FORBIDDEN

    def test_file_host_stays_strictly_read_only(self):
        """The one port where method IS the boundary: the files credential must
        never write the owner's files, from any origin."""
        cred = self._files_cred()
        host = "alice.localhost"
        for origin in (None, f"https://{host}", "https://localhost"):
            assert _auth(files=cred, method="POST", origin=origin, host=host) == AUTH_FORBIDDEN
            assert _auth(files=cred, method="PUT", origin=origin, host=host) == AUTH_FORBIDDEN
            assert _auth(files=cred, method="WEBSOCKET", origin=origin, host=host) == AUTH_FORBIDDEN


class TestCockpitReachableWithBrowserCredential:
    """Product invariant, pinned so a security tightening can't silently kill the
    cockpit again.

    The M1 regression slipped through because the unit tests asserted a security
    property ("files cred is read-only everywhere") in isolation — nothing tied
    that assertion back to "the cockpit URL the dashboard embeds must actually
    work with the credential a browser holds at that URL". This test couples the
    two: it derives the cockpit host the same way the dashboard does and asserts
    the socket authorizes.
    """

    def test_dashboard_cockpit_url_authorizes_its_websocket(self):
        from api.services.auth import files_token
        from api.config import OWNER_USERNAME, APP_DOMAIN, OWNER_ID

        ai_chat_port = int(os.environ["AI_CHAT_PORT"])
        # Exactly how api/main.py:_cockpit_url builds the iframe target.
        cockpit_host = f"{OWNER_USERNAME}-{ai_chat_port}.{APP_DOMAIN}"
        origin = f"https://{cockpit_host}"

        # A browser at that origin carries ONLY the files cookie: the master
        # `shellteam_token` is host-only on the dashboard and never reaches a
        # subdomain. So this is the real credential the cockpit socket presents.
        assert _authorize(
            None, files_token(), OWNER_ID, ai_chat_port, "WEBSOCKET",
            origin, cockpit_host,
        ) == AUTH_OK


class TestMainHostFileServing:
    """Main-domain file URLs: https://APP_DOMAIN/<path> == the owner's ~/<path>.

    Security-critical — this catch-all stands between the internet and $HOME.
    The suite runs with OWNER_TOKEN set (conftest), so the real token gate is
    exercised, not a mock.
    """

    FILE_ORIGIN = "http://127.0.0.1:80"  # FILE_PORT defaults to 80 in tests

    def _request(self, headers=None, cookies=None, query_params=None, method="GET"):
        request = MagicMock()
        request.headers = {"host": "localhost", **(headers or {})}
        request.cookies = cookies or {}
        request.query_params = query_params or {}
        request.method = method
        request.url = MagicMock()
        request.url.query = ""
        request.body = AsyncMock(return_value=b"")
        return request

    # --- Gate 1: traversal ---

    @pytest.mark.asyncio
    async def test_path_traversal_rejected(self):
        resp = await proxy_subdomain(self._request(), "reports/../.ssh/id_rsa")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_encoded_traversal_rejected(self):
        resp = await proxy_subdomain(self._request(), "reports/%2e%2e/secret")
        assert resp.status_code == 400

    # --- Gate 2: dotfiles never served, even to the owner ---

    @pytest.mark.asyncio
    @respx.mock
    async def test_dotfile_blocked_before_forwarding(self):
        route = respx.get(f"{self.FILE_ORIGIN}/.env").mock(
            return_value=httpx.Response(200, text="SECRET=1")
        )
        for path in (".env", ".ssh/id_rsa", "projects/.env", "%2Eenv"):
            request = self._request(headers={"Authorization": "Bearer fake-jwt-token"})
            resp = await proxy_subdomain(request, path)
            assert resp.status_code == 404, f"{path} must be blocked"
            assert b"SECRET" not in resp.body
        assert not route.called, "dotfile request must never reach the file server"

    # --- Gate 3: owner token required for private paths ---

    @pytest.mark.asyncio
    async def test_private_file_requires_token(self):
        resp = await proxy_subdomain(self._request(), "reports/private.html")
        assert resp.status_code == 401
        assert b"Sign in" in resp.body

    @pytest.mark.asyncio
    async def test_wrong_token_rejected(self):
        request = self._request(headers={"Authorization": "Bearer wrong-token"})
        resp = await proxy_subdomain(request, "reports/private.html")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    @respx.mock
    async def test_owner_bearer_token_serves_file(self):
        respx.get(f"{self.FILE_ORIGIN}/reports/r.html").mock(
            return_value=httpx.Response(200, text="<h1>report</h1>", headers={"content-type": "text/html"})
        )
        request = self._request(headers={"Authorization": "Bearer fake-jwt-token"})
        resp = await proxy_subdomain(request, "reports/r.html")
        assert resp.status_code == 200
        assert b"report" in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_owner_cookie_serves_file(self):
        respx.get(f"{self.FILE_ORIGIN}/tmp/chart.png").mock(
            return_value=httpx.Response(200, content=b"PNG")
        )
        request = self._request(cookies={"shellteam_token": "fake-jwt-token"})
        resp = await proxy_subdomain(request, "tmp/chart.png")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @respx.mock
    async def test_query_token_rejected(self):
        """?token= master acceptance is dead — a raw master token in a URL would
        land in history/logs/Referers. (Signed ?sig=&exp= links replace it.)"""
        request = self._request(query_params={"token": "fake-jwt-token"})
        resp = await proxy_subdomain(request, "tmp/chart.png")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    @respx.mock
    async def test_special_char_filename_reencoded_for_forward(self):
        """A `#`/space in a filename must be re-encoded before forwarding to the
        file server (httpx would otherwise treat `#` as a fragment → 404). The
        route hands us the DECODED path; the forward URL must percent-encode it."""
        route = respx.get(f"{self.FILE_ORIGIN}/tmp/hash%20%231.html").mock(
            return_value=httpx.Response(200, content=b"ok")
        )
        request = self._request(headers={"Authorization": "Bearer fake-jwt-token"})
        resp = await proxy_subdomain(request, "tmp/hash #1.html")
        assert resp.status_code == 200
        assert route.called

    # --- Split credentials on the main host ---

    @pytest.mark.asyncio
    @respx.mock
    async def test_files_credential_reads(self):
        from api.services.auth import files_token
        respx.get(f"{self.FILE_ORIGIN}/tmp/chart.png").mock(
            return_value=httpx.Response(200, content=b"PNG")
        )
        request = self._request(cookies={"shellteam_files": files_token()})
        resp = await proxy_subdomain(request, "tmp/chart.png")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @respx.mock
    async def test_files_credential_cannot_write(self):
        """The read-only credential must not reach the editor's write API."""
        from api.services.auth import files_token
        route = respx.post(f"{self.FILE_ORIGIN}/_api/save").mock(
            return_value=httpx.Response(200)
        )
        request = self._request(cookies={"shellteam_files": files_token()}, method="POST")
        resp = await proxy_subdomain(request, "_api/save")
        assert resp.status_code == 401
        assert not route.called

    @pytest.mark.asyncio
    @respx.mock
    async def test_master_cookie_can_write(self):
        """Editor saves (main-origin iframe) ride the host-only master cookie."""
        respx.post(f"{self.FILE_ORIGIN}/_api/save").mock(return_value=httpx.Response(200))
        request = self._request(cookies={"shellteam_token": "fake-jwt-token"}, method="POST")
        resp = await proxy_subdomain(request, "_api/save")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @respx.mock
    async def test_signed_link_serves_exact_path(self):
        import time
        from api.services.auth import sign_share_path
        respx.get(f"{self.FILE_ORIGIN}/reports/private.html").mock(
            return_value=httpx.Response(200, text="secret report")
        )
        exp = int(time.time()) + 300
        sig = sign_share_path("reports/private.html", exp)
        request = self._request(query_params={"sig": sig, "exp": str(exp)})
        resp = await proxy_subdomain(request, "reports/private.html")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_signed_link_wrong_path_rejected(self):
        import time
        from api.services.auth import sign_share_path
        exp = int(time.time()) + 300
        sig = sign_share_path("reports/private.html", exp)
        request = self._request(query_params={"sig": sig, "exp": str(exp)})
        resp = await proxy_subdomain(request, "reports/other.html")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_signed_link_expired_rejected(self):
        import time
        from api.services.auth import sign_share_path
        exp = int(time.time()) - 1
        sig = sign_share_path("reports/private.html", exp)
        request = self._request(query_params={"sig": sig, "exp": str(exp)})
        resp = await proxy_subdomain(request, "reports/private.html")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_signed_link_cannot_write(self):
        import time
        from api.services.auth import sign_share_path
        exp = int(time.time()) + 300
        sig = sign_share_path("_api/save", exp)
        request = self._request(query_params={"sig": sig, "exp": str(exp)}, method="POST")
        resp = await proxy_subdomain(request, "_api/save")
        assert resp.status_code == 401

    # --- Public bypasses: ~/public + published reports only ---

    @pytest.mark.asyncio
    @respx.mock
    async def test_public_folder_needs_no_token(self):
        respx.get(f"{self.FILE_ORIGIN}/public/share.html").mock(
            return_value=httpx.Response(200, text="shared")
        )
        resp = await proxy_subdomain(self._request(), "public/share.html")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @respx.mock
    async def test_published_report_needs_no_token(self):
        respx.get(f"{self.FILE_ORIGIN}/reports/published.html").mock(
            return_value=httpx.Response(200, text="published report")
        )
        with patch("api.routers.proxy.reports.is_report_public", return_value=True):
            resp = await proxy_subdomain(self._request(), "reports/published.html")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_arbitrary_main_host_path_needs_auth(self):
        # The main host serves only ~/public + published reports without a token;
        # any other path (here the retired guest-chat route) requires auth.
        resp = await proxy_subdomain(self._request(), "chatwithme")
        assert resp.status_code == 401

    # --- Polish: nginx 404 stays branded ---

    @pytest.mark.asyncio
    @respx.mock
    async def test_missing_file_gets_branded_404(self):
        respx.get(f"{self.FILE_ORIGIN}/tmp/nope.html").mock(
            return_value=httpx.Response(404, text="<html>nginx 404</html>")
        )
        request = self._request(headers={"Authorization": "Bearer fake-jwt-token"})
        resp = await proxy_subdomain(request, "tmp/nope.html")
        assert resp.status_code == 404
        assert b"nginx" not in resp.body
        assert b"404" in resp.body


class TestShareFooter:
    """The "Made with ShellTeam" footer brands what THIRD PARTIES see — published
    reports and signed share links — never the owner's own views and never plain
    ~/public hosting (docs/decisions/20260715-share-footer.md).
    """

    FILE_ORIGIN = "http://127.0.0.1:80"
    HTML = "<html><head></head><body><h1>Q3 report</h1></body></html>"

    _request = TestMainHostFileServing._request  # same main-host request shape

    def _mock_file(self, path, html=None, ctype="text/html", origin=None):
        return respx.get(f"{origin or self.FILE_ORIGIN}/{path}").mock(
            return_value=httpx.Response(
                200, text=html if html is not None else self.HTML,
                headers={"content-type": ctype},
            )
        )

    @pytest.mark.asyncio
    @respx.mock
    async def test_published_report_gets_footer_for_anonymous_viewer(self):
        self._mock_file("reports/q3.html")
        with patch("api.routers.proxy.reports.is_report_public", return_value=True):
            resp = await proxy_subdomain(self._request(), "reports/q3.html")
        assert resp.status_code == 200
        body = resp.body.decode()
        assert "Made with" in body and "https://shellteam.sh" in body
        # Injected inside the document, before </body> — and Content-Length is
        # recomputed for the grown body.
        assert body.rindex("shellteam.sh") < body.rindex("</body>")
        assert resp.headers["content-length"] == str(len(resp.body))

    @pytest.mark.asyncio
    @respx.mock
    async def test_owner_view_of_published_report_stays_clean(self):
        self._mock_file("reports/q3.html")
        request = self._request(headers={"Authorization": "Bearer fake-jwt-token"})
        with patch("api.routers.proxy.reports.is_report_public", return_value=True):
            resp = await proxy_subdomain(request, "reports/q3.html")
        assert resp.status_code == 200
        assert b"shellteam.sh" not in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_signed_share_link_gets_footer(self):
        import time
        from api.services.auth import sign_share_path
        self._mock_file("reports/private.html")
        exp = int(time.time()) + 300
        sig = sign_share_path("reports/private.html", exp)
        request = self._request(query_params={"sig": sig, "exp": str(exp)})
        resp = await proxy_subdomain(request, "reports/private.html")
        assert resp.status_code == 200
        assert b"Made with" in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_public_folder_html_is_never_badged(self):
        self._mock_file("public/site.html")
        resp = await proxy_subdomain(self._request(), "public/site.html")
        assert resp.status_code == 200
        assert b"shellteam.sh" not in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_non_html_shared_file_untouched(self):
        self._mock_file("reports/chart.png", html="PNGBYTES", ctype="image/png")
        with patch("api.routers.proxy.reports.is_report_public", return_value=True):
            resp = await proxy_subdomain(self._request(), "reports/chart.png")
        assert resp.status_code == 200
        assert resp.body == b"PNGBYTES"

    @pytest.mark.asyncio
    @respx.mock
    async def test_html_without_body_tag_still_footed(self):
        self._mock_file("reports/bare.html", html="<h1>bare</h1>")
        with patch("api.routers.proxy.reports.is_report_public", return_value=True):
            resp = await proxy_subdomain(self._request(), "reports/bare.html")
        assert resp.body.decode().endswith("</div>")
        assert b"Made with" in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_share_footer_kill_switch(self):
        self._mock_file("reports/q3.html")
        with patch("api.routers.proxy.SHARE_FOOTER", False), \
             patch("api.routers.proxy.reports.is_report_public", return_value=True):
            resp = await proxy_subdomain(self._request(), "reports/q3.html")
        assert resp.status_code == 200
        assert b"shellteam.sh" not in resp.body

    @pytest.mark.asyncio
    @respx.mock
    async def test_legacy_subdomain_published_report_gets_footer(self):
        """The pre-main-domain form (<owner>.APP_DOMAIN/reports/…) badges too."""
        self._mock_file("reports/q3.html", origin="http://172.20.0.5:80")
        request = self._request(headers={"host": "alice.localhost"})
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=("172.20.0.5", "owner-1"),
        ), patch("api.routers.proxy.reports.is_report_public", return_value=True):
            resp = await proxy_subdomain(request, "reports/q3.html")
        assert resp.status_code == 200
        assert b"Made with" in resp.body


class TestMainHostRoutePrecedence:
    """Registered routes must always win over the $HOME catch-all."""

    def test_health_still_served_by_api(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

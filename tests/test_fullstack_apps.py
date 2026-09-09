"""Regression tests for running full-stack apps (frontend + backend) on the box.

Each class pins one defect from the 2026-08-04 full-stack audit
(docs/decisions/20260804-fullstack-apps-on-the-box.md):

- ShellTeam's own CORSMiddleware wrapped the subdomain proxy, 400-ing every
  cross-subdomain preflight before the user's backend could answer it.
- Nothing reserved ShellTeam's own service ports: `owner-<API_PORT>` proxied
  the control plane into itself, and the ports API could flip it public.
- The proxy collapsed duplicate Set-Cookie headers and buffered bodies with a
  30s cap (no SSE/streaming).
- Sharing a running app meant flipping the port world-public forever; files had
  signed expiring links, ports had nothing.
"""

import time
from unittest.mock import patch, AsyncMock, MagicMock

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from api.config import API_PORT, STEEL_PORT, reserved_service_ports
from api.services import ports as port_service
from api.services.auth import (
    FILES_COOKIE,
    MASTER_COOKIE,
    PORT_SHARE_COOKIE,
    files_token,
    port_share_cookie_value,
    sign_share_port,
    verify_port_share_cookie,
    verify_share_port_sig,
)


APP_PORT = 4000  # an ordinary user app port (backend)
FRONTEND_PORT = 5173  # the frontend dev server (sibling origin)


def _internal_auth_headers(user_id="user-uuid-1234"):
    from api.services.internal_auth import make_token

    return {
        "Authorization": f"Bearer {make_token(user_id)}",
        "X-Shellteam-User-Id": user_id,
    }


@pytest.fixture(autouse=True)
def _clean_public_ports():
    port_service._public_ports.pop("user-uuid-1234", None)
    yield
    port_service._public_ports.pop("user-uuid-1234", None)


@pytest.fixture
def resolve_owner():
    with patch(
        "api.routers.proxy.resolve_username_owner",
        new_callable=AsyncMock,
        return_value=("172.20.0.5", "user-uuid-1234"),
    ):
        yield


class TestPrivateTwoPortApp:
    """The real 'full-stack app just works' claim: BOTH ports private, no public
    grant, no share link — the owner's own frontend calling its own backend."""

    @respx.mock
    def test_cross_origin_preflight_reaches_a_private_backend(self, resolve_owner):
        """A preflight carries no credentials, so it must pass through to the
        (private) backend rather than 401 at our edge — otherwise every
        cross-origin call in a two-port app dies before it starts. Before the
        CORS reorder our own middleware also 400'd it."""
        upstream = respx.options(f"http://172.20.0.5:{APP_PORT}/api/data").mock(
            return_value=httpx.Response(
                204,
                headers={
                    "access-control-allow-origin": f"https://alice-{FRONTEND_PORT}.localhost",
                    "access-control-allow-methods": "POST",
                },
            )
        )
        # No public port, no share cookie — genuinely private.
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.options(
                "/api/data",
                headers={
                    "host": f"alice-{APP_PORT}.localhost",
                    "Origin": f"https://alice-{FRONTEND_PORT}.localhost",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type",
                },
            )
        assert upstream.called, "preflight never reached the private backend"
        assert resp.status_code == 204
        assert "Disallowed CORS origin" not in resp.text

    @respx.mock
    def test_owner_frontend_can_post_to_private_backend(self, resolve_owner):
        """The authenticated owner's frontend (sibling app port) POSTing to its
        own private backend must be allowed — the sibling-app trust edge. This
        is refused by the base _origin_trusted rule (siblings aren't main hosts);
        it works only because both are the owner's non-reserved app ports."""
        upstream = respx.post(f"http://172.20.0.5:{APP_PORT}/api/items").mock(
            return_value=httpx.Response(201, json={"created": True})
        )
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.post(
                "/api/items",
                headers={
                    "host": f"alice-{APP_PORT}.localhost",
                    "Origin": f"https://alice-{FRONTEND_PORT}.localhost",
                    "Content-Type": "application/json",
                    "cookie": f"{FILES_COOKIE}={files_token()}",
                },
                json={"x": 1},
            )
        assert upstream.called, "owner sibling POST was blocked before the backend"
        assert resp.status_code == 201

    def test_sibling_trust_does_not_extend_to_the_cockpit(self, resolve_owner):
        """The sibling edge must never reach a reserved port: an app-port origin
        calling the cockpit (AI_CHAT_PORT) is still refused."""
        from api.config import AI_CHAT_PORT_NUM
        from api.routers.proxy import _origin_is_owner_app_sibling

        assert _origin_is_owner_app_sibling(
            f"https://alice-{FRONTEND_PORT}.localhost", APP_PORT
        )
        assert not _origin_is_owner_app_sibling(
            f"https://alice-{FRONTEND_PORT}.localhost", AI_CHAT_PORT_NUM
        )
        # A file-host origin is never a trusted app sibling (M1 escalation path).
        assert not _origin_is_owner_app_sibling("https://alice.localhost", APP_PORT)
        # A different username is never trusted.
        assert not _origin_is_owner_app_sibling(
            f"https://mallory-{FRONTEND_PORT}.localhost", APP_PORT
        )

    def test_control_plane_cors_still_answers_on_the_main_host(self):
        """The reorder must not disable CORS for the control plane itself."""
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.options(
                "/api/auth/login",
                headers={
                    "host": "localhost",
                    "Origin": "https://localhost",
                    "Access-Control-Request-Method": "POST",
                },
            )
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == "https://localhost"


class TestReservedServicePorts:
    """ShellTeam's own ports are not the user's to expose (or ours to squat)."""

    def test_service_ports_cannot_be_made_public(self):
        for port in reserved_service_ports():
            if port < 1024:
                continue  # already refused by the system-port floor
            with pytest.raises(ValueError, match="ShellTeam service"):
                port_service.set_port_visibility("user-uuid-1234", port, True)

    def test_api_port_is_never_proxied(self, resolve_owner):
        """`owner-<API_PORT>` must 404, not loop the control plane into itself."""
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get("/", headers={"host": f"alice-{API_PORT}.localhost"})
        assert resp.status_code == 404

    def test_steel_default_is_off_3000(self):
        """:3000 belongs to the user's dev servers (Next.js/CRA default)."""
        assert STEEL_PORT != 3000
        assert 3000 not in reserved_service_ports()

    def test_read_boundary_ignores_a_reserved_port_in_state(self):
        """Even if a reserved port is somehow in the in-memory set (a
        pre-reservation box), is_port_public() must not report it public."""
        reserved = sorted(reserved_service_ports())[0]
        port_service._public_ports["user-uuid-1234"] = {reserved, APP_PORT}
        try:
            assert not port_service.is_port_public("user-uuid-1234", reserved)
            assert port_service.is_port_public("user-uuid-1234", APP_PORT)
        finally:
            port_service._public_ports.pop("user-uuid-1234", None)

    def test_seed_scrubs_reserved_ports_from_disk(self, tmp_path, monkeypatch):
        """A public_ports.json written before reservation existed (containing
        e.g. the cockpit port) must be scrubbed AND rewritten on seed."""
        import json
        from api.config import AI_CHAT_PORT_NUM

        monkeypatch.setattr(port_service, "DATA_DIR", tmp_path)
        user_dir = tmp_path / "legacy-user"
        user_dir.mkdir()
        (user_dir / "public_ports.json").write_text(json.dumps([AI_CHAT_PORT_NUM, APP_PORT]))
        port_service._public_ports.pop("legacy-user", None)
        try:
            port_service.seed_from_disk()
            assert not port_service.is_port_public("legacy-user", AI_CHAT_PORT_NUM)
            on_disk = set(json.loads((user_dir / "public_ports.json").read_text()))
            assert AI_CHAT_PORT_NUM not in on_disk, "reserved port not rewritten out of disk"
            assert APP_PORT in on_disk
        finally:
            port_service._public_ports.pop("legacy-user", None)


class TestProxyResponseFidelity:
    @respx.mock
    def test_duplicate_set_cookie_headers_survive_the_proxy(self, resolve_owner):
        """An app setting session + CSRF cookies must not have them merged."""
        respx.get(f"http://172.20.0.5:{APP_PORT}/login").mock(
            return_value=httpx.Response(
                200,
                headers=[
                    ("set-cookie", "session=abc; Path=/"),
                    ("set-cookie", "csrf=xyz; Path=/"),
                ],
                text="ok",
            )
        )
        port_service._public_ports["user-uuid-1234"] = {APP_PORT}

        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get("/login", headers={"host": f"alice-{APP_PORT}.localhost"})

        cookies = resp.headers.get_list("set-cookie")
        assert "session=abc; Path=/" in cookies
        assert "csrf=xyz; Path=/" in cookies
        assert len(cookies) == 2

    @pytest.mark.asyncio
    @respx.mock
    async def test_app_port_response_streams_incrementally(self, resolve_owner):
        """Prove real streaming, not just that the bytes arrive: chunk two is
        produced only AFTER chunk one has surfaced downstream. A buffered proxy
        (the pre-fix code) reads the whole body before responding, so chunk one
        could never be observed before chunk two was produced — this cannot pass
        on the old path."""
        import asyncio
        from api.routers.proxy import proxy_subdomain

        chunk_one_seen = asyncio.Event()

        class _SlowStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"data: one\n\n"
                # Block the tail until the proxy has surfaced chunk one.
                await asyncio.wait_for(chunk_one_seen.wait(), timeout=2)
                yield b"data: two\n\n"

        port_service._public_ports["user-uuid-1234"] = {APP_PORT}
        respx.get(f"http://172.20.0.5:{APP_PORT}/events").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=_SlowStream(),
            )
        )

        request = _make_request(f"alice-{APP_PORT}.localhost", method="GET")
        resp = await proxy_subdomain(request, "events")
        assert resp.status_code == 200

        chunks = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk if isinstance(chunk, bytes) else chunk.encode())
            if len(chunks) == 1:
                assert chunks[0] == b"data: one\n\n"
                chunk_one_seen.set()  # release chunk two only now
        if resp.background:
            await resp.background()
        assert b"".join(chunks) == b"data: one\n\ndata: two\n\n"


class TestPortShareLinks:
    """Signed expiring links for running apps — parity with file share links."""

    def test_sign_and_verify_roundtrip(self):
        exp = int(time.time()) + 600
        sig = sign_share_port(APP_PORT, exp)
        assert verify_share_port_sig(APP_PORT, sig, str(exp))
        assert not verify_share_port_sig(APP_PORT + 1, sig, str(exp)), "sig must bind the port"
        assert not verify_share_port_sig(APP_PORT, sig, str(exp - 1200)), "expiry is signed"

    def test_expired_signature_is_refused(self):
        exp = int(time.time()) - 10
        sig = sign_share_port(APP_PORT, exp)
        assert not verify_share_port_sig(APP_PORT, sig, str(exp))

    def test_cookie_roundtrip_binds_port(self):
        exp = int(time.time()) + 600
        value = port_share_cookie_value(APP_PORT, exp)
        assert verify_port_share_cookie(value, APP_PORT)
        assert not verify_port_share_cookie(value, APP_PORT + 1)
        assert not verify_port_share_cookie("garbage", APP_PORT)
        assert not verify_port_share_cookie(None, APP_PORT)

    def test_owner_mints_port_link(self):
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get(
                "/api/auth/share",
                params={"port": APP_PORT, "ttl": 600},
                headers={"Authorization": "Bearer fake-jwt-token"},
            )
        assert resp.status_code == 200
        url = resp.json()["url"]
        assert f"alice-{APP_PORT}.localhost/?sig=" in url

    def test_owner_cannot_mint_link_for_service_port(self):
        with TestClient(_app(), base_url="http://localhost") as client:
            for port in sorted(reserved_service_ports()):
                if port < 1024:
                    continue
                resp = client.get(
                    "/api/auth/share",
                    params={"port": port, "ttl": 600},
                    headers={"Authorization": "Bearer fake-jwt-token"},
                )
                assert resp.status_code == 400, f"service port {port} was shareable"

    def test_agent_mints_port_link_via_internal(self):
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.post(
                "/internal/ports/share",
                headers=_internal_auth_headers(),
                json={"port": APP_PORT, "ttl": 3600},
            )
        assert resp.status_code == 200
        assert f"alice-{APP_PORT}.localhost/?sig=" in resp.json()["url"]

    def test_internal_mint_refuses_service_ports(self):
        with TestClient(_app(), base_url="http://localhost") as client:
            for port in sorted(reserved_service_ports()):
                if port < 1024:
                    continue
                resp = client.post(
                    "/internal/ports/share",
                    headers=_internal_auth_headers(),
                    json={"port": port, "ttl": 3600},
                )
                assert resp.status_code == 400, f"service port {port} was shareable"

    @respx.mock
    def test_redeem_sets_cookie_and_grants_that_port_only(self, resolve_owner):
        """Full visitor flow: link → redirect+cookie → app access, no owner auth."""
        respx.get(f"http://172.20.0.5:{APP_PORT}/").mock(
            return_value=httpx.Response(200, text="the shared app")
        )
        exp = int(time.time()) + 600
        sig = sign_share_port(APP_PORT, exp)

        with TestClient(_app(), base_url="http://localhost") as client:
            redeem = client.get(
                "/",
                params={"sig": sig, "exp": exp},
                headers={"host": f"alice-{APP_PORT}.localhost"},
                follow_redirects=False,
            )
            assert redeem.status_code == 303
            cookie = redeem.headers.get("set-cookie", "")
            assert PORT_SHARE_COOKIE in cookie
            assert "sig=" not in redeem.headers["location"], "sig must be scrubbed"

            visit = client.get(
                "/",
                headers={
                    "host": f"alice-{APP_PORT}.localhost",
                    "cookie": f"{PORT_SHARE_COOKIE}={port_share_cookie_value(APP_PORT, exp)}",
                },
            )
            assert visit.status_code == 200
            assert visit.text == "the shared app"

            other_port = client.get(
                "/",
                headers={
                    "host": "alice-4001.localhost",
                    "cookie": f"{PORT_SHARE_COOKIE}={port_share_cookie_value(APP_PORT, exp)}",
                },
            )
            assert other_port.status_code != 200, "cookie leaked onto another port"

    def test_bad_signature_does_not_redeem(self, resolve_owner):
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get(
                "/",
                params={"sig": "forged", "exp": int(time.time()) + 600},
                headers={"host": f"alice-{APP_PORT}.localhost"},
                follow_redirects=False,
            )
        assert resp.status_code != 303
        assert PORT_SHARE_COOKIE not in resp.headers.get("set-cookie", "")

    @respx.mock
    def test_hostile_sibling_origin_cannot_ride_share_cookie(self, resolve_owner):
        """A redeemed share cookie must NOT become is_public: a hostile same-site
        sibling app (alice-4999) presenting the cookie with its own Origin is a
        cross-origin attacker and must be refused, even though the cookie is
        valid for the target port."""
        upstream = respx.post(f"http://172.20.0.5:{APP_PORT}/api/transfer").mock(
            return_value=httpx.Response(200, text="done")
        )
        exp = int(time.time()) + 600
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.post(
                "/api/transfer",
                headers={
                    "host": f"alice-{APP_PORT}.localhost",
                    "Origin": "https://alice-4999.localhost",
                    "cookie": f"{PORT_SHARE_COOKIE}={port_share_cookie_value(APP_PORT, exp)}",
                },
            )
        assert resp.status_code in (401, 403), "hostile sibling rode the share cookie"
        assert not upstream.called, "hostile sibling request reached the backend"

    @respx.mock
    def test_share_cookie_same_origin_works(self, resolve_owner):
        """The shared app's OWN JS (same-origin) may call itself with the cookie."""
        respx.post(f"http://172.20.0.5:{APP_PORT}/api/act").mock(
            return_value=httpx.Response(200, text="ok")
        )
        exp = int(time.time()) + 600
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.post(
                "/api/act",
                headers={
                    "host": f"alice-{APP_PORT}.localhost",
                    "Origin": f"https://alice-{APP_PORT}.localhost",
                    "cookie": f"{PORT_SHARE_COOKIE}={port_share_cookie_value(APP_PORT, exp)}",
                },
            )
        assert resp.status_code == 200


class TestUpstreamCredentialHygiene:
    @respx.mock
    def test_no_platform_cookie_reaches_the_app(self, resolve_owner):
        """Every ShellTeam cookie constant must be stripped before the upstream
        app sees the request; the app's own cookies pass through. Asserted by
        naming each constant, not by iterating the scrub list (self-referential)."""
        captured = {}

        def _capture(request):
            captured["cookie"] = request.headers.get("cookie", "")
            return httpx.Response(200, text="ok")

        respx.get(f"http://172.20.0.5:{APP_PORT}/").mock(side_effect=_capture)
        port_service._public_ports["user-uuid-1234"] = {APP_PORT}
        exp = int(time.time()) + 600
        platform = {
            MASTER_COOKIE: "m",
            FILES_COOKIE: files_token(),
            PORT_SHARE_COOKIE: port_share_cookie_value(APP_PORT, exp),
            "shellteam_guest": "g",
        }
        cookie = "; ".join(f"{k}={v}" for k, v in platform.items()) + "; app_pref=dark"
        with TestClient(_app(), base_url="http://localhost") as client:
            client.get("/", headers={"host": f"alice-{APP_PORT}.localhost", "cookie": cookie})

        forwarded = captured.get("cookie", "")
        for name in (MASTER_COOKIE, FILES_COOKIE, PORT_SHARE_COOKIE, "shellteam_guest"):
            assert name not in forwarded, f"{name} leaked to the app"
        assert "app_pref=dark" in forwarded, "the app's own cookie was dropped"

    def test_non_ascii_signature_does_not_500(self, resolve_owner):
        """A malformed `?sig=é` must be a clean refusal, never a 500 from
        hmac.compare_digest raising on non-ASCII input."""
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get(
                "/",
                params={"sig": "é", "exp": int(time.time()) + 600},
                headers={"host": f"alice-{APP_PORT}.localhost"},
                follow_redirects=False,
            )
        assert resp.status_code != 500
        assert resp.status_code != 303  # a junk sig never redeems


def _make_request(host, method="GET", path="", cookies=None, origin=None, query=""):
    """Mock Request for direct proxy_subdomain calls (async streaming path)."""
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    request = MagicMock()
    headers = {"host": host}
    if origin:
        headers["origin"] = origin
    request.headers = headers
    request.method = method
    request.cookies = cookies or {}
    request.client = SimpleNamespace(host="203.0.113.9")  # not the upstream IP
    request.url = MagicMock()
    request.url.query = query
    request.url.scheme = "http"
    request.query_params = {}
    request.body = AsyncMock(return_value=b"")
    return request


def _app():
    from api.main import app

    return app

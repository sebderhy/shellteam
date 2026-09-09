"""Named app routes (docs/decisions/20260909-named-app-routes.md).

`<name>.<APP_DOMAIN>` resolves to a registered port and is then served through
EXACTLY the gate `<owner>-<port>.<APP_DOMAIN>` goes through. These tests pin:
name validation and reserved names, HTTP + WS resolution, auth parity with the
port host for every credential, origin sibling trust, on-demand TLS refusal
for unregistered names, and that the main-host sandbox CSP is untouched.
"""

from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from api.config import AI_CHAT_PORT_NUM, API_PORT, FILE_PORT
from api.routers.proxy import (
    AUTH_BAD_TOKEN,
    AUTH_FORBIDDEN,
    AUTH_NO_TOKEN,
    AUTH_OK,
    WS_METHOD,
    _authorize,
    _origin_is_owner_app_sibling,
    proxy_websocket,
    resolve_host,
)
from api.services import app_routes, ports as port_service
from api.services.auth import (
    FILES_COOKIE,
    MASTER_COOKIE,
    PORT_SHARE_COOKIE,
    files_token,
    port_share_cookie_value,
    sign_share_port,
)
from tests.test_proxy import _ws_scope

USER = "user-uuid-1234"
PORT = 3000
NAMED_HOST = "inkling.localhost"
PORT_HOST = f"alice-{PORT}.localhost"


def _app():
    from api.main import app

    return app


def _internal_headers(user_id=USER):
    from api.services.internal_auth import make_token

    return {"Authorization": f"Bearer {make_token(user_id)}", "X-Shellteam-User-Id": user_id}


def _wipe_state():
    """Memory AND disk: the app lifespan reseeds both registries from DATA_DIR
    on every TestClient start, so a persisted file would leak across tests."""
    from api.config import DATA_DIR

    app_routes._routes.pop(USER, None)
    port_service._public_ports.pop(USER, None)
    (DATA_DIR / USER / app_routes._FILENAME).unlink(missing_ok=True)
    (DATA_DIR / USER / port_service._FILENAME).unlink(missing_ok=True)


@pytest.fixture(autouse=True)
def _clean_state():
    _wipe_state()
    yield
    _wipe_state()


@pytest.fixture
def inkling():
    app_routes.set_route(USER, "inkling", PORT)
    yield


@pytest.fixture
def resolve_owner():
    with patch(
        "api.routers.proxy.resolve_username_owner",
        new_callable=AsyncMock,
        return_value=("172.20.0.5", USER),
    ):
        yield


# --- Registry ------------------------------------------------------------------


class TestNames:
    @pytest.mark.parametrize("name", ["ab", "inkling", "my-app", "a1-b2-c3", "x" * 32])
    def test_valid_names(self, name):
        assert app_routes.validate_name(name) == name

    @pytest.mark.parametrize(
        "name", ["a", "-ab", "ab-", "1app", "a_b", "a.b", "x" * 33, "", "a b"]
    )
    def test_invalid_shapes(self, name):
        with pytest.raises(ValueError):
            app_routes.validate_name(name)

    @pytest.mark.parametrize(
        "name",
        ["www", "api", "app", "mail", "admin", "static", "files", "public",
         "reports", "cockpit", "guest", "share", "alice"],
    )
    def test_reserved_labels(self, name):
        with pytest.raises(ValueError, match="reserved"):
            app_routes.validate_name(name)

    def test_port_shaped_names_refused(self):
        """`alice-3000` / `foo-80` would be parsed as a port preview, never reach
        the registry lookup, and silently serve the wrong thing."""
        for name in ("alice-3000", "foo-80", "my-app-1"):
            with pytest.raises(ValueError, match="port preview"):
                app_routes.validate_name(name)

    def test_normalises_case_and_space(self):
        assert app_routes.validate_name("  InkLing ") == "inkling"


class TestPorts:
    def test_service_ports_refused(self):
        for port in (FILE_PORT, API_PORT, AI_CHAT_PORT_NUM):
            with pytest.raises(ValueError):
                app_routes.validate_port(port)

    def test_low_and_out_of_range_refused(self):
        for port in (0, 80, 1023, 65536):
            with pytest.raises(ValueError):
                app_routes.validate_port(port)


class TestRegistry:
    def test_set_repoint_remove_and_persist(self):
        app_routes.set_route(USER, "inkling", 3000)
        assert app_routes.port_for_name(USER, "inkling") == 3000
        app_routes.set_route(USER, "inkling", 4000)
        assert app_routes.port_for_name(USER, "inkling") == 4000
        # Survives a restart: reload from disk.
        app_routes._routes.pop(USER)
        app_routes.seed_from_disk()
        assert app_routes.port_for_name(USER, "inkling") == 4000
        assert app_routes.remove_route(USER, "inkling") is True
        assert app_routes.remove_route(USER, "inkling") is False
        assert app_routes.port_for_name(USER, "inkling") is None

    def test_seed_drops_entries_that_fail_validation(self):
        """A stale file naming a service port must never route into that service."""
        from api.config import DATA_DIR

        path = DATA_DIR / USER / app_routes._FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'{{"good": 3000, "api": 3001, "evil": {API_PORT}}}')
        app_routes.seed_from_disk()
        assert app_routes.get_routes(USER) == {"good": 3000}
        assert '"evil"' not in path.read_text()

    def test_cap(self):
        for i in range(app_routes.MAX_APP_ROUTES):
            app_routes.set_route(USER, f"app{i}", 3000 + i)
        with pytest.raises(ValueError, match="Maximum"):
            app_routes.set_route(USER, "one-more", 5000)

    def test_describe_reports_port_visibility(self, inkling):
        assert app_routes.describe(USER) == [
            {"name": "inkling", "port": PORT, "url": "https://inkling.localhost", "public": False}
        ]
        port_service.set_port_visibility(USER, PORT, True)
        assert app_routes.describe(USER)[0]["public"] is True


# --- Host resolution ---------------------------------------------------------


class TestResolveHost:
    def test_named_host_resolves_to_owner_port(self, inkling):
        assert resolve_host(NAMED_HOST) == ("alice", PORT)

    def test_port_and_file_hosts_unchanged(self, inkling):
        assert resolve_host(PORT_HOST) == ("alice", PORT)
        assert resolve_host("alice.localhost") == ("alice", FILE_PORT)

    def test_unknown_label_keeps_legacy_meaning(self):
        assert resolve_host("inkling.localhost") == ("inkling", FILE_PORT)

    def test_non_subdomain_is_none(self):
        assert resolve_host("localhost") is None
        assert resolve_host("evil.com") is None


# --- HTTP through the proxy ----------------------------------------------------


class TestHttp:
    @respx.mock
    def test_named_host_serves_the_registered_port(self, inkling, resolve_owner):
        upstream = respx.get(f"http://172.20.0.5:{PORT}/").mock(
            return_value=httpx.Response(200, text="<h1>Inkling</h1>", headers={"content-type": "text/html"})
        )
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get(
                "/", headers={"host": NAMED_HOST}, cookies={MASTER_COOKIE: "fake-jwt-token"}
            )
        assert upstream.called
        assert resp.status_code == 200
        assert "Inkling" in resp.text
        # A named host is an app origin, not sandboxed main-host content.
        assert "sandbox" not in resp.headers.get("content-security-policy", "")

    @respx.mock
    def test_repointing_changes_what_is_served_not_the_url(self, inkling, resolve_owner):
        old = respx.get(f"http://172.20.0.5:{PORT}/").mock(return_value=httpx.Response(200, text="old"))
        new = respx.get("http://172.20.0.5:4000/").mock(return_value=httpx.Response(200, text="new"))
        app_routes.set_route(USER, "inkling", 4000)
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get("/", headers={"host": NAMED_HOST}, cookies={MASTER_COOKIE: "fake-jwt-token"})
        assert resp.text == "new" and new.called and not old.called

    def test_unknown_name_is_the_styled_404(self, resolve_owner):
        """Unregistered label = legacy username on the file port. resolve_username_owner
        answers for the single owner, so the label falls into the normal owner gate:
        logged out gets the login page, never the app and never a crash."""
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get("/", headers={"host": "nothere.localhost"})
        assert resp.status_code == 401

    def test_logged_out_gets_login_not_the_app(self, inkling, resolve_owner):
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get("/", headers={"host": NAMED_HOST})
        assert resp.status_code == 401

    @respx.mock
    def test_put_from_own_origin_with_only_the_files_cookie(self, inkling, resolve_owner):
        """The PWA's `PUT /sync` from its own origin, holding only the derived
        files credential (the master cookie never reaches a content host)."""
        upstream = respx.put(f"http://172.20.0.5:{PORT}/sync").mock(
            return_value=httpx.Response(200, json={"rev": 2})
        )
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.put(
                "/sync",
                headers={"host": NAMED_HOST, "origin": f"https://{NAMED_HOST}"},
                cookies={FILES_COOKIE: files_token()},
                json={"baseRev": 1, "state": {"todos": []}},
            )
        assert upstream.called
        assert resp.status_code == 200

    @respx.mock
    def test_share_link_minted_for_the_port_works_on_the_named_host(self, inkling, resolve_owner):
        import time

        exp = int(time.time()) + 600
        sig = sign_share_port(PORT, exp)
        upstream = respx.get(f"http://172.20.0.5:{PORT}/").mock(return_value=httpx.Response(200, text="app"))
        with TestClient(_app(), base_url="http://localhost") as client:
            redeem = client.get(
                f"/?sig={sig}&exp={exp}", headers={"host": NAMED_HOST}, follow_redirects=False
            )
            assert redeem.status_code == 303
            assert PORT_SHARE_COOKIE in redeem.cookies
            resp = client.get(
                "/", headers={"host": NAMED_HOST},
                cookies={PORT_SHARE_COOKIE: port_share_cookie_value(PORT, exp)},
            )
        assert upstream.called and resp.status_code == 200

    @respx.mock
    def test_public_port_makes_the_named_host_public(self, inkling, resolve_owner):
        upstream = respx.get(f"http://172.20.0.5:{PORT}/").mock(return_value=httpx.Response(200, text="app"))
        port_service.set_port_visibility(USER, PORT, True)
        with TestClient(_app(), base_url="http://localhost") as client:
            resp = client.get("/", headers={"host": NAMED_HOST})
        assert upstream.called and resp.status_code == 200


# --- Auth parity: the named host and the port host get the same AUTH_* result -----


class TestAuthParity:
    @staticmethod
    def _both(master=None, files=None, method="GET", origin=None, guest=None):
        return tuple(
            _authorize(master, files, USER, PORT, method, origin, host, guest_cred=guest)
            for host in (NAMED_HOST, PORT_HOST)
        )

    def test_master(self, inkling):
        assert self._both(master="fake-jwt-token") == (AUTH_OK, AUTH_OK)

    def test_no_credential(self, inkling):
        assert self._both() == (AUTH_NO_TOKEN, AUTH_NO_TOKEN)

    def test_bad_credential(self, inkling):
        assert self._both(files="garbage") == (AUTH_BAD_TOKEN, AUTH_BAD_TOKEN)

    def test_files_credential_read(self, inkling):
        assert self._both(files=files_token()) == (AUTH_OK, AUTH_OK)

    def test_files_credential_ws_from_own_origin_and_from_foreign(self, inkling):
        own = (
            _authorize(None, files_token(), USER, PORT, WS_METHOD, f"https://{NAMED_HOST}", NAMED_HOST),
            _authorize(None, files_token(), USER, PORT, WS_METHOD, f"https://{PORT_HOST}", PORT_HOST),
        )
        assert own == (AUTH_OK, AUTH_OK)
        assert self._both(files=files_token(), method=WS_METHOD, origin="https://evil.com") == (
            AUTH_FORBIDDEN, AUTH_FORBIDDEN,
        )



# --- Origin sibling trust ------------------------------------------------------


class TestSiblingTrust:
    def test_named_origin_is_an_app_sibling(self, inkling):
        # frontend on the name -> backend on another owner port, and back.
        assert _origin_is_owner_app_sibling(f"https://{NAMED_HOST}", 4000)
        assert _origin_is_owner_app_sibling("https://alice-4000.localhost", PORT)

    def test_named_origin_never_reaches_file_host_or_reserved(self, inkling):
        assert not _origin_is_owner_app_sibling(f"https://{NAMED_HOST}", FILE_PORT)
        assert not _origin_is_owner_app_sibling(f"https://{NAMED_HOST}", AI_CHAT_PORT_NUM)

    def test_unregistered_label_is_not_trusted(self):
        assert not _origin_is_owner_app_sibling("https://nothere.localhost", 4000)


# --- WebSocket -----------------------------------------------------------------


class TestWebSocket:
    @pytest.mark.asyncio
    async def test_named_host_ws_connects_to_the_registered_port(self, inkling, resolve_owner):
        connected = {}

        class _Upstream:
            subprotocol = None

            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        class _Ctx:
            async def __aenter__(self):
                return _Upstream()

            async def __aexit__(self, *a):
                return False

        def fake_connect(url, **kw):
            connected["url"] = url
            return _Ctx()

        messages = iter([{"type": "websocket.connect"}, {"type": "websocket.disconnect"}])

        async def receive():
            return next(messages)

        sent = []

        async def send(msg):
            sent.append(msg)

        scope = _ws_scope(
            NAMED_HOST, path="/ws", cookies={FILES_COOKIE: files_token()}, origin=f"https://{NAMED_HOST}"
        )
        with patch("api.routers.proxy.websockets.connect", side_effect=fake_connect):
            await proxy_websocket(scope, receive, send)
        assert connected["url"] == f"ws://172.20.0.5:{PORT}/ws"
        assert any(m.get("type") == "websocket.accept" for m in sent)

    @pytest.mark.asyncio
    async def test_named_host_ws_without_credential_closes_1008(self, inkling, resolve_owner):
        sent = []

        async def receive():
            return {"type": "websocket.connect"}

        async def send(msg):
            sent.append(msg)

        await proxy_websocket(_ws_scope(NAMED_HOST, path="/ws"), receive, send)
        close = next(m for m in sent if m.get("type") == "websocket.close")
        assert close["code"] == 1008


# --- On-demand TLS ---------------------------------------------------------------


class TestOnDemandTls:
    @staticmethod
    def _client():
        return TestClient(_app(), client=("127.0.0.1", 51000))

    def test_registered_name_allowed(self, inkling):
        with self._client() as client:
            assert client.get("/internal/check-domain", params={"domain": NAMED_HOST}).status_code == 200

    def test_unregistered_name_refused(self):
        with self._client() as client:
            assert client.get("/internal/check-domain", params={"domain": NAMED_HOST}).status_code == 403
            assert client.get("/internal/check-domain", params={"domain": "inkling.evil.com"}).status_code == 403

    def test_removed_name_refused_again(self, inkling):
        app_routes.remove_route(USER, "inkling")
        with self._client() as client:
            assert client.get("/internal/check-domain", params={"domain": NAMED_HOST}).status_code == 403


# --- APIs ------------------------------------------------------------------------


class TestInternalApi:
    def test_create_list_share_remove(self):
        with TestClient(_app()) as client:
            h = _internal_headers()
            r = client.post("/internal/apps", headers=h, json={"name": "inkling", "port": PORT})
            assert r.status_code == 200
            assert r.json()["apps"] == [
                {"name": "inkling", "port": PORT, "url": "https://inkling.localhost", "public": False}
            ]
            assert client.get("/internal/apps", headers=h).json()["apps"][0]["name"] == "inkling"
            share = client.post("/internal/ports/share", headers=h, json={"name": "inkling", "ttl": 600})
            assert share.status_code == 200
            assert share.json()["url"].startswith("https://inkling.localhost/?sig=")
            assert client.delete("/internal/apps/inkling", headers=h).status_code == 200
            assert client.delete("/internal/apps/inkling", headers=h).status_code == 404
            assert client.post("/internal/ports/share", headers=h, json={"name": "inkling"}).status_code == 404

    def test_rejects_reserved_name_and_service_port(self):
        with TestClient(_app()) as client:
            h = _internal_headers()
            assert client.post("/internal/apps", headers=h, json={"name": "api", "port": PORT}).status_code == 400
            assert client.post("/internal/apps", headers=h, json={"name": "ok", "port": API_PORT}).status_code == 400
            assert client.post("/internal/apps", headers=h, json={"name": "ok", "port": FILE_PORT}).status_code == 400

    def test_requires_internal_auth(self):
        with TestClient(_app()) as client:
            assert client.post("/internal/apps", json={"name": "x1", "port": PORT}).status_code == 400
            assert client.get("/internal/apps", headers={"X-Shellteam-User-Id": USER}).status_code == 401


class TestOwnerApi:
    def test_crud_with_owner_cookie(self):
        with TestClient(_app()) as client:
            client.cookies.set(MASTER_COOKIE, "fake-jwt-token")
            r = client.post("/api/computers/apps", json={"name": "inkling", "port": PORT})
            assert r.status_code == 200 and r.json()["apps"][0]["port"] == PORT
            assert client.get("/api/computers/apps").json()["apps"][0]["name"] == "inkling"
            assert client.delete("/api/computers/apps/inkling").status_code == 200
            assert client.get("/api/computers/apps").json()["apps"] == []

    def test_mutations_refuse_foreign_origin(self):
        with TestClient(_app()) as client:
            client.cookies.set(MASTER_COOKIE, "fake-jwt-token")
            r = client.post(
                "/api/computers/apps", json={"name": "inkling", "port": PORT},
                headers={"origin": "https://evil.com"},
            )
            assert r.status_code == 403
            assert app_routes.port_for_name(USER, "inkling") is None


# --- The main host is untouched ------------------------------------------------


class TestMainHostUntouched:
    def test_no_path_routing_and_sandbox_csp_intact(self, inkling):
        """`/inkling/` on the dashboard host is still an owner FILE path served
        with the sandbox CSP, never the app."""
        from api.main import CONTENT_SANDBOX_CSP, _wants_content_sandbox
        from tests.test_content_sandbox import _req, _resp

        assert _wants_content_sandbox(_req("/inkling/index.html"), _resp()) is True
        assert "sandbox" in CONTENT_SANDBOX_CSP
        assert resolve_host("localhost") is None


# --- Dashboard form contract --------------------------------------------------


class TestDashboardCard:
    def test_pattern_attributes_are_valid_under_the_v_flag(self):
        """Browsers compile HTML `pattern` with the RegExp `v` flag, where an
        unescaped hyphen at the end of a character class is a SyntaxError that
        throws from requestSubmit() and silently kills the form. Found live on
        the App names card; pin it for every pattern in the dashboard."""
        import re
        from pathlib import Path

        html = Path(__file__).resolve().parents[1].joinpath("frontend/dashboard.html").read_text()
        patterns = re.findall(r'pattern="([^"]*)"', html)
        assert patterns, "expected at least the App names pattern"
        for pat in patterns:
            re.compile(pat)
            assert not re.search(r"\[[^\]]*[^\\]-\]", pat), f"unescaped class hyphen in pattern {pat!r}"
        name_pat = next(p for p in patterns if "{0,30}" in p)
        assert re.fullmatch(name_pat, "my-app") and not re.fullmatch(name_pat, "-app")

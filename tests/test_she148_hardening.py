"""SHE-148: smaller hardening from the security audit."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from api.routers.proxy import proxy_subdomain
from api.services import internal_auth


@pytest.mark.asyncio
async def test_a_bare_options_without_credentials_never_reaches_an_app():
    # Only a real CORS preflight skips auth; a bare OPTIONS returned any local
    # service's body to a stranger.
    r = MagicMock()
    r.headers = {"host": "alice-3000.localhost"}
    r.cookies = {}
    r.method = "OPTIONS"
    r.url = MagicMock(query="")
    r.query_params = {}
    r.body = AsyncMock(return_value=b"")
    r.client = SimpleNamespace(host="203.0.113.9")
    with patch("api.routers.proxy.resolve_username_owner", new_callable=AsyncMock,
               return_value=("127.0.0.1", "owner-1")):
        resp = await proxy_subdomain(r, "admin")
    assert resp.status_code == 401


def test_non_ascii_internal_token_is_a_refusal_not_a_crash():
    assert internal_auth.verify_token("tök€n", "owner") is False
    assert internal_auth.verify_notify_token("tök€n") is False


def test_install_warns_on_docker_older_than_28():
    from pathlib import Path

    src = (Path(__file__).resolve().parent.parent / "install.sh").read_text()
    assert "check_docker_isolation_version" in src.split("ensure_browser_network() {", 1)[1][:400]


def test_install_firewalls_the_agent_browser_from_the_host():
    # SHE-148: a page in the agent browser reached host services on 0.0.0.0
    # (the gateway answered on :8000) and the cloud metadata service.
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    src = (root / "install.sh").read_text()
    body = src.split("ensure_browser_firewall() {", 1)[1].split("\n}\n", 1)[0]
    assert "--dports 80,443 -j RETURN" in body and "-j DROP" in body
    assert "169.254.169.254" in body
    # Root never runs a script from the user-writable checkout.
    assert "$REPO" not in body
    start = src.split("if ! ensure_browser_network; then", 1)[1]
    assert start.index("ensure_browser_firewall") < start.index("dk run -d")
    assert "shellteam-browser-firewall.service" in (root / "uninstall.sh").read_text()


@pytest.mark.asyncio
async def test_a_faked_preflight_gets_the_cors_answer_and_nothing_else():
    # SHE-159: the header that marks a preflight is the client's to set, so a
    # stranger's "preflight" carried a path, headers and a body to any loopback
    # port and read the whole response back.
    r = MagicMock()
    r.headers = {
        "host": "alice-6379.localhost",
        "origin": "https://evil.example",
        "access-control-request-method": "POST",
        "x-admin": "1",
        "content-type": "text/plain",
    }
    r.cookies = {}
    r.method = "OPTIONS"
    r.url = MagicMock(query="cmd=FLUSHALL")
    r.query_params = {}
    r.body = AsyncMock(return_value=b"FLUSHALL\r\n")
    r.client = SimpleNamespace(host="203.0.113.9")

    upstream = MagicMock(status_code=200, content=b"internal admin page")
    upstream.headers = {
        "access-control-allow-origin": "*", "set-cookie": "sid=1", "x-secret": "1",
    }
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.request = AsyncMock(return_value=upstream)
    with patch("api.routers.proxy.resolve_username_owner", new_callable=AsyncMock,
               return_value=("127.0.0.1", "owner-1")), \
         patch("api.routers.proxy.httpx.AsyncClient", return_value=client):
        resp = await proxy_subdomain(r, "admin")

    method, url = client.request.call_args.args
    sent = client.request.call_args.kwargs
    assert method == "OPTIONS" and url == "http://127.0.0.1:6379/admin"  # no query string
    assert set(sent["headers"]) == {"origin", "access-control-request-method"}
    assert "content" not in sent and "data" not in sent  # no body
    assert resp.status_code == 200 and resp.body == b""
    assert resp.headers.get("access-control-allow-origin") == "*"
    assert "set-cookie" not in resp.headers and "x-secret" not in resp.headers

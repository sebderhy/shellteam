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

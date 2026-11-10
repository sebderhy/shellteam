"""SHE-144: a file in the owner's home must never run as the dashboard, and
published folders must never serve dotfiles or a symlink's secret target."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import respx

from api.main import CONTENT_SANDBOX_CSP
from api.routers import proxy
from api.routers.proxy import proxy_subdomain


def _request(host, path_cookies=None):
    r = MagicMock()
    r.headers = {"host": host}
    r.cookies = path_cookies or {}
    r.method = "GET"
    r.url = MagicMock(query="")
    r.query_params = {}
    r.body = AsyncMock(return_value=b"")
    r.client = SimpleNamespace(host="203.0.113.9")
    return r


def _as_owner():
    return (
        patch("api.routers.proxy.resolve_username_owner", new_callable=AsyncMock,
              return_value=("172.20.0.5", "owner-1")),
        patch("api.routers.proxy.verify_token", return_value={"sub": "owner-1"}),
    )


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "reports" / "bundle").mkdir(parents=True)
    (h / ".ssh").mkdir()
    (h / ".ssh" / "id").write_text("PRIVATE")
    (tmp_path / "outside.txt").write_text("OUTSIDE")
    monkeypatch.setenv("HOME", str(h))
    return h


def test_symlink_to_a_dotfile_or_outside_home_is_refused(home):
    (home / "reports" / "bundle" / "key.txt").symlink_to("../../.ssh/id")
    (home / "reports" / "bundle" / "out.txt").symlink_to(home.parent / "outside.txt")
    (home / "reports" / "bundle" / "ok.txt").write_text("fine")
    (home / "reports" / "bundle" / "alias.txt").symlink_to("ok.txt")
    assert proxy._escapes_home("reports/bundle/key.txt")
    assert proxy._escapes_home("_files/reports/bundle/key.txt")
    assert proxy._escapes_home("reports/bundle/out.txt")
    assert not proxy._escapes_home("reports/bundle/ok.txt")
    assert not proxy._escapes_home("reports/bundle/alias.txt")  # inside home: fine
    assert not proxy._escapes_home("reports/missing.txt")


@pytest.mark.asyncio
async def test_file_subdomain_refuses_dotfiles_and_the_cockpit_file_api(home):
    a, b = _as_owner()
    with a, b:
        for path in ("public/site/.env", "public/site/.git/config", "_api/zip"):
            resp = await proxy_subdomain(_request("alice.localhost", {"shellteam_token": "v"}), path)
            assert resp.status_code == 404, path


@pytest.mark.asyncio
@respx.mock
async def test_file_subdomain_html_and_svg_are_sandboxed(home):
    respx.get("http://172.20.0.5:80/tmp/evil.html").mock(
        return_value=httpx.Response(200, text="<script>x</script>", headers={"content-type": "text/html"}))
    respx.get("http://172.20.0.5:80/tmp/evil.svg").mock(
        return_value=httpx.Response(200, text="<svg/>", headers={"content-type": "image/svg+xml"}))
    respx.get("http://172.20.0.5:80/tmp/chart.png").mock(
        return_value=httpx.Response(200, content=b"png", headers={"content-type": "image/png"}))
    a, b = _as_owner()
    with a, b:
        for path in ("tmp/evil.html", "tmp/evil.svg"):
            resp = await proxy_subdomain(_request("alice.localhost", {"shellteam_token": "v"}), path)
            assert resp.headers.get("content-security-policy") == CONTENT_SANDBOX_CSP, path
        png = await proxy_subdomain(_request("alice.localhost", {"shellteam_token": "v"}), "tmp/chart.png")
        assert "content-security-policy" not in png.headers


def test_main_host_files_alias_html_is_sandboxed(client, auth_header):
    # /_files/x.html served an owner file with the dashboard's real origin.
    with respx.mock(assert_all_called=False) as mock:
        mock.get(url__regex=r"http://127\.0\.0\.1(:\d+)?/_files/tmp/evil\.html").mock(
            return_value=httpx.Response(200, text="<script>x</script>", headers={"content-type": "text/html"}))
        resp = client.get("/_files/tmp/evil.html", headers=auth_header)
    assert resp.status_code == 200
    assert resp.headers.get("content-security-policy") == CONTENT_SANDBOX_CSP


# ── SHE-160 ──────────────────────────────────────────────────────────────────


def test_files_credential_cannot_use_the_cockpit_file_api(client, auth_header):
    # GET /_api/zip?path=/ with only the read-only files cookie downloaded the
    # whole home, dotfiles and OWNER_TOKEN included.
    from tests._owner_session import files_token

    with respx.mock(assert_all_called=False) as mock:
        route = mock.get(url__regex=r"http://127\.0\.0\.1(:\d+)?/_api/zip.*").mock(
            return_value=httpx.Response(200, content=b"PK"))
        client.cookies.set("shellteam_files", files_token())
        refused = client.get("/_api/zip?path=/")
        client.cookies.clear()
        assert refused.status_code == 401 and not route.called
        assert client.get("/_api/zip?path=/", headers=auth_header).status_code == 200


def test_symlinked_index_and_percent_names_are_refused(home):
    (home / "reports" / "site").mkdir()
    (home / "reports" / "site" / "index.html").symlink_to("../../.ssh/id")
    assert proxy._escapes_home("reports/site")
    assert proxy._escapes_home("reports/site/")
    # A link whose NAME holds a literal %XX: the path arrives decoded once.
    (home / "reports" / "bundle" / "a%2Eb.txt").symlink_to("../../.ssh/id")
    assert proxy._escapes_home("reports/bundle/a%2Eb.txt")
    (home / "reports" / "plain").mkdir()
    (home / "reports" / "plain" / "index.html").write_text("ok")
    assert not proxy._escapes_home("reports/plain")

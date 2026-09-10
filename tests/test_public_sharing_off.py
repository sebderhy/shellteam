"""PUBLIC_SHARING=off: a box that can never make anything world-readable.

Built for the live demo (a stranger drives the box for 30 minutes): a visitor
must not be able to host a page on the operator's domain, whether through a
public port, a signed share link or a published report. Both sides are pinned:
every write endpoint refuses, and the READ side treats nothing as public even
if a published set is on disk (a golden image, an old public_ports.json).
"""

from __future__ import annotations

import time

import pytest

from api import config
from api.services import ports as port_service, reports as report_service
from api.services.auth import (
    MASTER_COOKIE,
    port_share_cookie_value,
    sign_share_path,
    sign_share_port,
    verify_port_share_cookie,
    verify_share_port_sig,
    verify_share_sig,
)
from api.services.internal_auth import make_token

USER = "user-uuid-1234"


def _internal_headers(user_id=USER):
    return {"Authorization": f"Bearer {make_token(user_id)}", "X-Shellteam-User-Id": user_id}


@pytest.fixture
def sharing_off(monkeypatch):
    monkeypatch.setattr(config, "PUBLIC_SHARING", False)


@pytest.fixture
def owner(client):
    """The owner's browser: master cookie + dashboard origin."""
    client.cookies.set(MASTER_COOKIE, "fake-jwt-token")
    client.headers.update({"Origin": "http://localhost", "Referer": "http://localhost/"})
    return client


@pytest.fixture(autouse=True)
def _clean_registries():
    port_service._public_ports.pop(USER, None)
    report_service._public_reports.pop(USER, None)
    yield
    port_service._public_ports.pop(USER, None)
    report_service._public_reports.pop(USER, None)


class TestWriteSide:
    def test_owner_cannot_make_a_port_public_but_can_make_it_private(self, owner, sharing_off):
        assert owner.post("/api/computers/ports", json={"port": 3000, "public": True}).status_code == 403
        assert owner.post("/api/computers/ports", json={"port": 3000, "public": False}).status_code == 200

    def test_agent_cannot_make_a_port_public_or_mint_a_port_link(self, client, sharing_off):
        h = _internal_headers()
        r = client.post("/internal/ports", json={"port": 3000, "public": True}, headers=h)
        assert r.status_code == 403 and "PUBLIC_SHARING=off" in r.json()["detail"]
        assert client.post("/internal/ports", json={"port": 3000, "public": False}, headers=h).status_code == 200
        assert client.post("/internal/ports/share", json={"port": 3000}, headers=h).status_code == 403

    def test_no_share_links_for_files_or_apps(self, owner, sharing_off):
        assert owner.get("/api/auth/share", params={"path": "reports/x.html"}).status_code == 403
        assert owner.get("/api/auth/share", params={"port": 3000}).status_code == 403

    def test_no_report_publishing_from_either_side(self, owner, sharing_off, tmp_path, monkeypatch):
        client = owner
        home = tmp_path / "home"
        (home / "reports").mkdir(parents=True)
        (home / "reports" / "r.html").write_text("<p>hi</p>")
        monkeypatch.setattr("api.services.runtime.user_home_dir", lambda user_id: home)
        h = _internal_headers()
        r = client.post("/internal/reports", json={"path": "reports/r.html", "public": True}, headers=h)
        assert r.status_code == 403
        assert client.post("/internal/reports", json={"path": "reports/r.html", "public": False}, headers=h).status_code == 200
        r = client.post("/api/computers/reports", json={"path": "reports/r.html", "public": True})
        assert r.status_code == 403


class TestReadSide:
    def test_a_port_published_on_disk_is_served_as_private(self, monkeypatch):
        port_service.set_port_visibility(USER, 3000, True)
        assert port_service.is_port_public(USER, 3000)
        monkeypatch.setattr(config, "PUBLIC_SHARING", False)
        assert not port_service.is_port_public(USER, 3000)

    def test_a_report_published_on_disk_is_served_as_private(self, monkeypatch):
        report_service.set_report_visibility(USER, "reports/r.html", True)
        assert report_service.is_report_public(USER, "reports/r.html")
        monkeypatch.setattr(config, "PUBLIC_SHARING", False)
        assert not report_service.is_report_public(USER, "reports/r.html")
        assert report_service.get_public_reports(USER) == set()

    def test_live_signatures_stop_verifying(self, monkeypatch):
        exp = int(time.time()) + 600
        path_sig = sign_share_path("reports/r.html", exp)
        port_sig = sign_share_port(3000, exp)
        cookie = port_share_cookie_value(3000, exp)
        assert verify_share_sig("reports/r.html", path_sig, str(exp))
        assert verify_share_port_sig(3000, port_sig, str(exp))
        assert verify_port_share_cookie(cookie, 3000)
        monkeypatch.setattr(config, "PUBLIC_SHARING", False)
        assert not verify_share_sig("reports/r.html", path_sig, str(exp))
        assert not verify_share_port_sig(3000, port_sig, str(exp))
        assert not verify_port_share_cookie(cookie, 3000)


def test_default_is_on():
    assert config.PUBLIC_SHARING is True

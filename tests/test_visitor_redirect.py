"""VISITOR_REDIRECT_URL: a browser with no session opening a dashboard shell is
sent to the operator's page instead of the OWNER_TOKEN prompt.

Contract:
- knob unset (default): the shells render for anyone, the client-side overlay
  asks for the token (unchanged behaviour, pinned by the CSP tests too);
- knob set: no credential -> 302 to the URL, on every HTML shell;
- knob set: the owner's session cookie or a Bearer token -> the shell renders;
- knob set: the one-time ``/?token=`` redemption still runs FIRST, so the link
  install.sh prints keeps signing the owner in;
- localhost-trust (OWNER_TOKEN empty): nobody is a visitor, the knob is inert;
- a non-https value is refused at load time (the prompt stays).
"""

import importlib

import pytest

from api import config
from api.services.auth import MASTER_COOKIE

LANDING = "https://landing.example"
LOCAL = {"host": "localhost"}
SHELLS = ["/", "/terminal", "/browser", "/reports", "/apps"]


@pytest.fixture
def landing(monkeypatch):
    monkeypatch.setattr(config, "VISITOR_REDIRECT_URL", LANDING)


class TestKnobUnset:
    @pytest.mark.parametrize("path", SHELLS)
    def test_shells_render_for_anyone(self, client, path):
        resp = client.get(path, headers=LOCAL, follow_redirects=False)
        assert resp.status_code == 200
        assert "location" not in resp.headers


class TestKnobSet:
    @pytest.mark.parametrize("path", SHELLS)
    def test_no_session_is_sent_to_the_landing(self, client, landing, path):
        resp = client.get(path, headers=LOCAL, follow_redirects=False)
        assert resp.status_code == 302
        assert resp.headers["location"] == LANDING
        assert resp.headers["cache-control"] == "no-store"

    def test_owner_cookie_renders_the_dashboard(self, client, landing):
        resp = client.get(
            "/", headers=LOCAL, cookies={MASTER_COOKIE: "fake-jwt-token"}, follow_redirects=False
        )
        assert resp.status_code == 200
        assert "Shell" in resp.text

    def test_bearer_renders_the_dashboard(self, client, landing):
        resp = client.get(
            "/", headers={**LOCAL, "Authorization": "Bearer fake-jwt-token"}, follow_redirects=False
        )
        assert resp.status_code == 200

    def test_wrong_cookie_is_a_visitor(self, client, landing):
        resp = client.get(
            "/", headers=LOCAL, cookies={MASTER_COOKIE: "not-the-token"}, follow_redirects=False
        )
        assert resp.status_code == 302
        assert resp.headers["location"] == LANDING

    def test_token_link_is_redeemed_before_the_gate(self, client, landing):
        """The install banner's `/?token=` URL must still sign the owner in."""
        resp = client.get("/?token=fake-jwt-token", headers=LOCAL, follow_redirects=False)
        assert resp.status_code == 303
        assert resp.headers["location"] == "/"
        assert MASTER_COOKIE in resp.headers.get("set-cookie", "")
        # ...and the cookie it set then opens the dashboard, not the landing.
        follow = client.get("/", headers=LOCAL, follow_redirects=False)
        assert follow.status_code == 200

    def test_bad_token_link_ends_on_the_landing(self, client, landing):
        resp = client.get("/?token=nope", headers=LOCAL, follow_redirects=False)
        assert resp.status_code == 303 and resp.headers["location"] == "/"
        assert "set-cookie" not in resp.headers
        follow = client.get("/", headers=LOCAL, follow_redirects=False)
        assert follow.status_code == 302 and follow.headers["location"] == LANDING

    def test_localhost_trust_ignores_the_knob(self, client, landing, monkeypatch):
        import api.main as main
        import api.services.auth as auth

        monkeypatch.setattr(main, "OWNER_TOKEN", "")
        monkeypatch.setattr(auth, "OWNER_TOKEN", "")
        resp = client.get("/", headers=LOCAL, follow_redirects=False)
        assert resp.status_code == 200


class TestConfigValidation:
    def test_non_https_value_is_refused(self, monkeypatch, caplog):
        monkeypatch.setenv("VISITOR_REDIRECT_URL", "http://landing.example")
        with caplog.at_level("ERROR", logger="api.config"):
            importlib.reload(config)
        try:
            assert config.VISITOR_REDIRECT_URL == ""
            assert "must start with https://" in caplog.text
        finally:
            monkeypatch.delenv("VISITOR_REDIRECT_URL")
            importlib.reload(config)

    def test_https_value_is_kept(self, monkeypatch):
        monkeypatch.setenv("VISITOR_REDIRECT_URL", " https://landing.example ")
        importlib.reload(config)
        try:
            assert config.VISITOR_REDIRECT_URL == "https://landing.example"
        finally:
            monkeypatch.delenv("VISITOR_REDIRECT_URL")
            importlib.reload(config)

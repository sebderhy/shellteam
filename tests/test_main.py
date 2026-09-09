"""Tests for main app — host routing, middleware, and health check."""

import os


import pytest
from unittest.mock import patch, AsyncMock

from api.main import is_main_host, MAIN_HOSTS


class TestIsMainHost:
    def _make_request(self, host: str):
        from unittest.mock import MagicMock

        req = MagicMock()
        req.headers = {"host": host}
        return req

    def test_main_domain(self):
        assert is_main_host(self._make_request("localhost")) is True

    def test_localhost(self):
        assert is_main_host(self._make_request("localhost")) is True

    def test_localhost_with_port(self):
        assert is_main_host(self._make_request("localhost:9000")) is True

    def test_ip_address(self):
        """VPS_IP from env should be recognized as main host."""
        with patch.dict(os.environ, {"VPS_IP": "203.0.113.10"}):
            # Re-import to pick up the new env var
            from api.main import MAIN_HOSTS as mh
            with patch("api.main.MAIN_HOSTS", mh | {"203.0.113.10"}):
                assert is_main_host(self._make_request("203.0.113.10")) is True

    def test_subdomain_is_not_main(self):
        assert is_main_host(self._make_request("alice.localhost")) is False

    def test_unknown_host(self):
        assert is_main_host(self._make_request("example.com")) is False

    def test_empty_host(self):
        from unittest.mock import MagicMock

        req = MagicMock()
        req.headers = {}
        assert is_main_host(req) is False


class TestHealthEndpoint:
    def test_health(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestCockpitRoutes:
    def test_root_serves_dashboard(self, client):
        resp = client.get("/", headers={"host": "localhost"})
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")
        body = resp.text
        # Tab shell: Agents, Terminal, Files, Browser, Knowledge, Settings.
        for tab in ("agents", "terminal", "files", "browser", "knowledge", "apps", "settings"):
            assert f'data-tab="{tab}"' in body
        # Dropped Cloud tabs must NOT reappear in OSS.
        assert "Chief of Staff" not in body
        # The Knowledge tab ships hidden and is revealed client-side only when
        # the dreaming module answers (its API 404s otherwise).
        assert 'id="knowledge-tab" style="display:none"' in body
        # Same for the Browser tab: hidden unless the browser module is
        # installed — the server injects the flag, no placeholder ships raw.
        assert 'id="browser-tab" style="display:none"' in body
        assert "__HAS_BROWSER__" not in body

    def test_browser_flag_reflects_modules(self, client, monkeypatch):
        import api.config as config

        monkeypatch.setattr(config, "MODULES", frozenset({"browser"}))
        assert '"true" === "true"' in client.get("/", headers={"host": "localhost"}).text
        monkeypatch.setattr(config, "MODULES", frozenset())
        body = client.get("/", headers={"host": "localhost"}).text
        assert '"false" === "true"' in body

    def test_root_injects_owner_and_cockpit(self, client):
        resp = client.get("/", headers={"host": "localhost"})
        body = resp.text
        # Placeholders must be replaced server-side, not shipped raw.
        assert "__OWNER_USERNAME__" not in body
        assert "__COCKPIT_URL__" not in body
        # Localhost cockpit URL is the sibling ai-chat port.
        assert ":3456" in body

    def test_terminal_page(self, client):
        resp = client.get("/terminal", headers={"host": "localhost"})
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")

    def test_browser_page(self, client):
        resp = client.get("/browser", headers={"host": "localhost"})
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")
        # Owner placeholder must be injected for the screencast viewer.
        assert "__OWNER_USERNAME__" not in resp.text
        assert "__HAS_BROWSER__" not in resp.text

    def test_apps_page(self, client):
        # The Apps tab shell: served like the other first-party shells, with
        # the dashboard CSP (not the content sandbox, which would strip the
        # owner cookie from its /api/integrations fetches).
        resp = client.get("/apps", headers={"host": "localhost"})
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")
        assert "__ASSET_VERSION__" not in resp.text
        assert 'id="apps-grid"' in resp.text
        # The consent note: connecting an app widens what agents read and act on.
        assert 'id="apps-note"' in resp.text
        assert "becomes text they may act on" in resp.text
        csp = resp.headers.get("content-security-policy", "")
        assert "sandbox" not in csp

    def test_github_card_lives_in_the_apps_tab_not_settings(self, client):
        # One github.html frame in the dashboard (the wizard's step 3); the
        # Settings panel no longer carries it, the Apps page frames its own.
        body = client.get("/", headers={"host": "localhost"}).text
        assert body.count('id="github-connect-root"') == 1
        assert 'id="apps-iframe"' in body
        apps = client.get("/apps", headers={"host": "localhost"}).text
        assert 'id="github-connect-root"' in apps
        # Both shells mount the card through the one shared script.
        assert "/static/github-frame.js" in apps
        assert "/static/github-frame.js" in body

    def test_favicon(self, client):
        resp = client.get("/static/favicon.svg")
        assert resp.status_code == 200
        assert "svg" in resp.headers.get("content-type", "")


class TestFirstRunWizard:
    """The dashboard ships the first-run wizard: risk-accept step + a step 2
    that reuses the Settings provider panel (one renderer, no duplicate UI)."""

    def test_wizard_markup_present(self, client):
        body = client.get("/", headers={"host": "localhost"}).text
        assert 'id="wizard"' in body
        assert 'id="wizard-step-1"' in body and 'id="wizard-step-2"' in body
        # The accept gate is required — the primary button starts disabled.
        assert 'id="wizard-accept"' in body
        assert "I understand and accept these risks" in body
        assert '"as is"' in body

    def test_wizard_reuses_settings_provider_panel(self, client):
        body = client.get("/", headers={"host": "localhost"}).text
        # Step 2 has only a slot the Settings panel node is moved into — the
        # provider UI must NOT be rendered twice.
        assert 'id="wizard-ai-slot"' in body
        assert body.count('id="ai-panel-root"') == 1

    def test_wizard_is_skippable_after_accept(self, client):
        body = client.get("/", headers={"host": "localhost"}).text
        assert 'id="wizard-skip"' in body


class TestSubdomainMiddleware:
    """Test that subdomain requests are intercepted by middleware."""

    def test_subdomain_static_path_proxied(self, client):
        """Static paths on subdomains should NOT hit our static mount."""
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=(None, None),
        ):
            resp = client.get(
                "/public/assets/foo.css",
                headers={"host": "alice.localhost"},
            )
        # 503 = container offline (proxied correctly, not our 404)
        assert resp.status_code == 503

    def test_subdomain_root_proxied(self, client):
        with patch(
            "api.routers.proxy.resolve_username_owner",
            new_callable=AsyncMock,
            return_value=(None, None),
        ):
            resp = client.get(
                "/public/",
                headers={"host": "alice.localhost"},
            )
        assert resp.status_code == 503

    def test_main_host_static_serves_files(self, client):
        """Static paths on main host should serve our frontend files."""
        resp = client.get(
            "/static/favicon.svg",
            headers={"host": "localhost"},
        )
        assert resp.status_code == 200


class TestCspScope:
    """The dashboard CSP must only land on the app's own HTML shells.

    Regression for SHE-41: the CSP was stamped on every main-host response,
    including /_editor pages proxied from the nginx file server — whose Monaco
    editor loads from cdn.jsdelivr.net. The blocked script left every editor
    deep link on the empty 'Select a file to edit' state.
    """

    def test_editor_page_proxied_without_dashboard_csp(self, client):
        import httpx
        import respx

        with respx.mock:
            respx.get("http://127.0.0.1:80/_editor/notes.md").mock(
                return_value=httpx.Response(
                    200, text="<html>editor</html>", headers={"content-type": "text/html"}
                )
            )
            resp = client.get(
                "/_editor/notes.md",
                headers={"host": "localhost", "Authorization": "Bearer fake-jwt-token"},
            )
        assert resp.status_code == 200
        assert resp.headers.get("content-security-policy") is None

    def test_dashboard_still_gets_csp(self, client):
        resp = client.get("/", headers={"host": "localhost"})
        assert resp.status_code == 200
        assert "script-src" in resp.headers.get("content-security-policy", "")


class TestTrialBanner:
    """api/config.py TRIAL_FILE: a countdown + link the dashboard shows on a
    time-boxed box (the shellteam.sh live demo). Absent file = no banner and
    no raw placeholder; a malformed file is ignored loudly, never rendered."""

    def test_no_file_renders_null(self, client, monkeypatch, tmp_path):
        import api.config as config
        monkeypatch.setattr(config, "TRIAL_FILE", tmp_path / "trial.json")
        body = client.get("/", headers={"host": "localhost"}).text
        assert '<script type="application/json" id="trial-config">null</script>' in body
        assert "__TRIAL_JSON__" not in body

    def test_file_is_injected_typed_and_escaped(self, client, monkeypatch, tmp_path):
        import json
        import api.config as config
        f = tmp_path / "trial.json"
        f.write_text(json.dumps({"ends_at": "1900000000", "label": "Trial seat</script><b>",
                                 "cta_url": "https://shellteam.sh/reserve.html?utm_source=try",
                                 "cta_label": "Keep what you build", "extra": "dropped"}))
        monkeypatch.setattr(config, "TRIAL_FILE", f)
        body = client.get("/", headers={"host": "localhost"}).text
        start = body.index('id="trial-config">') + len('id="trial-config">')
        blob = body[start: body.index("</script>", start)]
        cfg = json.loads(blob)
        assert cfg == {"ends_at": 1900000000, "label": "Trial seat</script><b>",
                       "cta_url": "https://shellteam.sh/reserve.html?utm_source=try",
                       "cta_label": "Keep what you build"}
        assert "</script><b>" not in blob          # escaped as <\/script>, cannot close the block
        assert 'id="trial-bar"' in body

    def test_bad_file_or_http_cta_is_dropped(self, client, monkeypatch, tmp_path):
        import json
        import api.config as config
        f = tmp_path / "trial.json"
        monkeypatch.setattr(config, "TRIAL_FILE", f)
        f.write_text("{not json")
        assert 'id="trial-config">null</script>' in client.get("/", headers={"host": "localhost"}).text
        f.write_text(json.dumps({"ends_at": 1900000000, "cta_url": "http://evil.example/"}))
        body = client.get("/", headers={"host": "localhost"}).text
        assert '"cta_url": ""' in body

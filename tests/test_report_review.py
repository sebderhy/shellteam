"""Review-by-pointing on served HTML (docs/decisions/20260920-report-review-picker.md).

Two contracts:
  - the picker script reaches ONLY the owner's own view of content-sandboxed
    HTML: never a visitor (signed link, published page), never the trusted file
    UI, never non-HTML, and the sandbox CSP is untouched;
  - the in-place edit endpoint writes only when the edited snippet occurs
    exactly once (byte-exact or whitespace-insensitive), is dashboard-origin
    gated like publishing, and stays confined to the owner's home.
"""

import time

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from api.main import app
from api.services import report_review
from api.services.report_review import PICKER_MARK, EditNotApplicable, apply_text_edit, inject_picker

MASTER = "fake-jwt-token"
LOCAL = {"host": "localhost"}
BEARER = {"Authorization": f"Bearer {MASTER}"}
FILE_ORIGIN = "http://127.0.0.1:80"
MARK = f"data-{PICKER_MARK}"

REPORT_HTML = "<html><body><h1>Deck</h1><p class='lead'>Hello there</p></body></html>"


def _mock_file(path="/reports/r.html", html=REPORT_HTML, ctype="text/html"):
    respx.get(f"{FILE_ORIGIN}{path}").mock(
        return_value=httpx.Response(200, text=html, headers={"content-type": ctype})
    )


@pytest.fixture
def proxy_home(tmp_path, monkeypatch):
    monkeypatch.setattr("api.routers.proxy.HOME_DIR", tmp_path)
    return tmp_path


# --- Unit: inject_picker -------------------------------------------------------------

class TestInjectPicker:
    def test_script_lands_before_body_close(self):
        out = inject_picker(b"<html><body><p>x</p></body></html>")
        assert out.index(MARK.encode()) < out.index(b"</body>")
        assert b"review-ready" in out  # the real picker source, not a stub

    def test_body_less_document_gets_it_appended(self):
        out = inject_picker(b"<p>x</p>")
        assert out.startswith(b"<p>x</p>") and MARK.encode() in out

    def test_picker_source_is_framed_only_and_has_no_privileged_calls(self):
        js = (report_review.FRONTEND_DIR / "review-picker.js").read_text()
        assert "if (window.parent === window) return;" in js
        # The document is opaque-origin: the picker must never try to reach the
        # file API or the control plane itself — postMessage to the parent only.
        assert "fetch(" not in js and "XMLHttpRequest" not in js and "/_api/" not in js


# --- Integration: who receives the picker ------------------------------------------

class TestPickerDelivery:
    @respx.mock
    def test_owner_view_of_sandboxed_report_gets_picker_and_csp_unchanged(self, proxy_home):
        _mock_file()
        with TestClient(app) as client:
            resp = client.get("/reports/r.html", headers={**LOCAL, **BEARER})
        assert resp.status_code == 200
        assert MARK in resp.text
        csp = resp.headers.get("content-security-policy", "")
        assert "sandbox" in csp and "allow-same-origin" not in csp

    @respx.mock
    def test_share_link_visitor_gets_no_picker(self, proxy_home):
        from api.services.auth import sign_share_path

        exp = int(time.time()) + 300
        sig = sign_share_path("reports/r.html", exp)
        _mock_file()
        with TestClient(app) as client:
            resp = client.get(f"/reports/r.html?sig={sig}&exp={exp}", headers=LOCAL)
        assert resp.status_code == 200
        assert MARK not in resp.text

    @respx.mock
    def test_published_page_anonymous_visitor_gets_no_picker(self, proxy_home, monkeypatch):
        monkeypatch.setattr("api.routers.proxy.reports.is_report_public", lambda *_: True)
        _mock_file("/public/site.html")
        with TestClient(app) as client:
            resp = client.get("/public/site.html", headers=LOCAL)
        assert resp.status_code == 200
        assert MARK not in resp.text

    @respx.mock
    def test_non_html_is_untouched(self, proxy_home):
        _mock_file("/reports/data.json", html='{"a": 1}', ctype="application/json")
        with TestClient(app) as client:
            resp = client.get("/reports/data.json", headers={**LOCAL, **BEARER})
        assert resp.status_code == 200
        assert resp.text == '{"a": 1}'

    @respx.mock
    def test_trusted_file_ui_is_untouched(self, proxy_home):
        # /_editor is exempt from the content sandbox (real origin) — no picker.
        _mock_file("/_editor/reports/r.html", html="<html><body>editor</body></html>")
        with TestClient(app) as client:
            resp = client.get("/_editor/reports/r.html", headers={**LOCAL, **BEARER})
        assert resp.status_code == 200
        assert MARK not in resp.text


# --- Integration: apps on a port (the owner's side-panel view) -----------------------
# The panel's Comment/Edit buttons were dead on every app (Seb, 2026-09-25, on his
# own site at home.<domain>): the picker only reached files, so an app page never
# said review-ready. The owner's framed view of an app document now carries it;
# every other app response keeps streaming through untouched.

APP_PORT = 4000
APP_HOST = {"host": f"alice-{APP_PORT}.localhost"}
IFRAME = {"sec-fetch-dest": "iframe"}


@pytest.fixture
def app_owner():
    from unittest.mock import AsyncMock, patch

    with patch(
        "api.routers.proxy.resolve_username_owner",
        new_callable=AsyncMock,
        return_value=("172.20.0.5", "user-uuid-1234"),
    ):
        yield


def _owner_cookie():
    from api.services.auth import FILES_COOKIE, files_token

    return {"cookie": f"{FILES_COOKIE}={files_token()}"}


def _mock_app(path="/", html=REPORT_HTML, ctype="text/html; charset=utf-8", status=200):
    respx.get(f"http://172.20.0.5:{APP_PORT}{path}").mock(
        return_value=httpx.Response(status, text=html, headers={"content-type": ctype})
    )


class TestAppPickerDelivery:
    @respx.mock
    def test_owner_panel_view_of_an_app_page_gets_picker(self, app_owner):
        _mock_app()
        with TestClient(app, base_url="http://localhost") as client:
            resp = client.get("/", headers={**APP_HOST, **IFRAME, **_owner_cookie()})
        assert resp.status_code == 200
        assert MARK in resp.text
        assert resp.text.index(MARK) < resp.text.index("</body>")
        assert int(resp.headers["content-length"]) == len(resp.content)

    @respx.mock
    def test_top_level_app_visit_is_byte_identical(self, app_owner):
        _mock_app()
        with TestClient(app, base_url="http://localhost") as client:
            resp = client.get("/", headers={**APP_HOST, **_owner_cookie()})
        assert resp.text == REPORT_HTML

    @respx.mock
    def test_share_link_visitor_of_an_app_gets_no_picker(self, app_owner):
        from api.services.auth import PORT_SHARE_COOKIE, port_share_cookie_value

        exp = int(time.time()) + 600
        _mock_app()
        with TestClient(app, base_url="http://localhost") as client:
            resp = client.get("/", headers={
                **APP_HOST, **IFRAME,
                "cookie": f"{PORT_SHARE_COOKIE}={port_share_cookie_value(APP_PORT, exp)}",
            })
        assert resp.status_code == 200
        assert MARK not in resp.text

    @respx.mock
    def test_anonymous_visitor_of_a_public_app_gets_no_picker(self, app_owner, monkeypatch):
        monkeypatch.setattr("api.routers.proxy.ports.is_port_public", lambda *_: True)
        _mock_app()
        with TestClient(app, base_url="http://localhost") as client:
            resp = client.get("/", headers={**APP_HOST, **IFRAME})
        assert resp.status_code == 200
        assert MARK not in resp.text

    @respx.mock
    def test_app_non_html_and_errors_are_untouched(self, app_owner):
        _mock_app("/data.json", html='{"a": 1}', ctype="application/json")
        _mock_app("/missing", html="<html><body>nope</body></html>", status=404)
        with TestClient(app, base_url="http://localhost") as client:
            data = client.get("/data.json", headers={**APP_HOST, **IFRAME, **_owner_cookie()})
            missing = client.get("/missing", headers={**APP_HOST, **IFRAME, **_owner_cookie()})
        assert data.text == '{"a": 1}'
        assert MARK not in missing.text


class TestPanelAppButtonsWiring:
    """The dashboard half: the panel must accept the picker on an app and route
    Private/Share to the port endpoints instead of disabling them."""

    def test_dashboard_panel_handles_apps(self):
        html = (report_review.FRONTEND_DIR / "dashboard.html").read_text()
        assert "an app on a port never carries the picker" not in html
        assert "share it from the Apps tab" not in html
        assert "fetch('/api/computers/ports'" in html
        assert "`port=${appPort}`" in html


class TestPortVisibilityOriginGate:
    def test_content_origin_cannot_flip_a_port_public(self):
        # The panel now drives POST /api/computers/ports, so it gets the same
        # dashboard-origin gate as publishing a file: an app or report page on a
        # same-site subdomain must never make a port world-readable.
        with TestClient(app) as client:
            resp = client.post(
                "/api/computers/ports",
                headers={**LOCAL, **BEARER, "Origin": "https://alice-4000.localhost"},
                json={"port": 4000, "public": True},
            )
        assert resp.status_code == 403


# --- Unit: apply_text_edit -----------------------------------------------------------

SOURCE = (
    "<html><body>\n"
    "  <h1>Deck</h1>\n"
    "  <p class='lead'>Hello   there</p>\n"
    "  <p>Twice</p><p>Twice</p>\n"
    "</body></html>\n"
)


@pytest.fixture
def report(tmp_path):
    (tmp_path / "reports").mkdir()
    f = tmp_path / "reports" / "r.html"
    f.write_text(SOURCE, encoding="utf-8")
    return f


class TestApplyTextEdit:
    def test_unique_exact_match_is_replaced(self, tmp_path, report):
        apply_text_edit(tmp_path, "reports/r.html", "<h1>Deck</h1>", "<h1>Pitch</h1>", "h1")
        text = report.read_text()
        assert "<h1>Pitch</h1>" in text and "<h1>Deck</h1>" not in text
        assert text.count("\n") == SOURCE.count("\n")  # nothing else touched

    def test_whitespace_differences_between_dom_and_source_still_match(self, tmp_path, report):
        # The browser serialises "Hello   there" as "Hello there"; the source keeps its spacing.
        apply_text_edit(tmp_path, "reports/r.html", "Hello there", "Hi there", "p.lead")
        assert "<p class='lead'>Hi there</p>" in report.read_text()

    def test_missing_snippet_is_refused_and_file_untouched(self, tmp_path, report):
        with pytest.raises(EditNotApplicable, match="not found"):
            apply_text_edit(tmp_path, "reports/r.html", "Nope", "x", "p")
        assert report.read_text() == SOURCE

    def test_ambiguous_snippet_is_refused_and_file_untouched(self, tmp_path, report):
        with pytest.raises(EditNotApplicable, match="2 times"):
            apply_text_edit(tmp_path, "reports/r.html", "Twice", "Once", "p")
        assert report.read_text() == SOURCE

    def test_empty_snippet_is_refused(self, tmp_path, report):
        with pytest.raises(EditNotApplicable):
            apply_text_edit(tmp_path, "reports/r.html", "   ", "x", "p")

    def test_no_temp_file_left_behind(self, tmp_path, report):
        apply_text_edit(tmp_path, "reports/r.html", "<h1>Deck</h1>", "<h1>P</h1>", "h1")
        assert [p.name for p in (tmp_path / "reports").iterdir()] == ["r.html"]


# --- Route: POST /api/computers/reports/edit -----------------------------------------

DASH = {"Origin": "http://localhost"}


@pytest.fixture
def home(tmp_path, monkeypatch, report):
    monkeypatch.setattr("api.services.runtime.user_home_dir", lambda *a, **k: tmp_path)
    return tmp_path


class TestEditRoute:
    def _post(self, client, auth_header, body, origin=DASH):
        return client.post("/api/computers/reports/edit", json=body, headers={**auth_header, **origin})

    def test_dashboard_origin_edit_is_saved(self, client, auth_header, home, report):
        resp = self._post(client, auth_header, {
            "path": "reports/r.html", "old_html": "<h1>Deck</h1>", "new_html": "<h1>Pitch</h1>", "selector": "h1",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"path": "reports/r.html", "saved": True}
        assert "<h1>Pitch</h1>" in report.read_text()

    def test_ambiguous_edit_is_409_so_the_dashboard_hands_it_to_the_agent(self, client, auth_header, home, report):
        resp = self._post(client, auth_header, {
            "path": "reports/r.html", "old_html": "Twice", "new_html": "Once",
        })
        assert resp.status_code == 409
        assert "2 times" in resp.json()["detail"]
        assert report.read_text() == SOURCE

    def test_sandboxed_null_origin_refused(self, client, auth_header, home, report):
        resp = self._post(client, auth_header, {
            "path": "reports/r.html", "old_html": "<h1>Deck</h1>", "new_html": "<h1>X</h1>",
        }, origin={"Origin": "null"})
        assert resp.status_code == 403
        assert report.read_text() == SOURCE

    def test_dotfile_and_outside_home_refused(self, client, auth_header, home):
        for path in (".bashrc", "../../etc/passwd"):
            resp = self._post(client, auth_header, {"path": path, "old_html": "x", "new_html": "y"})
            assert resp.status_code == 400, path

    def test_missing_file_is_404(self, client, auth_header, home):
        resp = self._post(client, auth_header, {"path": "reports/nope.html", "old_html": "x", "new_html": "y"})
        assert resp.status_code == 404

    def test_unauthenticated_refused(self, client, home):
        resp = client.post("/api/computers/reports/edit", json={
            "path": "reports/r.html", "old_html": "x", "new_html": "y",
        }, headers=DASH)
        assert resp.status_code == 401

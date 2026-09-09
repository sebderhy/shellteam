"""Report image inlining (docs/decisions/20260723-report-asset-inlining.md).

The content sandbox (no ``allow-same-origin``) gives served reports an opaque
origin, so the browser CORS-blocks every ``<img>`` subresource — reports with
images rendered broken outside the cockpit panel. The fix rewrites qualifying
relative ``<img src>`` refs to ``data:`` URIs at serve time.

These tests pin BOTH halves of the contract:
  - rendering: relative same-subtree images are inlined (owner view, public
    reports, and signed share links alike);
  - security: the rewrite must never widen what a document can embed — no
    subtree escape, no dotfiles, no absolute paths or schemes, size caps hold,
    and the sandbox CSP itself is untouched.
"""

import base64

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from api.main import app
from api.services.content_inline import (
    MAX_ASSET_BYTES,
    inline_local_images,
)

MASTER = "fake-jwt-token"  # conftest's pinned OWNER_TOKEN
LOCAL = {"host": "localhost"}
BEARER = {"Authorization": f"Bearer {MASTER}"}
FILE_ORIGIN = "http://127.0.0.1:80"  # FILE_PORT defaults to 80 in tests

PNG_BYTES = b"\x89PNG\r\n\x1a\nfake"
PNG_DATA_URI = b"data:image/png;base64," + base64.b64encode(PNG_BYTES)


@pytest.fixture
def home(tmp_path):
    (tmp_path / "reports/assets").mkdir(parents=True)
    (tmp_path / "reports/assets/pic.png").write_bytes(PNG_BYTES)
    (tmp_path / "outside.png").write_bytes(b"outside the report subtree")
    (tmp_path / "reports/.secret.png").write_bytes(b"dotfile")
    return tmp_path


# --- Unit: inline_local_images ----------------------------------------------------

class TestInlineUnit:
    def test_relative_ref_is_inlined(self, home):
        out = inline_local_images(
            b'<img src="assets/pic.png">', "reports/r.html", home
        )
        assert b'src="' + PNG_DATA_URI + b'"' in out

    def test_single_quoted_and_query_refs_are_inlined(self, home):
        html = b"<img src='assets/pic.png'><img src=\"assets/pic.png?v=2\">"
        out = inline_local_images(html, "reports/r.html", home)
        assert out.count(PNG_DATA_URI) == 2

    def test_subtree_escape_is_refused(self, home):
        html = b'<img src="../outside.png">'
        assert inline_local_images(html, "reports/r.html", home) == html

    def test_dotfile_is_refused(self, home):
        html = b'<img src=".secret.png">'
        assert inline_local_images(html, "reports/r.html", home) == html

    def test_absolute_scheme_and_data_refs_are_untouched(self, home):
        html = (
            b'<img src="/reports/assets/pic.png">'
            b'<img src="https://example.com/x.png">'
            b'<img src="//example.com/x.png">'
            b'<img src="data:image/png;base64,AAAA">'
        )
        assert inline_local_images(html, "reports/r.html", home) == html

    def test_non_image_extension_is_refused(self, home):
        (home / "reports/assets/page.html").write_text("<p>not an image</p>")
        html = b'<img src="assets/page.html">'
        assert inline_local_images(html, "reports/r.html", home) == html

    def test_per_asset_size_cap_holds(self, home):
        (home / "reports/assets/big.png").write_bytes(b"x" * (MAX_ASSET_BYTES + 1))
        html = b'<img src="assets/big.png">'
        assert inline_local_images(html, "reports/r.html", home) == html

    def test_missing_file_is_left_alone(self, home):
        html = b'<img src="assets/nope.png">'
        assert inline_local_images(html, "reports/r.html", home) == html

    def test_noop_returns_the_same_object(self, home):
        html = b"<p>no images at all</p>"
        assert inline_local_images(html, "reports/r.html", home) is html


# --- Integration: through serve_owner_file + the sandbox middleware ----------------

REPORT_HTML = '<html><body><img src="assets/pic.png"></body></html>'


def _mock_report(path="/reports/r.html", html=REPORT_HTML, ctype="text/html"):
    respx.get(f"{FILE_ORIGIN}{path}").mock(
        return_value=httpx.Response(200, text=html, headers={"content-type": ctype})
    )


@pytest.fixture
def proxy_home(home, monkeypatch):
    monkeypatch.setattr("api.routers.proxy.HOME_DIR", home)
    return home


class TestServeOwnerFileInlining:
    @respx.mock
    def test_sandboxed_report_gets_images_inlined_and_csp_unchanged(self, proxy_home):
        _mock_report()
        with TestClient(app) as client:
            resp = client.get("/reports/r.html", headers={**LOCAL, **BEARER})
        assert resp.status_code == 200
        assert PNG_DATA_URI.decode() in resp.text
        # The whole point: rendering is fixed WITHOUT weakening the sandbox.
        csp = resp.headers.get("content-security-policy", "")
        assert "sandbox" in csp and "allow-same-origin" not in csp

    @respx.mock
    def test_share_sig_view_gets_images_inlined(self, proxy_home):
        import time
        from api.services.auth import sign_share_path

        exp = int(time.time()) + 300
        sig = sign_share_path("reports/r.html", exp)
        _mock_report()
        with TestClient(app) as client:
            resp = client.get(
                f"/reports/r.html?sig={sig}&exp={exp}", headers=LOCAL
            )
        assert resp.status_code == 200
        assert PNG_DATA_URI.decode() in resp.text

    @respx.mock
    def test_trusted_file_ui_is_not_rewritten(self, proxy_home):
        # /_editor/ keeps its real origin (no sandbox) — its subresources load
        # normally, so the inliner must leave it byte-identical.
        (proxy_home / "_editor").mkdir()
        (proxy_home / "_editor/pic.png").write_bytes(PNG_BYTES)
        html = '<html><img src="pic.png"></html>'
        respx.get(f"{FILE_ORIGIN}/_editor/index.html").mock(
            return_value=httpx.Response(200, text=html, headers={"content-type": "text/html"})
        )
        with TestClient(app) as client:
            resp = client.get("/_editor/index.html", headers={**LOCAL, **BEARER})
        assert resp.text == html

    @respx.mock
    def test_non_html_is_untouched(self, proxy_home):
        _mock_report("/reports/data.json", '{"img":"assets/pic.png"}', "application/json")
        with TestClient(app) as client:
            resp = client.get("/reports/data.json", headers={**LOCAL, **BEARER})
        assert resp.text == '{"img":"assets/pic.png"}'

    @respx.mock
    def test_share_footer_still_appended_after_inlining(self, proxy_home):
        import time
        from api.services.auth import sign_share_path

        exp = int(time.time()) + 300
        sig = sign_share_path("reports/r.html", exp)
        _mock_report()
        with TestClient(app) as client:
            resp = client.get(
                f"/reports/r.html?sig={sig}&exp={exp}", headers=LOCAL
            )
        assert PNG_DATA_URI.decode() in resp.text
        assert "Made with" in resp.text  # footer and inliner compose

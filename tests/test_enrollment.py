"""Tests for device enrollment — one-time link login (feature #2).

Covers the in-memory code service (mint / single-use redeem / expiry) and the
two endpoints (owner-authed mint, unauthed redeem that sets the session cookie).
"""

import time

import pytest


# ---------------------------------------------------------------------------
# Service: mint / redeem / single-use / expiry
# ---------------------------------------------------------------------------
class TestEnrollmentService:
    def setup_method(self):
        from api.services import enrollment
        enrollment._codes.clear()

    def test_mint_returns_code_and_ttl(self):
        from api.services import enrollment
        code, ttl = enrollment.mint_code()
        assert isinstance(code, str) and len(code) >= 32
        assert ttl == enrollment.CODE_TTL_SECONDS

    def test_redeem_is_single_use(self):
        from api.services import enrollment
        code, _ = enrollment.mint_code()
        assert enrollment.redeem_code(code) is True
        assert enrollment.redeem_code(code) is False  # already consumed

    def test_peek_validates_without_consuming(self):
        from api.services import enrollment
        code, _ = enrollment.mint_code()
        assert enrollment.peek_code(code) is True
        assert enrollment.peek_code(code) is True  # peek never consumes
        assert enrollment.redeem_code(code) is True  # still redeemable after peeks
        assert enrollment.peek_code(code) is False  # gone once consumed

    def test_peek_rejects_unknown_and_empty(self):
        from api.services import enrollment
        assert enrollment.peek_code("never-minted") is False
        assert enrollment.peek_code("") is False
        assert enrollment.peek_code(None) is False

    def test_redeem_rejects_unknown_code(self):
        from api.services import enrollment
        assert enrollment.redeem_code("never-minted") is False

    def test_redeem_rejects_empty(self):
        from api.services import enrollment
        assert enrollment.redeem_code("") is False
        assert enrollment.redeem_code(None) is False

    def test_expired_code_is_rejected(self):
        from api.services import enrollment
        code, _ = enrollment.mint_code()
        # Force the code to have expired a second ago.
        enrollment._codes[code] = time.time() - 1
        assert enrollment.redeem_code(code) is False


# ---------------------------------------------------------------------------
# Endpoints: POST /api/auth/enroll (authed) + GET /enroll (unauthed)
# ---------------------------------------------------------------------------
class TestEnrollEndpoints:
    def test_mint_requires_auth(self, client):
        """No token → 401, never mints a link."""
        resp = client.post("/api/auth/enroll")
        assert resp.status_code == 401

    def test_mint_returns_link_qr_ttl(self, client, auth_header):
        resp = client.post("/api/auth/enroll", headers=auth_header)
        assert resp.status_code == 200
        body = resp.json()
        assert "/enroll?code=" in body["url"]
        assert body["expires_in"] == 300
        assert body["qr_svg"].lstrip().startswith("<svg")

    def test_qr_svg_is_responsive_not_clipped(self, client, auth_header):
        """The QR must carry a viewBox and no fixed width/height, so the dashboard's
        `width:100%` sizing scales it instead of clipping it. A fixed-size SVG renders
        only its top-left corner in the 160px modal box → unscannable (the original bug)."""
        body = client.post("/api/auth/enroll", headers=auth_header).json()
        svg_tag = body["qr_svg"].split(">", 1)[0]
        assert "viewBox=" in svg_tag
        assert "width=" not in svg_tag
        assert "height=" not in svg_tag

    @staticmethod
    def _mint_code(client, auth_header):
        from urllib.parse import urlparse, parse_qs
        url = client.post("/api/auth/enroll", headers=auth_header).json()["url"]
        return parse_qs(urlparse(url).query)["code"][0]

    def test_get_shows_confirm_page_without_consuming(self, client, auth_header):
        """The GET renders the confirm button and must NOT burn the code — this is
        the fix for link-scanners (Palo Alto / SafeLinks / prefetch) eating the
        one-time code before the human clicks."""
        code = self._mint_code(client, auth_header)

        resp = client.get(f"/enroll?code={code}", follow_redirects=False)
        assert resp.status_code == 200
        assert "<form method='post'" in resp.text
        assert "set-cookie" not in {k.lower() for k in resp.headers}
        # Code survived the GET: a subsequent POST still redeems it.
        post = client.post("/enroll", data={"code": code}, follow_redirects=False)
        assert post.status_code == 303

    def test_get_repeated_does_not_consume(self, client, auth_header):
        """A scanner that hits the GET many times still leaves the code redeemable."""
        code = self._mint_code(client, auth_header)
        for _ in range(3):
            assert client.get(f"/enroll?code={code}", follow_redirects=False).status_code == 200
        assert client.post("/enroll", data={"code": code}, follow_redirects=False).status_code == 303

    def test_post_sets_cookie_and_redirects(self, client, auth_header):
        code = self._mint_code(client, auth_header)
        resp = client.post("/enroll", data={"code": code}, follow_redirects=False)
        assert resp.status_code == 303
        assert resp.headers["location"] == "/"
        assert "shellteam_token=" in resp.headers.get("set-cookie", "")

    def test_post_is_single_use(self, client, auth_header):
        code = self._mint_code(client, auth_header)
        assert client.post("/enroll", data={"code": code}, follow_redirects=False).status_code == 303
        # Reusing the same code fails closed.
        assert client.post("/enroll", data={"code": code}, follow_redirects=False).status_code == 400

    def test_get_rejects_garbage_code(self, client):
        resp = client.get("/enroll?code=not-a-real-code", follow_redirects=False)
        assert resp.status_code == 400

    def test_post_rejects_garbage_code(self, client):
        resp = client.post("/enroll", data={"code": "not-a-real-code"}, follow_redirects=False)
        assert resp.status_code == 400

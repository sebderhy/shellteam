"""The split-credential security model (docs/decisions/20260702-split-credentials.md).

Regression pack for the launch-post claim: "the master token is never readable
by page JavaScript and never appears in a URL; sharing mints a short-lived
signed link."

  - master session cookie: HttpOnly, HOST-ONLY (no Domain=) on APP_DOMAIN
  - shellteam_files: HttpOnly, domain-wide, derived, read-only
  - signed share links: per-path, expiring, revoked by rotating OWNER_TOKEN
  - ?token= master acceptance is dead everywhere except the one-time GET /?token=
    redemption (cookie set, query scrubbed)

conftest pins OWNER_TOKEN=fake-jwt-token, so the real derivations are exercised.
"""

import time
from http.cookies import SimpleCookie

import pytest

from api.services.auth import (
    files_token,
    sign_share_path,
    token_grants_files_read,
    verify_share_sig,
)

MASTER = "fake-jwt-token"  # conftest's pinned OWNER_TOKEN


def parse_set_cookies(resp) -> dict[str, SimpleCookie]:
    """All Set-Cookie headers, keyed by '<name>@<domain>' (a host-only and a
    domain-wide cookie with the same name are distinct cookies)."""
    jar = {}
    for header in resp.headers.get_list("set-cookie"):
        c = SimpleCookie()
        c.load(header)
        for name, morsel in c.items():
            jar[f"{name}@{morsel['domain']}"] = morsel
    return jar


class TestDerivedCredential:
    def test_files_token_is_derived_not_master(self):
        ft = files_token()
        assert len(ft) == 64 and ft != MASTER

    def test_grants_matrix(self):
        assert token_grants_files_read(MASTER) is True
        assert token_grants_files_read(files_token()) is True
        assert token_grants_files_read("garbage") is False
        assert token_grants_files_read("") is False
        assert token_grants_files_read(None) is False

    def test_files_token_cannot_pass_master_gate(self):
        """The derived credential must never verify as the owner (terminal, API)."""
        from api.services.auth import token_is_owner
        assert token_is_owner(files_token()) is False


class TestSignedShareLinks:
    def test_roundtrip(self):
        exp = int(time.time()) + 60
        sig = sign_share_path("tmp/chart.png", exp)
        assert verify_share_sig("tmp/chart.png", sig, str(exp)) is True

    def test_expired_rejected(self):
        exp = int(time.time()) - 1
        sig = sign_share_path("tmp/chart.png", exp)
        assert verify_share_sig("tmp/chart.png", sig, str(exp)) is False

    def test_wrong_path_rejected(self):
        exp = int(time.time()) + 60
        sig = sign_share_path("tmp/chart.png", exp)
        assert verify_share_sig("tmp/other.png", sig, str(exp)) is False
        assert verify_share_sig(".ssh/id_rsa", sig, str(exp)) is False

    def test_tampered_exp_rejected(self):
        exp = int(time.time()) + 60
        sig = sign_share_path("tmp/chart.png", exp)
        assert verify_share_sig("tmp/chart.png", sig, str(exp + 9999)) is False

    def test_garbage_inputs_rejected(self):
        assert verify_share_sig("tmp/x", None, None) is False
        assert verify_share_sig("tmp/x", "sig", "not-a-number") is False
        assert verify_share_sig("tmp/x", "", str(int(time.time()) + 60)) is False

    def test_leading_slash_normalized(self):
        exp = int(time.time()) + 60
        assert sign_share_path("/tmp/chart.png", exp) == sign_share_path("tmp/chart.png", exp)


class TestSessionCookies:
    """Every cookie-setting flow must produce the same split pair."""

    def assert_split_cookies(self, resp):
        jar = parse_set_cookies(resp)
        # Master: HttpOnly + HOST-ONLY (empty Domain attribute) — page JS can't
        # read it, subdomains never receive it.
        master = jar["shellteam_token@"]
        assert master.value == MASTER
        assert master["httponly"]
        assert master["samesite"].lower() == "lax"
        # Files credential: HttpOnly + domain-wide (subdomain iframes carry it).
        files = jar["shellteam_files@localhost"]
        assert files.value == files_token()
        assert files["httponly"]
        # The legacy JS-readable domain-wide master is explicitly deleted.
        legacy = jar["shellteam_token@localhost"]
        assert legacy.value == "" and legacy["max-age"] == "0"

    def test_enrollment_redeem_sets_split_cookies(self, client, auth_header):
        code = client.post("/api/auth/enroll", headers=auth_header).json()["url"].split("code=")[1]
        resp = client.post("/enroll", data={"code": code}, follow_redirects=False)
        assert resp.status_code == 303
        self.assert_split_cookies(resp)

    def test_login_endpoint(self, client):
        resp = client.post("/api/auth/login", json={"token": MASTER})
        assert resp.status_code == 200
        self.assert_split_cookies(resp)

    def test_login_rejects_bad_token(self, client):
        resp = client.post("/api/auth/login", json={"token": "wrong"})
        assert resp.status_code == 401
        assert "set-cookie" not in {k.lower() for k in resp.headers}

    def test_dashboard_refreshes_cookies_for_authed_session(self, client, auth_header):
        resp = client.get("/", headers=auth_header)
        assert resp.status_code == 200
        self.assert_split_cookies(resp)

    def test_dashboard_sets_no_cookies_unauthenticated(self, client):
        resp = client.get("/")
        assert resp.status_code == 200  # the shell loads; the JS gate asks /session
        assert "set-cookie" not in {k.lower() for k in resp.headers}

    def test_url_token_redeemed_once_and_scrubbed(self, client):
        resp = client.get(f"/?token={MASTER}", follow_redirects=False)
        assert resp.status_code == 303
        assert resp.headers["location"] == "/"
        self.assert_split_cookies(resp)

    def test_url_token_invalid_not_redeemed(self, client):
        resp = client.get("/?token=wrong", follow_redirects=False)
        assert resp.status_code == 303
        assert "set-cookie" not in {k.lower() for k in resp.headers}


class TestSessionProbe:
    def test_session_authed(self, client, auth_header):
        assert client.get("/api/auth/session", headers=auth_header).status_code == 200

    def test_session_cookie_authed(self, client):
        client.cookies.set("shellteam_token", MASTER)
        assert client.get("/api/auth/session").status_code == 200

    def test_session_unauthed_401(self, client):
        assert client.get("/api/auth/session").status_code == 401

    def test_files_credential_is_not_a_session(self, client):
        """The derived read-only credential must not unlock the API."""
        client.cookies.set("shellteam_token", files_token())
        assert client.get("/api/auth/session").status_code == 401


class TestShareMintEndpoint:
    def test_mint_and_verify(self, client, auth_header):
        resp = client.get("/api/auth/share", params={"path": "tmp/chart.png", "ttl": 300},
                          headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert "/tmp/chart.png?sig=" in data["url"]
        sig = data["url"].split("sig=")[1].split("&")[0]
        exp = data["url"].split("exp=")[1]
        assert verify_share_sig("tmp/chart.png", sig, exp) is True

    def test_mint_requires_owner(self, client):
        assert client.get("/api/auth/share", params={"path": "tmp/x"}).status_code == 401

    def test_mint_rejects_dotfiles_and_traversal(self, client, auth_header):
        for path in (".env", ".ssh/id_rsa", "a/../.env", "a/./.git/config"):
            resp = client.get("/api/auth/share", params={"path": path}, headers=auth_header)
            assert resp.status_code == 400, path

    def test_ttl_is_capped(self, client, auth_header):
        resp = client.get("/api/auth/share",
                          params={"path": "tmp/x.png", "ttl": 10**9}, headers=auth_header)
        assert resp.json()["expires_in"] == 30 * 86400

    def test_special_chars_are_percent_encoded_and_still_verify(self, client, auth_header):
        """A filename with a space/#/% must yield a well-formed URL whose path,
        once the browser+server re-decode it, still matches the signature."""
        from urllib.parse import urlsplit, unquote, parse_qs
        rel = "reports/Q3 plan #2 (50%).html"
        resp = client.get("/api/auth/share", params={"path": rel}, headers=auth_header)
        assert resp.status_code == 200
        url = resp.json()["url"]
        parts = urlsplit(url)
        # The raw URL must not carry unencoded delimiters that would break parsing.
        assert " " not in url and "#" not in parts.path
        qs = parse_qs(parts.query)
        decoded_path = unquote(parts.path).lstrip("/")  # what serve_owner_file sees
        assert decoded_path == rel
        assert verify_share_sig(decoded_path, qs["sig"][0], qs["exp"][0]) is True


class TestTokenRedemptionThrottled:
    """GET /?token= must not be a softer brute-force oracle than /api/auth/login.

    The handler imports note_auth_failure from api.services.ratelimit at call
    time, so patching it there catches the real call.
    """

    def test_invalid_url_token_counts_as_auth_failure(self, client, monkeypatch):
        calls = []
        import api.services.ratelimit as rl
        monkeypatch.setattr(rl, "note_auth_failure", lambda request: calls.append(1))
        resp = client.get("/?token=wrong", follow_redirects=False)
        assert resp.status_code == 303
        assert len(calls) == 1

    def test_valid_url_token_does_not_count_as_failure(self, client, monkeypatch):
        calls = []
        import api.services.ratelimit as rl
        monkeypatch.setattr(rl, "note_auth_failure", lambda request: calls.append(1))
        resp = client.get(f"/?token={MASTER}", follow_redirects=False)
        assert resp.status_code == 303
        assert calls == []

    def test_repeated_bad_url_tokens_eventually_429(self, client):
        """The real backoff (10/min/IP) trips on a GET /?token= dictionary loop."""
        import api.services.ratelimit as rl
        rl.auth_failure_limiter.reset()
        statuses = [client.get("/?token=bad", follow_redirects=False).status_code
                    for _ in range(15)]
        assert 429 in statuses
        rl.auth_failure_limiter.reset()


class TestFrontendIsCredentialBlind:
    """No served page may read, store, or write a credential from JS."""

    @pytest.mark.parametrize("page", ["dashboard.html", "terminal.html", "browser.html"])
    def test_no_js_token_handling(self, page):
        import re
        from pathlib import Path
        html = (Path(__file__).parent.parent / "frontend" / page).read_text()
        # localStorage get/set are allowed ONLY for the first-run wizard flag —
        # a non-credential UI marker. Anything else must never touch JS-readable
        # storage. removeItem is allowed (the migration scrub).
        for args in re.findall(r"localStorage\.(?:setItem|getItem)\(([^)]*)\)", html):
            assert "WIZARD_DONE_KEY" in args, (
                f"{page} must not store credentials (localStorage call with {args!r})"
            )
        assert "persistToken" not in html
        assert "document.cookie" not in html, f"{page} must not read/write cookies from JS"
        assert "?token=" not in html, f"{page} must not build ?token= URLs"

"""Single-user auth for ShellTeam OSS.

There is exactly one owner; their identity is fixed from the environment
(`api.config`). There is no database, no JWTs, no per-request users. Auth is a
single shared secret: when `OWNER_TOKEN` is set every request must present it;
when it is empty the box is assumed bound to localhost and requests are trusted.

The owner's mutable profile (username, timezone) lives in a small JSON file
under `DATA_DIR/OWNER_ID/profile.json` so it survives restarts.
"""

import hashlib
import hmac
import json
import logging
import time
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Request, HTTPException, Response

from api.config import APP_DOMAIN, MAIN_HOSTS, OWNER_ID, OWNER_EMAIL, OWNER_USERNAME, OWNER_TOKEN, DATA_DIR

log = logging.getLogger(__name__)

# Cookie names of the split-credential model (decisions/20260702-split-credentials.md):
# the master session cookie (HttpOnly, host-only on APP_DOMAIN — page JS can never
# read it, subdomains never receive it) and the derived read-only content credential
# (HttpOnly, domain-wide so file/port-subdomain iframes carry it).
MASTER_COOKIE = "shellteam_token"
FILES_COOKIE = "shellteam_files"
SESSION_MAX_AGE = 31536000  # 1 year


def token_is_owner(token: str | None) -> bool:
    """True if the presented token authenticates the owner.

    Constant-time compare against OWNER_TOKEN. When OWNER_TOKEN is unset the box
    is in localhost-trust mode and any caller is treated as the owner.
    """
    if not OWNER_TOKEN:
        return True
    # Encode to bytes: hmac.compare_digest on two `str` raises TypeError for any
    # non-ASCII character, which would surface as an unhandled 500 on a junk
    # Authorization header (L4). Bytes compare is total and still constant-time.
    return bool(token) and hmac.compare_digest(token.encode("utf-8", "ignore"), OWNER_TOKEN.encode("utf-8"))


def _derive(purpose: str) -> str:
    """Derive a purpose-bound secondary credential from the master token."""
    if not OWNER_TOKEN:
        return ""
    return hmac.new(OWNER_TOKEN.encode(), purpose.encode(), hashlib.sha256).hexdigest()


def _sig_eq(presented: str, expected: str) -> bool:
    """Constant-time signature compare that tolerates arbitrary client input.

    ``hmac.compare_digest`` raises TypeError when either ``str`` contains a
    non-ASCII character, so a URL like ``?sig=é`` turned untrusted input into a
    500. Our signatures are always hex (ASCII); encode both sides to bytes with
    ``errors="ignore"`` so a junk value compares False instead of crashing.
    The single choke point for every ``?sig=`` / cookie signature check."""
    return hmac.compare_digest(
        presented.encode("utf-8", "ignore"), expected.encode("utf-8", "ignore")
    )


def files_token() -> str:
    """The derived, read-only content credential (`shellteam_files` cookie value).

    Grants GET/HEAD on the owner's files and nothing else — it cannot reach the
    terminal, mutating API routes, or file writes. Rotates with OWNER_TOKEN.
    Empty in localhost-trust mode (no OWNER_TOKEN → nothing to derive).
    """
    return _derive("files-v1")


def token_grants_files_read(token: str | None) -> bool:
    """True if ``token`` may READ the owner's files: the master or the derived
    files credential. Constant-time; trust-mode (no OWNER_TOKEN) always passes."""
    if not OWNER_TOKEN:
        return True
    if not token:
        return False
    tok = token.encode("utf-8", "ignore")  # bytes compare: total, non-ASCII-safe (L4)
    return hmac.compare_digest(tok, OWNER_TOKEN.encode("utf-8")) or hmac.compare_digest(
        tok, files_token().encode("utf-8")
    )


def request_grants_files_read(request: Request) -> bool:
    """File-read auth for an HTTP request: master (Bearer/cookie) or files cookie."""
    if token_grants_files_read(get_token_from_request(request)):
        return True
    files_cred = request.cookies.get(FILES_COOKIE, "")
    return bool(files_cred) and token_grants_files_read(files_cred)


# --- Signed share links (S3-presigned style) -------------------------------------
# `?sig=HMAC(master, "share-v1|<path>|<exp>")&exp=<unix>` grants GET/HEAD on that
# one path until `exp`. Leaking a share link exposes one file for its TTL, not the
# box; rotating OWNER_TOKEN revokes all outstanding links.


def sign_share_path(path: str, exp: int) -> str:
    """HMAC signature binding one home-relative path to an expiry timestamp."""
    path = path.lstrip("/")
    return _derive(f"share-v1|{path}|{exp}")


def verify_share_sig(path: str, sig: str | None, exp: str | None) -> bool:
    """True when ``sig`` is a live signature for exactly this path."""
    if not OWNER_TOKEN or not sig or not exp:
        return False
    try:
        exp_ts = int(exp)
    except ValueError:
        return False
    if exp_ts < time.time():
        return False
    return _sig_eq(sig, sign_share_path(path, exp_ts))


# --- Signed share links for PORTS (running apps) ----------------------------------
# Files get `?sig=&exp=` links; a running app needs the same "hand a friend a
# link, it expires" story. One request can't carry an app (assets, API calls,
# WebSockets follow), so the signature is REDEEMED: the first hit on
# `https://<owner>-<port>.APP_DOMAIN/?sig=&exp=` verifies and sets a host-only
# cookie scoped to that one port subdomain, then redirects to the clean URL.
# The credential grants all HTTP methods on that single port until exp — an app
# is interactive, a viewer must be able to POST to it; everything else on the
# box stays out of reach. Rotating OWNER_TOKEN revokes all outstanding links.

PORT_SHARE_COOKIE = "shellteam_port_share"


def sign_share_port(port: int, exp: int) -> str:
    """HMAC signature binding one port number to an expiry timestamp."""
    return _derive(f"share-port-v1|{port}|{exp}")


def verify_share_port_sig(port: int, sig: str | None, exp: str | None) -> bool:
    """True when ``sig`` is a live share signature for exactly this port."""
    if not OWNER_TOKEN or not isinstance(sig, str) or not isinstance(exp, str):
        return False
    try:
        exp_ts = int(exp)
    except ValueError:
        return False
    if exp_ts < time.time():
        return False
    return _sig_eq(sig, sign_share_port(port, exp_ts))


def port_share_cookie_value(port: int, exp: int) -> str:
    """Serialize the redeemed port-share credential for the cookie."""
    return f"{port}|{exp}|{sign_share_port(port, exp)}"


def verify_port_share_cookie(value: str | None, port: int) -> bool:
    """True when ``value`` is a live redeemed credential for exactly ``port``."""
    if not isinstance(value, str) or not value:
        return False
    parts = value.split("|")
    if len(parts) != 3:
        return False
    cookie_port, exp, sig = parts
    if cookie_port != str(port):
        return False
    return verify_share_port_sig(port, sig, exp)


# --- Mirror-upload credential (Environment Mirror import wizard) -----------------
# The Settings page bakes `mirror-v1.<exp>.<sig>` into the copy-paste import
# command. It grants exactly one thing — POST /api/mirror/upload until <exp> —
# so the command can sit in a laptop's shell history without exposing the
# master token. Rotating OWNER_TOKEN revokes all outstanding credentials.


def sign_mirror_upload(exp: int) -> str:
    """HMAC signature binding the mirror-upload capability to an expiry."""
    return _derive(f"mirror-v1|{exp}")


def mirror_upload_cred(exp: int) -> str:
    """The serialized credential handed to the laptop wizard."""
    return f"mirror-v1.{exp}.{sign_mirror_upload(exp)}"


def verify_mirror_cred(cred: str | None) -> bool:
    """True when ``cred`` is a live mirror-upload credential."""
    if not OWNER_TOKEN or not cred:
        return False
    parts = cred.split(".")
    if len(parts) != 3 or parts[0] != "mirror-v1":
        return False
    try:
        exp = int(parts[1])
    except ValueError:
        return False
    if exp < time.time():
        return False
    # Bytes compare, like token_is_owner/token_grants_files_read: comparing two
    # `str` raises TypeError on any non-ASCII character, and Starlette decodes
    # header bytes as latin-1, so a single 0x80+ byte in the Authorization
    # header would 500 here — unhandled, and short-circuiting the brute-force
    # backoff that only runs on a clean False (L4).
    return hmac.compare_digest(
        parts[2].encode("utf-8", "ignore"), sign_mirror_upload(exp).encode("utf-8")
    )






def apply_session_cookies(response: Response, secure: bool) -> None:
    """Set the split-credential session cookies (and clear the legacy one).

    - master → HttpOnly, HOST-ONLY (no ``domain=``): page JavaScript can never
      read it and subdomains never receive it. One XSS in served content no
      longer exfiltrates the credential that drives the terminal.
    - files credential → HttpOnly, ``domain=APP_DOMAIN`` so the cockpit/files
      subdomain iframes can read files; it is powerless everywhere else.
    - the pre-split cookie (JS-readable, domain-wide master) is explicitly
      deleted — it is a distinct cookie (different Domain attribute) that would
      otherwise linger, readable, for its remaining year.
    """
    response.set_cookie(
        MASTER_COOKIE, "", max_age=0, domain=APP_DOMAIN, path="/",
        secure=secure, httponly=False, samesite="lax",
    )
    response.set_cookie(
        MASTER_COOKIE, OWNER_TOKEN, max_age=SESSION_MAX_AGE, path="/",
        secure=secure, httponly=True, samesite="lax",
    )
    response.set_cookie(
        FILES_COOKIE, files_token(), max_age=SESSION_MAX_AGE, domain=APP_DOMAIN,
        path="/", secure=secure, httponly=True, samesite="lax",
    )


def origin_is_trusted(origin: str | None) -> bool:
    """CSRF guard for capability endpoints (terminal WS, enroll, share, file writes).

    Returns True when the browser ``Origin`` header names a dashboard (main) host,
    or is absent. An absent Origin means a non-browser client (curl, in-box
    tooling): the ambient-master-cookie attack this guards against *requires* a
    browser, and browsers always send Origin on these state-changing requests, so
    allowing absent-Origin keeps programmatic use working without opening the hole.

    A *present* Origin that is not a main host is refused: a content-sandboxed
    report sends ``Origin: null``, a file/port subdomain sends ``owner.APP_DOMAIN``,
    and an external site sends its own host — none may drive these sinks. This is
    the second layer behind the served-content sandbox (api/main.py): even if the
    sandbox header were ever bypassed, the opaque origin is refused here.
    """
    if not origin:
        return True
    host = urlparse(origin).hostname or ""
    return host in MAIN_HOSTS


def verify_token(token: str) -> dict:
    """Validate a presented token and return the owner payload.

    Signature-compatible with the legacy multi-tenant verifier (returns a dict with
    `sub`/`email`). Raises HTTPException(401) if the token is not the owner's.
    """
    if not token_is_owner(token):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return {"sub": OWNER_ID, "email": OWNER_EMAIL}


def get_token_from_request(request: Request) -> str:
    """Extract a token from the Authorization header or the session cookie.

    ``?token=`` is deliberately NOT accepted: a master token in a URL ends up in
    browser history, server logs, and Referer headers. The only URL-borne
    credentials are the single-use enrollment code (``/enroll?code=``), a
    one-time ``GET /?token=`` redemption that immediately sets the cookie and
    scrubs the query, and per-path signed share links (``?sig=&exp=``).
    Returns "" when none is present (localhost-trust mode tolerates this).
    """
    auth = request.headers.get("Authorization")
    if auth and auth.startswith("Bearer "):
        return auth[7:]
    return request.cookies.get(MASTER_COOKIE, "")


def _profile_path() -> Path:
    return DATA_DIR / OWNER_ID / "profile.json"


def _default_profile() -> dict:
    return {
        "id": OWNER_ID,
        "username": OWNER_USERNAME,
        "tier": "owner",
        "timezone": None,
    }


def _load_profile() -> dict:
    path = _profile_path()
    profile = _default_profile()
    try:
        if path.exists():
            profile.update(json.loads(path.read_text()))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Could not read owner profile %s: %s", path, exc)
    return profile


def _save_profile(profile: dict) -> None:
    path = _profile_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(profile, indent=2))


async def get_user_profile(user_id: str | None = None, user_jwt: str | None = None) -> dict:
    """Return the owner profile. Args kept for signature compatibility."""
    return _load_profile()


async def set_timezone(user_id: str | None, timezone: str, user_jwt: str | None = None) -> None:
    profile = _load_profile()
    profile["timezone"] = timezone
    _save_profile(profile)


async def set_username(user_id: str | None, username: str, user_jwt: str | None = None) -> bool:
    profile = _load_profile()
    profile["username"] = username
    _save_profile(profile)
    return True


async def get_user_tier(user_id: str | None = None) -> str:
    """The owner always has the full ('owner') tier."""
    return "owner"


async def get_user_timezone(user_id: str | None = None) -> str | None:
    return _load_profile().get("timezone")

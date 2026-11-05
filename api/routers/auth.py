import re
import logging
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from api.config import APP_DOMAIN, APP_URL, FILE_PORT, OWNER_TOKEN, OWNER_USERNAME, reserved_service_ports
from api.dependencies import get_current_user, require_trusted_origin
from api.services import sessions
from api.services.auth import (
    MASTER_COOKIE,
    request_is_https,
    clear_session_cookies,
    get_user_profile,
    start_session,
    set_timezone,
    set_username,
    sign_share_path,
    sign_share_port,
    token_is_owner,
)
from api.services.ratelimit import RateLimiter, note_auth_failure
from api.services.exposure_policy import require_public_sharing

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

USERNAME_RE = re.compile(r"^[a-z][a-z0-9-]{2,29}$")

_username_limit = RateLimiter(rate=5, period=60)  # 5 req/min per IP
_login_limit = RateLimiter(rate=10, period=60)  # brute-force guard on top of note_auth_failure
_share_limit = RateLimiter(rate=30, period=60)

SHARE_TTL_DEFAULT = 86400  # 24h
SHARE_TTL_MAX = 30 * 86400  # 30 days


class SetUsernameRequest(BaseModel):
    username: str


class LoginRequest(BaseModel):
    token: str


@router.get("/session")
async def session_status(user: dict = Depends(get_current_user)):
    """Cheap authed probe for the dashboard's login gate (401 when not signed in).

    The master cookie is HttpOnly, so page JS can't inspect it — it asks the
    server instead.
    """
    return {"authenticated": True}


@router.post("/login")
async def login(
    body: LoginRequest, request: Request, response: Response, _rl=Depends(_login_limit)
):
    """Redeem a hand-entered OWNER_TOKEN into a new session.

    The token travels once, in a POST body. The browser gets a random,
    revocable, expiring session in HttpOnly cookies (api/services/sessions.py),
    never the master itself (SHE-136).
    """
    if not OWNER_TOKEN:
        raise HTTPException(
            status_code=409,
            detail="No OWNER_TOKEN set — this box is in localhost-trust mode, nothing to log in to.",
        )
    if not token_is_owner(body.token.strip()):
        note_auth_failure(request)
        log.warning("Dashboard login failed (bad token)")
        raise HTTPException(status_code=401, detail="Invalid token")
    minted = start_session(response, request, kind="login")
    log.info("Dashboard login: session %s started", minted.id)
    return {"authenticated": True}


def _current_session(request: Request) -> dict | None:
    return sessions.lookup(request.cookies.get(MASTER_COOKIE))


@router.post("/confirm")
async def confirm_identity(
    body: LoginRequest,
    request: Request,
    user: dict = Depends(get_current_user),
    _origin=Depends(require_trusted_origin),
    _rl=Depends(_login_limit),
):
    """Step-up: re-enter OWNER_TOKEN to make this session fresh again.

    The web terminal only opens on a session whose last login (or confirm) is
    younger than TERMINAL_FRESH_MINUTES; the terminal page calls this when the
    socket closes with 4401.
    """
    if not OWNER_TOKEN:
        raise HTTPException(status_code=409, detail="No OWNER_TOKEN set, nothing to confirm.")
    rec = _current_session(request)
    if rec is None:
        raise HTTPException(status_code=401, detail="Sign in from the dashboard first.")
    if not token_is_owner(body.token.strip()):
        note_auth_failure(request)
        log.warning("Session %s confirm failed (bad token)", rec["id"])
        raise HTTPException(status_code=401, detail="Invalid token")
    sessions.confirm(rec["id"])
    return {"confirmed": True, "fresh_for_seconds": sessions.TERMINAL_FRESH_SECONDS}


@router.get("/sessions")
async def list_sessions(request: Request, user: dict = Depends(get_current_user)):
    """The live sign-ins (Settings, Devices). Never returns a credential."""
    current = _current_session(request)
    items = sessions.list_sessions()
    for item in items:
        item["current"] = bool(current and current["id"] == item["id"])
    return {"sessions": items}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    user: dict = Depends(get_current_user),
    _origin=Depends(require_trusted_origin),
):
    """End this browser's session."""
    rec = _current_session(request)
    if rec is not None:
        sessions.revoke(rec["id"])
    clear_session_cookies(response, secure=request_is_https(request))
    return {"logged_out": True}


@router.post("/logout-all")
async def logout_everywhere(
    request: Request,
    response: Response,
    user: dict = Depends(get_current_user),
    _origin=Depends(require_trusted_origin),
):
    """Log out everywhere: revoke every session (all browsers, phones and the
    files credentials derived from them). OWNER_TOKEN keeps working as Bearer
    and to sign in again. In-box: curl -X POST -H "Authorization: Bearer
    $OWNER_TOKEN" http://127.0.0.1:8000/api/auth/logout-all"""
    n = sessions.revoke_all()
    clear_session_cookies(response, secure=request_is_https(request))
    log.warning("Log out everywhere: %d session(s) revoked", n)
    return {"revoked": n}


@router.get("/share")
async def mint_share_link(
    path: str = "",
    port: int | None = None,
    ttl: int = SHARE_TTL_DEFAULT,
    user: dict = Depends(get_current_user),
    _origin=Depends(require_trusted_origin),
    _rl=Depends(_share_limit),
):
    """Mint a signed, expiring link for one file — or, with ``port=``, for one
    running app: ``https://<owner>-<port>.APP_DOMAIN/?sig=&exp=``.

    A leaked file link exposes that single path until ``exp``; a leaked port
    link exposes that single port (all methods — apps are interactive) until
    ``exp``. Rotating OWNER_TOKEN revokes every outstanding link at once.
    """
    require_public_sharing()
    if not OWNER_TOKEN:
        raise HTTPException(
            status_code=409,
            detail="No OWNER_TOKEN set — localhost-trust mode serves files without links.",
        )
    if port is not None:
        if port < 1024 or port > 65535 or port == FILE_PORT:
            raise HTTPException(status_code=400, detail="Invalid port")
        if port in reserved_service_ports():
            raise HTTPException(
                status_code=400,
                detail=f"Port {port} belongs to a ShellTeam service and cannot be shared",
            )
        ttl = max(60, min(int(ttl), SHARE_TTL_MAX))
        exp = int(time.time()) + ttl
        sig = sign_share_port(port, exp)
        log.info("Minted port-share link for :%d (ttl=%ss)", port, ttl)
        return {
            "url": f"https://{OWNER_USERNAME}-{port}.{APP_DOMAIN}/?sig={sig}&exp={exp}",
            "expires_at": exp,
            "expires_in": ttl,
        }
    rel = path.lstrip("/")
    if not rel or any(seg in ("", "..") for seg in rel.split("/")) or "\x00" in rel:
        raise HTTPException(status_code=400, detail="Invalid path")
    if any(seg.startswith(".") for seg in rel.split("/")):
        raise HTTPException(status_code=400, detail="Dotfiles cannot be shared")
    ttl = max(60, min(int(ttl), SHARE_TTL_MAX))
    exp = int(time.time()) + ttl
    # Sign the DECODED path (what serve_owner_file sees after Starlette decodes
    # the route), but percent-encode it per-segment for the URL — otherwise a
    # filename with a space/%/#/? yields a malformed link whose re-decoded path
    # no longer matches the signature. Mirrors the cockpit's encodeRelPath.
    sig = sign_share_path(rel, exp)
    encoded = "/".join(quote(seg, safe="") for seg in rel.split("/"))
    log.info("Minted share link for /%s (ttl=%ss)", rel, ttl)
    return {
        "url": f"{APP_URL}/{encoded}?sig={sig}&exp={exp}",
        "expires_at": exp,
        "expires_in": ttl,
    }




@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    """Get current user info + profile."""
    profile = user["profile"]
    username = profile.get("username") if profile else None
    return {
        "id": user["id"],
        "email": user["email"],
        "username": username,
        "has_username": bool(username),
        "tier": user["tier"],
        "features": user["features"],
    }


@router.post("/username")
async def choose_username(
    body: SetUsernameRequest,
    user: dict = Depends(get_current_user),
    _rl=Depends(_username_limit),
):
    """Set the user's username (subdomain). One-time operation."""
    username = body.username.lower().strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-30 chars, start with a letter, only a-z, 0-9, and hyphens",
        )

    # Check if user already has a username
    profile = user["profile"]
    if profile and profile.get("username"):
        raise HTTPException(status_code=409, detail="Username already set")

    try:
        ok = await set_username(user["id"], username, user["token"])
    except httpx.HTTPStatusError as e:
        log.error("Failed to set username for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Failed to set username")
    if not ok:
        raise HTTPException(status_code=409, detail="Username already taken")
    return {"username": username}


class SetTimezoneRequest(BaseModel):
    timezone: str


@router.put("/timezone")
async def update_timezone(
    body: SetTimezoneRequest,
    user: dict = Depends(get_current_user),
):
    """Update the user's IANA timezone (e.g. 'America/New_York')."""
    tz = body.timezone.strip()
    if not tz or len(tz) > 64:
        raise HTTPException(status_code=400, detail="Invalid timezone")
    await set_timezone(user["id"], tz, user["token"])
    return {"timezone": tz}

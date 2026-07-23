import re
import logging
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from api.config import APP_URL, OWNER_TOKEN
from api.dependencies import get_current_user, require_trusted_origin
from api.services.auth import (
    apply_session_cookies,
    get_user_profile,
    set_timezone,
    set_username,
    sign_share_path,
    token_is_owner,
)
from api.services.ratelimit import RateLimiter, note_auth_failure

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


def _request_is_https(request: Request) -> bool:
    return request.headers.get("x-forwarded-proto", request.url.scheme) == "https"


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
    """Redeem a hand-entered OWNER_TOKEN into the split session cookies.

    Replaces the old dashboard flow where JS wrote the master token into a
    readable cookie + localStorage. The token now travels once, in a POST body,
    and lands only in HttpOnly cookies.
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
    apply_session_cookies(response, secure=_request_is_https(request))
    log.info("Dashboard login: session cookies set")
    return {"authenticated": True}


@router.get("/share")
async def mint_share_link(
    path: str,
    ttl: int = SHARE_TTL_DEFAULT,
    user: dict = Depends(get_current_user),
    _origin=Depends(require_trusted_origin),
    _rl=Depends(_share_limit),
):
    """Mint a signed, expiring link for one file: ``<APP_URL>/<path>?sig=&exp=``.

    A leaked link exposes that single path until ``exp``; rotating OWNER_TOKEN
    revokes every outstanding link at once.
    """
    if not OWNER_TOKEN:
        raise HTTPException(
            status_code=409,
            detail="No OWNER_TOKEN set — localhost-trust mode serves files without links.",
        )
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

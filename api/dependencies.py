"""Shared FastAPI dependencies."""

import logging

from fastapi import HTTPException, Request

from api.config import OWNER_ID, OWNER_EMAIL
from api.services.auth import (
    get_user_profile,
    get_token_from_request,
    origin_is_trusted,
    request_is_owner,
)
from api.services.ratelimit import note_auth_failure
from api.services.tiers import get_tier_features

log = logging.getLogger(__name__)


def require_trusted_origin(request: Request) -> None:
    """Reject browser cross-origin requests to a capability endpoint (CSRF guard).

    Attach to any state-changing / capability-minting route that authenticates on
    the ambient master cookie (enroll, share) so a content-sandboxed report
    (``Origin: null``) or any other non-dashboard origin can never drive it. See
    ``auth.origin_is_trusted``.
    """
    if not origin_is_trusted(request.headers.get("origin")):
        log.warning("Cross-origin request refused: %s → %s", request.headers.get("origin"), request.url.path)
        raise HTTPException(status_code=403, detail="Cross-origin request refused")


async def get_current_user(request: Request) -> dict:
    """Return the single owner.

    Single-user OSS: there is exactly one user. Auth is a live session cookie,
    or the master OWNER_TOKEN / a session token as a Bearer header
    (``auth.request_is_owner``), or localhost-trust when OWNER_TOKEN is unset. The return
    shape (id/email/token/profile/tier/features) is preserved so the ~30
    endpoints that depend on it stay unchanged.
    """
    token = get_token_from_request(request)
    if not request_is_owner(request):
        # Throttle brute-force on the shared token (escalates to 429 per IP).
        # Only a presented Bearer can be a guess at OWNER_TOKEN: the cookie
        # takes 256-bit sessions only, and an expired one is the owner's own
        # browser (counting it would lock the owner's IP out on expiry day).
        if request.headers.get("Authorization"):
            note_auth_failure(request)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Lets RateLimiter(key="user") buckets actually track the user — without
    # this every "user"-keyed limiter silently degraded to per-IP.
    request.state.rate_limit_user_id = OWNER_ID

    profile = await get_user_profile()
    return {
        "id": OWNER_ID,
        "email": OWNER_EMAIL,
        "token": token,
        "profile": profile,
        "tier": "owner",
        "features": get_tier_features(),
    }

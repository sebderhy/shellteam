"""Shared FastAPI dependencies."""

import logging

from fastapi import HTTPException, Request

from api.config import OWNER_ID, OWNER_EMAIL
from api.services.auth import (
    get_user_profile,
    get_token_from_request,
    origin_is_trusted,
    token_is_owner,
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

    Single-user OSS: there is exactly one user. Auth is the shared OWNER_TOKEN
    (constant-time compared) or localhost-trust when it is unset. The return
    shape (id/email/token/profile/tier/features) is preserved so the ~30
    endpoints that depend on it stay unchanged.
    """
    token = get_token_from_request(request)
    if not token_is_owner(token):
        # Throttle brute-force on the shared token (escalates to 429 per IP).
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

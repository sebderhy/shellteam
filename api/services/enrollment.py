"""One-time device-enrollment codes — token-free login on a new device.

The owner authenticates once (over Tailscale, or already holding the cookie),
mints a short-lived single-use code, and opens the resulting link on a phone.
Redeeming the link sets the ``shellteam_token`` cookie — the raw ``OWNER_TOKEN``
is never shown, typed, or pasted. This is the pragmatic precursor to WebAuthn
passkeys: a nice mobile flow with nothing leak-able sitting in a chat or history.

Codes live in memory: they are short-lived and single-use, so a control-plane
restart simply invalidates any pending link (mint a new one). The OSS control
plane is a single uvicorn process, so there is no cross-worker sharing to worry
about.
"""

import hmac
import logging
import secrets
import time

log = logging.getLogger(__name__)

# A minted link is valid for this long, then it is useless. Short on purpose:
# the link is meant to be opened immediately on the new device.
CODE_TTL_SECONDS = 300  # 5 minutes

# code -> unix-epoch expiry. Module-level so it survives across requests within
# the process lifetime.
_codes: dict[str, float] = {}


def _purge(now: float) -> None:
    """Drop expired codes. Cheap — the pending set is tiny (manual enrollments)."""
    expired = [c for c, exp in _codes.items() if exp <= now]
    for c in expired:
        del _codes[c]


def mint_code() -> tuple[str, int]:
    """Create a single-use enrollment code. Returns ``(code, ttl_seconds)``.

    Enrollment only makes sense when ``OWNER_TOKEN`` is set (there is a secret to
    grant); callers gate on that before minting.
    """
    now = time.time()
    _purge(now)
    code = secrets.token_urlsafe(32)  # 256 bits — unguessable
    _codes[code] = now + CODE_TTL_SECONDS
    log.info(
        "Minted device-enrollment code (ttl=%ss, pending=%d)",
        CODE_TTL_SECONDS,
        len(_codes),
    )
    return code, CODE_TTL_SECONDS


def _match(code: str | None) -> str | None:
    """Return the stored code equal to ``code`` (constant-time), else None.

    Constant-time compared against each live code so a wrong guess leaks no
    timing signal.
    """
    now = time.time()
    _purge(now)
    if not code:
        return None
    for candidate in _codes:
        if hmac.compare_digest(candidate, code):
            return candidate
    return None


def peek_code(code: str | None) -> bool:
    """True if ``code`` is currently valid — WITHOUT consuming it.

    Used by the ``GET /enroll`` confirm page so that a link-scanner / preview
    bot / browser prefetch (all of which issue GETs) cannot burn the one-time
    code: only the explicit ``POST`` from clicking the button consumes it.
    """
    return _match(code) is not None


def redeem_code(code: str | None) -> bool:
    """Validate and consume a code (single use). True if it grants the token.

    Consumed on success so a link works exactly once. Only the ``POST`` handler
    calls this — never a GET, so automated fetchers can't trigger consumption.
    """
    matched = _match(code)
    if matched is None:
        log.warning("Rejected invalid or expired device-enrollment code")
        return False
    del _codes[matched]
    log.info("Redeemed device-enrollment code; issuing owner session cookie")
    return True

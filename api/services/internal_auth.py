"""Auth for in-box → control-plane API calls (``/internal/*``).

Cloud (multi-tenant): each container is handed a per-user token,
HMAC(secret, user_id), so one tenant can't borrow another tenant's id.

OSS (single-user): there are no tenants. The cockpit and the owner's agents
read the **master** ``SHELLTEAM_AI_TOKEN`` straight from ``.env`` and present it
directly — so the master secret is itself the valid in-box credential.
``verify_token`` accepts either form.

NOTE: on a public deploy Caddy forwards ALL paths, so ``/internal/*`` is
internet-reachable — this HMAC check IS the security boundary for those
endpoints (plus ``_require_loopback`` for the Caddy TLS probe). Never assume
they are loopback-only.
"""

import hashlib
import hmac
import os

_SECRET = os.environ.get("SHELLTEAM_AI_TOKEN", "").encode()


def make_token(user_id: str) -> str:
    """Derive a per-container token from the master secret + user_id."""
    return hmac.new(_SECRET, user_id.encode(), hashlib.sha256).hexdigest()


def verify_token(token: str, user_id: str) -> bool:
    """Accept the master secret (OSS single-user) or the per-user HMAC (Cloud)."""
    if not _SECRET:
        return False
    if hmac.compare_digest(token.encode(), _SECRET):
        return True
    return hmac.compare_digest(token, make_token(user_id))


# --- Scoped notify credential (M0 §0.4) ---
# A capability token that authorizes ONLY /internal/notify — nothing else. It is
# handed to guest sessions (SHELLTEAM_NOTIFY_TOKEN in the guest spawn env) so the
# escalate/ship tools can ping the owner, WITHOUT giving the guest the master
# SHELLTEAM_AI_TOKEN (which would unlock the whole /internal/ai proxy = billable
# LLM/media on the owner's keys). A leaked notify token can, at worst, send the
# owner a rate-limited message.


def notify_token() -> str:
    """The scoped token that authorizes /internal/notify only. Rotates with the
    master secret; empty when no secret is set."""
    if not _SECRET:
        return ""
    return hmac.new(_SECRET, b"notify-v1", hashlib.sha256).hexdigest()


def verify_notify_token(token: str) -> bool:
    """True if ``token`` may call /internal/notify: the master secret or the
    scoped notify token. Constant-time."""
    if not _SECRET or not token:
        return False
    return hmac.compare_digest(token.encode(), _SECRET) or hmac.compare_digest(
        token, notify_token()
    )



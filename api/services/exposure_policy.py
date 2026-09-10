"""One switch that keeps a box from making anything world-readable.

``PUBLIC_SHARING=off`` (``api.config.PUBLIC_SHARING``) is for boxes that
strangers drive: the live demo, a box run for someone else. With it off, every
endpoint that would grant anonymous access refuses (public port toggles, signed
share links, report publishing), and the READ side treats nothing as public
even if a published set survives on disk, so a golden image or an old
``public_ports.json`` cannot leak. Unpublishing always works.
"""

from __future__ import annotations

from fastapi import HTTPException

from api import config

DISABLED_DETAIL = (
    "Public sharing is switched off on this box (PUBLIC_SHARING=off): nothing here "
    "can be made reachable without the owner's sign-in."
)


def public_sharing_enabled() -> bool:
    # Read through the module so tests (and a future runtime toggle) can flip it.
    return bool(config.PUBLIC_SHARING)


def require_public_sharing() -> None:
    """Refuse a request that would make something world-readable."""
    if not public_sharing_enabled():
        raise HTTPException(status_code=403, detail=DISABLED_DETAIL)

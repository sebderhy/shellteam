"""Settings endpoints — dashboard-managed feature keys + auto-update.

Owner-authed (same ``get_current_user`` gate as the other owner routes). The
dashboard Settings tab calls these same-origin, riding the HttpOnly session
cookie.
"""

import json
import logging
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.dependencies import get_current_user
from api import config
from api.services import dreaming, feature_keys

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/settings", tags=["settings"])


class FeatureKeyRequest(BaseModel):
    name: str = Field(..., min_length=1)
    # Empty string = clear the key (no validation call).
    key: str = ""


@router.get("/feature-keys")
async def get_feature_keys(user: dict = Depends(get_current_user)) -> dict:
    """Set/not-set status per feature key. Never returns key values."""
    return {"keys": feature_keys.status()}


@router.post("/feature-keys")
async def set_feature_key(
    body: FeatureKeyRequest, user: dict = Depends(get_current_user)
) -> dict:
    """Validate + persist one feature key (empty key = clear).

    400 with the validator's precise error string when the provider rejects
    the key; the .env file is only written after validation passes.
    """
    try:
        result = await feature_keys.set_key(body.name, body.key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"name": body.name, **result, "keys": feature_keys.status()}


# ── Auto-update ──────────────────────────────────────────────────────────────
# The mode lives in .env (AUTO_UPDATE); scripts/self-update.sh re-reads it on
# every timer tick, so flipping it here takes effect without any restart.

AUTO_UPDATE_MODES = ("off", "daily", "weekly")


def _update_state_path() -> Path:
    return Path(
        os.environ.get("SHELLTEAM_STATE_DIR", str(Path.home() / ".local/state/shellteam"))
    ) / "update-state.json"


def _read_update_state() -> dict | None:
    """Last outcome written by scripts/self-update.sh, or None before any run."""
    path = _update_state_path()
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        log.warning("Unreadable auto-update state at %s: %s", path, e)
        return None


class AutoUpdateRequest(BaseModel):
    mode: str = Field(..., min_length=1)


@router.get("/auto-update")
async def get_auto_update(user: dict = Depends(get_current_user)) -> dict:
    return {
        "mode": os.environ.get("AUTO_UPDATE", "") or "off",
        "last": _read_update_state(),
    }


@router.post("/auto-update")
async def set_auto_update(
    body: AutoUpdateRequest, user: dict = Depends(get_current_user)
) -> dict:
    mode = body.mode.strip().lower()
    if mode not in AUTO_UPDATE_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"AUTO_UPDATE must be one of {', '.join(AUTO_UPDATE_MODES)}",
        )
    # "off" is written explicitly (not cleared) so the .env documents the choice.
    feature_keys.persist("AUTO_UPDATE", mode)
    log.info("AUTO_UPDATE set to %r via Settings", mode)
    return {"mode": mode, "last": _read_update_state()}


# ── Dreaming engine ──────────────────────────────────────────────────────────
# Which coding-agent CLI runs the nightly extraction (DREAM_ENGINE in .env).
# The timer reads .env each run and dreaming.dream_engine() reads os.environ
# at call time, so flipping it here applies to the very next sweep — no
# restart. See docs/decisions/20260903-dreaming-engine-choice.md.


class DreamEngineRequest(BaseModel):
    engine: str = Field(..., min_length=1)


def _dream_engine_state() -> dict:
    return {
        "engine": (os.environ.get("DREAM_ENGINE") or "claude").strip().lower(),
        "enabled": "dreaming" in config.MODULES,
        # Which CLIs are actually installed — the UI greys out the rest.
        "available": {name: shutil.which(name) is not None for name in dreaming.DREAM_ENGINES},
    }


@router.get("/dream-engine")
async def get_dream_engine(user: dict = Depends(get_current_user)) -> dict:
    return _dream_engine_state()


@router.post("/dream-engine")
async def set_dream_engine(
    body: DreamEngineRequest, user: dict = Depends(get_current_user)
) -> dict:
    engine = body.engine.strip().lower()
    if engine not in dreaming.DREAM_ENGINES:
        raise HTTPException(
            status_code=400,
            detail=f"DREAM_ENGINE must be one of {', '.join(dreaming.DREAM_ENGINES)}",
        )
    if shutil.which(engine) is None:
        raise HTTPException(
            status_code=400,
            detail=f"the {engine} CLI is not installed on this box (not found on PATH)",
        )
    feature_keys.persist("DREAM_ENGINE", engine)
    log.info("DREAM_ENGINE set to %r via Settings", engine)
    return _dream_engine_state()

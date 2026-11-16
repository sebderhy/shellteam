"""Settings endpoints: secrets (every key, ShellTeam's own included), auto-update, layout.

Owner-authed (same ``get_current_user`` gate as the other owner routes). The
dashboard Settings tab calls these same-origin, riding the HttpOnly session
cookie.
"""

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.dependencies import get_current_user
from api import config
from api.services import dreaming, feature_keys, secrets_vault, security_checks

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/settings", tags=["settings"])
security_router = APIRouter(prefix="/api/security", tags=["security"])


@security_router.get("/warnings")
async def get_security_warnings(user: dict = Depends(get_current_user)) -> dict:
    """Host-level security findings the dashboard shows as a banner (SHE-136):
    passwordless sudo for the owner, a Steel container off its isolated network."""
    return {"warnings": await asyncio.to_thread(security_checks.current)}


# ── Auto-update ──────────────────────────────────────────────────────────────
# The mode lives in .env (AUTO_UPDATE); scripts/self-update.sh re-reads it on
# every timer tick, so flipping it here takes effect without any restart.

AUTO_UPDATE_MODES = ("off", "daily", "weekly")


class SecretRequest(BaseModel):
    name: str = Field(..., min_length=1)
    value: str = Field(..., min_length=1)


@router.get("/secrets")
async def get_secrets(user: dict = Depends(get_current_user)) -> dict:
    """Vault names, last update and where each is used. Never values (SHE-135).
    ``suggestions``: ShellTeam's own keys first, then common keys with their
    usual name and where to get them."""
    return {"secrets": await asyncio.to_thread(_secret_rows),
            "suggestions": feature_keys.suggestions() + secrets_vault.SUGGESTIONS}


def _secret_rows() -> list[dict]:
    rows = secrets_vault.status()
    env_file = str(feature_keys.env_file_path())
    for row in rows:
        spec = feature_keys.by_env_var(row["name"])
        if spec:
            row["shellteam"] = {"label": spec.label, "hint": spec.hint}
        # ShellTeam's own .env reads as ShellTeam, not as a path.
        for use in row["uses"]:
            if use.get("file") == env_file:
                use["shellteam"] = True
    return rows


@router.post("/secrets")
async def set_secret(body: SecretRequest, user: dict = Depends(get_current_user)) -> dict:
    """Store a secret and push it to every file/app/command that uses it.

    One of ShellTeam's own keys is checked with its provider first (400 and
    nothing kept when it is refused), then kept in ShellTeam's .env too and
    put to work at once (SHE-203)."""
    spec = feature_keys.by_env_var(body.name)
    value = body.value.strip() if spec else body.value
    if spec and (error := await feature_keys.check(spec, value)):
        raise HTTPException(status_code=400, detail=error)
    env_file = feature_keys.env_file_path()
    try:
        results = await asyncio.to_thread(secrets_vault.set_secret, body.name, value)
        if spec:
            await asyncio.to_thread(secrets_vault.write_env, str(env_file), {body.name: body.name})
    except secrets_vault.SecretsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if spec:
        results = [r for r in results if r["target"] != str(env_file)]
        results.append(feature_keys.apply(spec, value))
    elif any(u.get("file") == str(env_file) and body.name in u["vars"].values()
             for u in secrets_vault.load()["uses"]):
        os.environ[body.name] = value   # ShellTeam reads it: live now, not at the next start
    return {"name": body.name, "results": results,
            "secrets": await asyncio.to_thread(_secret_rows)}


class RenameRequest(BaseModel):
    to: str = Field(..., min_length=1)


@router.post("/secrets/{name}/rename")
async def rename_secret(name: str, body: RenameRequest, user: dict = Depends(get_current_user)) -> dict:
    try:
        await asyncio.to_thread(secrets_vault.rename_secret, name, body.to)
    except secrets_vault.SecretsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"secrets": await asyncio.to_thread(_secret_rows)}


@router.delete("/secrets/{name}")
async def delete_secret(name: str, user: dict = Depends(get_current_user)) -> dict:
    try:
        await asyncio.to_thread(secrets_vault.delete_secret, name)
    except secrets_vault.SecretsError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if spec := feature_keys.by_env_var(name):
        feature_keys.apply(spec, "")   # ShellTeam stops using it too
    return {"secrets": await asyncio.to_thread(_secret_rows)}


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

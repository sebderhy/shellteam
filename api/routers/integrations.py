"""API endpoints for app integrations (Composio connected accounts)."""

import asyncio
import logging
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.config import APP_URL, RUNTIME
from api.dependencies import get_current_user
from api.services import composio as composio_svc
from api.services import credentials as credentials_svc
from api.services.mcp_refresh import refresh_composio_mcp
from api.services import runtime

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/integrations", tags=["integrations"])


def _cli_credential_target(user: dict) -> tuple[Path, str | None]:
    """Where CLI credentials land for this user.

    Native (OSS): the owner's real home; no container, so cron setup is skipped
    (``container_name=None``). Docker (Cloud): the bind-mounted home + the
    per-user container for ``docker exec`` cron installation.
    """
    home_dir = runtime.user_home_dir(user["id"])
    container_name = None
    return Path(home_dir), container_name


COMPOSIO_UNCONFIGURED_DETAIL = "Composio integration not configured (set COMPOSIO_API_KEY)"


def _require_composio_configured() -> None:
    """Gate every endpoint in this router on the composio module's API key.

    Without COMPOSIO_API_KEY the Composio SDK can only blow up deep inside a
    worker thread (a 500 + traceback in the logs). Surface a deliberate
    "module unavailable" 503 instead, so callers can tell "composio is off on
    this box" apart from a server bug. The key is read at request time so
    a key saved later (Settings → Feature keys) flips availability without a
    restart — same convention as ai_tools._require_env_key.
    """
    if not composio_svc.is_configured():
        log.info("/api/integrations called but COMPOSIO_API_KEY is not set — returning 503 (module unavailable)")
        raise HTTPException(status_code=503, detail=COMPOSIO_UNCONFIGURED_DETAIL)


TOOLKIT_RE = re.compile(r"^[a-z][a-z0-9_-]{0,49}$")

# Toolkits we deliberately don't expose via Composio. GitHub is excluded
# because Composio's managed OAuth App tokens have narrower scopes than
# user-issued PATs and re-injecting them clobbers manual `gh auth login`
# credentials. Users authenticate to GitHub directly with their own PAT.
BLOCKED_TOOLKITS = {"github"}


# -- Schemas --

class Connection(BaseModel):
    id: str
    toolkit: str
    status: str
    created_at: str | None = None


class ConnectResponse(BaseModel):
    redirect_url: str


class RequiredField(BaseModel):
    name: str
    displayName: str
    description: str
    type: str = "string"


class ConnectRequest(BaseModel):
    config_params: dict[str, str] | None = None


# -- Endpoints --

@router.get("", response_model=list[Connection])
async def list_integrations(
    user: dict = Depends(get_current_user),
):
    """List user's connected apps."""
    _require_composio_configured()
    connections = await asyncio.to_thread(composio_svc.list_connections, user["id"])
    return [Connection(**c) for c in connections]


@router.get("/connect/{toolkit}/fields", response_model=list[RequiredField])
async def get_connect_fields(
    toolkit: str,
    user: dict = Depends(get_current_user),
):
    """Get required fields for connecting a toolkit (empty = simple OAuth)."""
    _require_composio_configured()
    if not TOOLKIT_RE.match(toolkit):
        raise HTTPException(status_code=400, detail="Invalid toolkit slug")
    if toolkit in BLOCKED_TOOLKITS:
        raise HTTPException(status_code=400, detail=f"'{toolkit}' is not connectable via Composio")
    try:
        fields = await asyncio.to_thread(composio_svc.get_required_fields, toolkit)
    except Exception as e:
        log.warning("Failed to get fields for toolkit %r: %s", toolkit, e)
        raise HTTPException(status_code=400, detail=f"Unknown app '{toolkit}'")
    return [RequiredField(**f) for f in fields]


@router.post("/connect/{toolkit}", response_model=ConnectResponse)
async def connect_app(
    toolkit: str,
    body: ConnectRequest | None = None,
    user: dict = Depends(get_current_user),
):
    """Start OAuth flow for any Composio toolkit. Returns redirect URL."""
    _require_composio_configured()
    if not TOOLKIT_RE.match(toolkit):
        raise HTTPException(status_code=400, detail="Invalid toolkit slug")
    if toolkit in BLOCKED_TOOLKITS:
        raise HTTPException(status_code=400, detail=f"'{toolkit}' is not connectable via Composio")

    config_params = body.config_params if body else None
    try:
        redirect_url = await asyncio.to_thread(
            composio_svc.initiate_connection,
            user["id"],
            toolkit,
            f"{APP_URL}/?app_connected={toolkit}",
            config_params,
        )
    except Exception as e:
        log.warning("Composio connect failed for toolkit %r: %s", toolkit, e)
        msg = str(e)
        if hasattr(e, 'body') and isinstance(e.body, dict):
            err = e.body.get('error', {})
            msg = err.get('message', msg)
        raise HTTPException(status_code=400, detail=msg)
    if not redirect_url:
        raise HTTPException(status_code=502, detail="Failed to get redirect URL from Composio")
    return ConnectResponse(redirect_url=redirect_url)


@router.post("/sync-credentials")
async def sync_credentials(
    user: dict = Depends(get_current_user),
):
    """Inject CLI credentials and refresh Composio MCP session after OAuth."""
    _require_composio_configured()
    home_dir, container_name = _cli_credential_target(user)
    await asyncio.to_thread(credentials_svc.inject_all, home_dir, user["id"], container_name)
    await asyncio.to_thread(refresh_composio_mcp, user["id"], home_dir, user.get("email", ""))
    return {"status": "synced"}


@router.delete("/{connection_id}")
async def disconnect_app(
    connection_id: str,
    user: dict = Depends(get_current_user),
):
    """Disconnect an app (ownership verified via list). Revokes CLI credentials."""
    _require_composio_configured()
    # Verify the connection belongs to this user
    connections = await asyncio.to_thread(composio_svc.list_connections, user["id"])
    owned = {c["id"]: c for c in connections}
    if connection_id not in owned:
        raise HTTPException(status_code=404, detail="Connection not found")

    toolkit = owned[connection_id].get("toolkit", "")
    await asyncio.to_thread(composio_svc.disconnect, connection_id)

    # Revoke CLI credentials if this was a CLI-enabled toolkit
    home_dir, container_name = _cli_credential_target(user)
    if toolkit == credentials_svc.GOOGLE_TOOLKIT:
        await asyncio.to_thread(credentials_svc.revoke_google, home_dir, container_name)

    # Refresh MCP session so toolkit availability reflects the disconnect
    await asyncio.to_thread(refresh_composio_mcp, user["id"], home_dir, user.get("email", ""))

    return {"status": "disconnected"}

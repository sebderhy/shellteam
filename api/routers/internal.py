import asyncio
import os
import re
import logging
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from api.config import APP_DOMAIN, APP_URL, OWNER_ID, OWNER_USERNAME, RUNTIME
from api.services import runtime as containers, app_routes, ports, reports, composio as composio_svc
from api.services.internal_auth import verify_notify_token
from api.services.notify import send_notification
from api.services.ratelimit import RateLimiter

log = logging.getLogger(__name__)
router = APIRouter(prefix="/internal", tags=["internal"])
_escaped_domain = re.escape(APP_DOMAIN)

# Valid subdomain pattern for on-demand TLS validation. PINNED to the single
# owner's label (`owner.<domain>` + port previews `owner-<port>.<domain>`) — the
# only subdomains a single-user box ever serves. The old `[a-z][a-z0-9-]+?`
# accepted ANY label, so a stranger opening TLS with SNI `aaa1.<domain>`,
# `aaa2.<domain>`, … could trigger a fresh ACME order per name and burn the
# Let's Encrypt weekly quota, breaking cert issuance for the real host (M4).
_VALID_SUBDOMAIN_RE = re.compile(
    rf"^{re.escape(OWNER_USERNAME)}(?:-\d+)?\.{_escaped_domain}$"
)


def _require_loopback(request: Request) -> None:
    """Allow only requests originating on the box itself.

    Caddy forwards *all* public paths to this app, so `/internal/*` is
    internet-reachable — but requests proxied by Caddy carry the real client
    IP (uvicorn runs with --proxy-headers), while Caddy's own on_demand_tls
    `ask` probe connects directly from loopback. Reject anything else.
    """
    client_ip = request.client.host if request.client else ""
    if client_ip not in ("127.0.0.1", "::1"):
        log.warning("Loopback-only internal endpoint hit from %s — denied", client_ip)
        raise HTTPException(status_code=403, detail="Loopback only")


@router.get("/check-domain")
async def check_domain(request: Request, domain: str = Query(...)):
    """Validate whether Caddy should issue a TLS cert for this domain.

    Caddy's on_demand_tls calls this endpoint with ?domain=<fqdn>.
    Return 200 to allow, non-200 to deny.
    """
    _require_loopback(request)
    if domain == APP_DOMAIN:
        return Response(status_code=200)
    if _VALID_SUBDOMAIN_RE.match(domain):
        return Response(status_code=200)
    # A registered named app route (`<name>.<APP_DOMAIN>`) gets a cert; any
    # other label is refused so strangers cannot trigger ACME orders.
    label, dot, parent = domain.partition(".")
    if dot and parent == APP_DOMAIN and app_routes.port_for_name(OWNER_ID, label) is not None:
        return Response(status_code=200)
    raise HTTPException(status_code=403, detail="Domain not allowed")


# --- Port visibility (container-to-host) ---

class InternalPortRequest(BaseModel):
    port: int = Field(..., ge=1, le=65535)
    public: bool


class InternalPortCleanupRequest(BaseModel):
    idle_days: int = Field(..., ge=1, le=365)


@router.post("/ports")
async def set_port_visibility_internal(body: InternalPortRequest, request: Request):
    """Toggle port visibility from inside a container.

    Auth: per-user HMAC token + X-Shellteam-User-Id header.
    """
    user_id = _verify_internal_auth(request)
    try:
        result = ports.set_port_visibility(user_id, body.port, body.public)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"public_ports": sorted(result)}


@router.get("/ports/activity")
async def get_port_activity_internal(request: Request):
    user_id = _verify_internal_auth(request)
    return {
        "public_ports": sorted(ports.get_public_ports(user_id)),
        "activity": ports.get_port_activity(user_id),
    }


@router.post("/ports/cleanup")
async def cleanup_stale_ports_internal(body: InternalPortCleanupRequest, request: Request):
    user_id = _verify_internal_auth(request)
    cutoff = time.time() - (body.idle_days * 24 * 60 * 60)
    closed_ports = ports.cleanup_stale_public_ports(user_id, cutoff)
    return {"closed_ports": sorted(closed_ports)}


class InternalPortShareRequest(BaseModel):
    port: int | None = Field(None, ge=1024, le=65535)
    name: str | None = Field(None, min_length=1, max_length=64)
    ttl: int = Field(86400, ge=60, le=30 * 86400)


@router.post("/ports/share")
async def mint_port_share_internal(body: InternalPortShareRequest, request: Request):
    """Mint a signed, expiring share link for a running app — the in-box
    (agent) counterpart of ``GET /api/auth/share?port=``. Safer than flipping
    the port fully public: the link expires, and revocation is an OWNER_TOKEN
    rotation instead of remembering to toggle the port back.
    """
    from api.config import FILE_PORT, OWNER_TOKEN, reserved_service_ports
    from api.services.auth import sign_share_port

    user_id = _verify_internal_auth(request)
    if not OWNER_TOKEN:
        raise HTTPException(
            status_code=409,
            detail="No OWNER_TOKEN set — localhost-trust mode has no links to sign.",
        )
    # Share by name: the link lives on the named host, the grant is the port's.
    if body.name is not None:
        port = app_routes.port_for_name(user_id, body.name)
        if port is None:
            raise HTTPException(status_code=404, detail=f"No named route '{body.name}'")
        host = f"{body.name}.{APP_DOMAIN}"
    elif body.port is not None:
        port = body.port
        host = f"{OWNER_USERNAME}-{port}.{APP_DOMAIN}"
    else:
        raise HTTPException(status_code=422, detail="Give a port or a name")
    if port == FILE_PORT or port in reserved_service_ports():
        raise HTTPException(
            status_code=400,
            detail=f"Port {port} belongs to a ShellTeam service and cannot be shared",
        )
    exp = int(time.time()) + body.ttl
    sig = sign_share_port(port, exp)
    log.info("Minted port-share link for :%d on %s via /internal (ttl=%ss)", port, host, body.ttl)
    return {
        "url": f"https://{host}/?sig={sig}&exp={exp}",
        "expires_at": exp,
        "expires_in": body.ttl,
    }


# --- Named app routes (in-box → host) ---


class InternalAppRouteRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    port: int = Field(..., ge=1, le=65535)


@router.get("/apps")
async def list_app_routes_internal(request: Request):
    user_id = _verify_internal_auth(request)
    return {"apps": app_routes.describe(user_id)}


@router.post("/apps")
async def set_app_route_internal(body: InternalAppRouteRequest, request: Request):
    """Name a running app: `<name>.<APP_DOMAIN>` -> :port. Creates or repoints."""
    user_id = _verify_internal_auth(request)
    try:
        app_routes.set_route(user_id, body.name, body.port)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"apps": app_routes.describe(user_id)}


@router.delete("/apps/{name}")
async def remove_app_route_internal(name: str, request: Request):
    user_id = _verify_internal_auth(request)
    if not app_routes.remove_route(user_id, name):
        raise HTTPException(status_code=404, detail=f"No named route '{name}'")
    return {"apps": app_routes.describe(user_id)}


# --- Report visibility (in-box → host) ---

class InternalReportRequest(BaseModel):
    path: str = Field(..., min_length=1)
    public: bool


def _report_relpath(home_dir: Path, path: str) -> str:
    """Resolve a report path via the shared helper, mapping errors to HTTP codes."""
    try:
        return reports.resolve_report_path(home_dir, path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Report file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _publish_principal(request: Request) -> tuple[str, Path, str]:
    """Who is publishing, and into which scope: ``(scope, home_dir, url_prefix)``.

    The owner's in-box tooling (master / per-user token) publishes the owner's
    own home at ``https://APP_DOMAIN/<path>``. A guest's scoped publish token
    (org module) publishes that guest's SANDBOX home at
    ``https://APP_DOMAIN/_employee/<folder>/<path>`` — the scope comes from the
    token's holder and the registry, never from the request, so a guest cannot
    publish anyone else's files. Re-checked per request: the token rides in
    the container env until a recreate, so revoking the grant must bite here.
    """
    user_id = _verify_internal_auth(request)
    return user_id, containers.user_home_dir(user_id), f"{APP_URL}/"


@router.post("/reports")
async def set_report_visibility_internal(body: InternalReportRequest, request: Request):
    """Publish/unpublish a report file (make it reachable without cookie auth).

    Auth: master token (or per-user HMAC) + X-Shellteam-User-Id header — or a
    guest's scoped publish token (see ``_publish_principal``). Returns the URL
    the caller should hand out.
    """
    scope, home_dir, url_prefix = _publish_principal(request)
    relpath = _report_relpath(home_dir, body.path)
    try:
        result = reports.set_report_visibility(scope, relpath, body.public)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "path": relpath,
        "public": relpath in result,
        "public_reports": sorted(result),
        "url": f"{url_prefix}{relpath}",
    }


@router.get("/reports")
async def get_report_visibility_internal(request: Request, path: str = Query("")):
    """Return whether a report is public (if ``path`` given) + the full published set."""
    scope, _home, _prefix = _publish_principal(request)
    public_set = reports.get_public_reports(scope)
    is_public = None
    if path:
        rel = path.strip().lstrip("/")
        is_public = rel in public_set
    return {"path": path, "public": is_public, "public_reports": sorted(public_set)}


def _verify_internal_auth(request: Request) -> str:
    """Verify HMAC token + user_id header. Returns user_id. Raises HTTPException on failure."""
    from api.services.internal_auth import verify_token

    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    user_id = request.headers.get("X-Shellteam-User-Id", "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing X-Shellteam-User-Id")
    if not verify_token(token, user_id):
        raise HTTPException(status_code=401, detail="Invalid token")
    return user_id


# --- Google token refresh (container-to-host) ---

@router.post("/refresh-google-token")
async def refresh_google_token(request: Request):
    """Called by container cron to refresh Google OAuth token via Composio."""
    user_id = _verify_internal_auth(request)
    connections = await asyncio.to_thread(composio_svc.list_connections, user_id)
    google_conn = next((c for c in connections if c["toolkit"] == "googlesuper"), None)
    if not google_conn:
        log.warning("Google token refresh: no Google connection for user_id=%s", user_id)
        raise HTTPException(status_code=404, detail="No Google connection")

    creds = await asyncio.to_thread(composio_svc.refresh_and_get_credentials, google_conn["id"])
    if not creds or not creds.get("access_token"):
        log.error("Google token refresh: Composio returned no token for user_id=%s", user_id)
        raise HTTPException(status_code=502, detail="Failed to refresh token")
    log.info("Google token refreshed for user_id=%s", user_id)
    return {"access_token": creds["access_token"]}


# --- CLI credential sync (container-to-host) ---

@router.post("/sync-credentials")
async def sync_credentials_internal(request: Request):
    """Called by container agent after OAuth to inject CLI credentials and refresh MCP."""
    from api.services.credentials import inject_all
    from api.services.mcp_refresh import refresh_composio_mcp

    user_id = _verify_internal_auth(request)
    home_dir = containers.user_home_dir(user_id)
    container_name = None
    await asyncio.to_thread(inject_all, home_dir, user_id, container_name)
    await asyncio.to_thread(refresh_composio_mcp, user_id, home_dir)
    return {"status": "synced"}


# --- Owner notification (M0 §0.4) ---

class InternalNotifyRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    body: str = Field(..., min_length=1, max_length=4000)
    url: str | None = Field(None, max_length=2000)


_notify_limit = RateLimiter(rate=30, period=3600)  # 30/hour — guest ping abuse guard


@router.post("/notify")
async def notify_owner_internal(
    body: InternalNotifyRequest, request: Request, _rl=Depends(_notify_limit),
):
    """Send an owner notification (Telegram/ntfy, auto-detected).

    Auth: the master SHELLTEAM_AI_TOKEN **or** the scoped notify token
    (``verify_notify_token`` — the capability the guest env carries). The scoped
    token unlocks THIS endpoint only, so a guest can escalate to the owner without
    holding the master secret that would open the billable /internal/ai proxy.
    """
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not verify_notify_token(token):
        raise HTTPException(status_code=401, detail="Invalid token")

    result = await send_notification(body.title, body.body, body.url)
    return result

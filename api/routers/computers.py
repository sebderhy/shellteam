import json
import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api.config import APP_DOMAIN

# The cockpit (ai-chat) listens on AI_CHAT_PORT — keep this in lockstep with the
# port the cockpit binds (lib/constants.mjs honours the same env var).
COCKPIT_PORT = os.environ.get("AI_CHAT_PORT", "3456")
from api.dependencies import get_current_user, require_trusted_origin
from api.services import runtime as containers, activity, app_routes, ports, report_catalog, reports
from api.services.exposure_policy import require_public_sharing
from api.services.ratelimit import RateLimiter
from api.models.schemas import ComputerStatus

_start_limit = RateLimiter(rate=3, period=60, key="user")  # 3 req/min per user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/computers", tags=["computers"])
_STARTUP_BACKEND_ERRORS: tuple[type[Exception], ...] = ()


@router.post("", response_model=ComputerStatus)
async def start_computer(user: dict = Depends(get_current_user), _rl=Depends(_start_limit)):
    """Create or start the user's cloud computer."""
    profile = user["profile"]
    username = profile.get("username") if profile else None
    if not username:
        return ComputerStatus(status="error", container_id=None, username=None)

    try:
        result = await containers.start_computer(user["id"], username, email=user.get("email", ""))
    except TimeoutError:
        log.warning("Computer startup timed out for %s", user["id"])
        raise HTTPException(
            status_code=503,
            detail="Your computer is still starting up. Please try again in a few seconds.",
        )
    except _STARTUP_BACKEND_ERRORS as e:
        log.error("Runtime error starting computer for %s: %s", user["id"], e)
        raise HTTPException(status_code=500, detail="Failed to start computer. Please try again.")
    activity.touch(user["id"])
    return ComputerStatus(
        status=result["status"],
        container_id=result.get("container_id"),
        username=username,
        public_url=f"https://{username}.{APP_DOMAIN}",
    )


@router.delete("")
async def stop_computer(user: dict = Depends(get_current_user)):
    """Stop the user's cloud computer."""
    result = await containers.stop_computer(user["id"])
    return {"status": result["status"]}


@router.get("/status", response_model=ComputerStatus)
async def computer_status(user: dict = Depends(get_current_user)):
    """Get the current status of the user's cloud computer."""
    profile = user["profile"]
    username = profile.get("username") if profile else None
    result = await containers.get_status(user["id"])
    return ComputerStatus(
        status=result["status"],
        container_id=result.get("container_id"),
        username=username,
        public_url=f"https://{username}.{APP_DOMAIN}" if username else None,
    )


# --- Port visibility ---


class PortVisibilityRequest(BaseModel):
    port: int = Field(..., ge=1, le=65535)
    public: bool


@router.post("/ports")
async def set_port_visibility(body: PortVisibilityRequest, user: dict = Depends(get_current_user)):
    """Toggle public visibility for a port on the user's container."""
    if body.public:
        require_public_sharing()
    try:
        result = ports.set_port_visibility(user["id"], body.port, body.public)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"public_ports": sorted(result)}


@router.get("/ports")
async def list_public_ports(user: dict = Depends(get_current_user)):
    """List the user's publicly accessible ports."""
    return {"public_ports": sorted(ports.get_public_ports(user["id"]))}


# --- Named app routes (owner, cookie-authed — Settings card) ---


class AppRouteRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    port: int = Field(..., ge=1, le=65535)


@router.get("/apps")
async def list_app_routes(user: dict = Depends(get_current_user)):
    return {"apps": app_routes.describe(user["id"])}


@router.post("/apps", dependencies=[Depends(require_trusted_origin)])
async def set_app_route(body: AppRouteRequest, user: dict = Depends(get_current_user)):
    try:
        app_routes.set_route(user["id"], body.name, body.port)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"apps": app_routes.describe(user["id"])}


@router.delete("/apps/{name}", dependencies=[Depends(require_trusted_origin)])
async def remove_app_route(name: str, user: dict = Depends(get_current_user)):
    if not app_routes.remove_route(user["id"], name):
        raise HTTPException(status_code=404, detail=f"No named route '{name}'")
    return {"apps": app_routes.describe(user["id"])}


# --- Report visibility (owner, cookie-authed — used by the dashboard panel) ---


class ReportVisibilityRequest(BaseModel):
    path: str = Field(..., min_length=1)
    public: bool


def _resolve_report(user_id: str, path: str, owner_initiated: bool = False) -> str:
    try:
        return reports.resolve_report_path(
            containers.user_home_dir(user_id), path, owner_initiated=owner_initiated
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Report file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/reports", dependencies=[Depends(require_trusted_origin)])
async def set_report_visibility(body: ReportVisibilityRequest, user: dict = Depends(get_current_user)):
    """Publish/unpublish a file (owner-only, dashboard origin only).

    Origin-gated because this route authenticates on the ambient master cookie
    and now publishes anywhere under home: `SameSite=lax` does NOT stop a
    *same-site* subdomain, and content subdomains serve untrusted
    agent-generated HTML. The owner's own click is the only thing that may
    reach it (in-box agents go through /internal/reports, which stays confined
    to reports/ and public/).
    """
    if body.public:
        require_public_sharing()
    relpath = _resolve_report(user["id"], body.path, owner_initiated=True)
    try:
        result = reports.set_report_visibility(user["id"], relpath, body.public)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"path": relpath, "public": relpath in result}


@router.get("/reports")
async def get_report_visibility(path: str = "", user: dict = Depends(get_current_user)):
    """Report visibility: the published set, plus the state of ``path`` if given."""
    public_set = reports.get_public_reports(user["id"])
    rel = path.strip().lstrip("/") if path else ""
    return {
        "path": path,
        "public": (rel in public_set) if rel else None,
        "public_reports": sorted(public_set),
    }


@router.get("/reports/list")
def list_report_catalog(probe: int = 0, user: dict = Depends(get_current_user)):
    """The Reports tab's data: every ``~/reports`` file, grouped-by-workspace.

    ``?probe=1`` is the dashboard's cheap tab-reveal check (file count only —
    no transcript scan). The full listing refreshes the workspace-attribution
    index, which reads agent transcripts; sync ``def`` on purpose so FastAPI
    runs it in the threadpool and a first-ever scan can't block the loop.
    """
    home = containers.user_home_dir(user["id"])
    if probe:
        return {"count": report_catalog.count_reports(home)}
    entries = report_catalog.list_reports(user["id"], home)
    for e in entries:
        e["public"] = reports.is_report_public(user["id"], e["path"])
    return {"reports": entries, "count": len(entries)}


@router.get("/exposure")
async def get_exposure(request: Request, user: dict = Depends(get_current_user)):
    """Every world-readable URL the box currently serves (owner-only).

    The answer to "what have I published?" — published files and directories,
    with a per-directory file count and absolute URLs ready to click. Backs the
    dashboard's Exposure panel; also the CLI/boot-log inventory (F3)."""
    home = containers.user_home_dir(user["id"])
    entries = reports.exposure(user["id"], home)
    base = f"{request.url.scheme}://{request.url.netloc}"
    for e in entries:
        e["url"] = f"{base}/{e['path']}"
    return {"exposed": entries, "count": len(entries)}


# NOTE: the old POST /profile endpoint (onboarding profile → ~/.claude/CLAUDE.md)
# was removed: it wrote directly into the owner's real Claude config, violating
# the additive-layer hard rule (docs/design/vps-footprint.md), and nothing
# called it. Profile facts belong in the agent layer, never in user dotfiles.


# --- AI chat proxy (forwards to container's ai-chat on port 3456) ---


@router.api_route("/ai/{path:path}", methods=["GET", "POST"])
async def proxy_ai_chat(path: str, request: Request, user: dict = Depends(get_current_user)):
    """Proxy requests to the cockpit's (ai-chat) HTTP API for credential setup.

    The dashboard's AI-Providers panel calls this same-origin (so the OWNER_TOKEN
    cookie/header is enforced here) and we forward to the loopback cockpit. The
    ``status`` response is enriched with ``openCodeAvailable`` — the cockpit can't
    know whether the control plane holds a Fireworks key, but we do, and the
    OpenCode universal fallback only actually works when that key is configured.
    """
    ip = await containers.get_container_ip(user["id"])
    if not ip:
        raise HTTPException(status_code=503, detail="Container not running")
    query = request.url.query
    url = f"http://{ip}:{COCKPIT_PORT}/api/{path}"
    if query:
        url = f"{url}?{query}"
    body = await request.body()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(
            request.method, url,
            content=body if body else None,
            headers={"Content-Type": "application/json"} if body else {},
        )

    content = resp.content
    if path == "status" and resp.status_code == 200:
        try:
            data = resp.json()
            data["openCodeAvailable"] = bool(os.environ.get("FIREWORKS_API_KEY"))
            content = json.dumps(data).encode()
        except ValueError:
            log.warning("ai status: cockpit returned non-JSON; passing through unmodified")

    return Response(content=content, status_code=resp.status_code,
                    media_type="application/json")


# --- Same-origin cockpit proxy (the GitHub connect widget) -----------------------

_COCKPIT_HOP_HEADERS = {"transfer-encoding", "content-encoding", "content-length", "connection", "keep-alive"}


@router.api_route("/cockpit/{path:path}", methods=["GET", "POST"])
async def proxy_cockpit(path: str, request: Request, user: dict = Depends(get_current_user)):
    """Serve a cockpit page/endpoint SAME-ORIGIN, master-gated.

    The GitHub connect card (``github.html`` + its ``api/github/*`` calls) used to
    load cross-origin from ``owner-<port>.APP_DOMAIN``, which made a core
    onboarding surface depend on wildcard DNS + a wildcard cert + cross-origin
    cookie delivery — all of which can be absent on a fresh ``--domain`` install,
    leaving the widget a blank frame. Framing it here instead (``/api/computers/
    cockpit/github.html``) keeps it on the dashboard origin: the HttpOnly master
    cookie is enforced by ``get_current_user`` and the widget's relative fetches
    resolve under the same prefix, so no wildcard is needed. Only the static,
    self-contained connect page is framed this way — the agent chat SPA (which
    renders untrusted model output) stays on its cookie-isolated subdomain, so
    this path never lets served/agent content reach the master cookie.
    """
    ip = await containers.get_container_ip(user["id"])
    if not ip:
        raise HTTPException(status_code=503, detail="Cockpit not running")
    url = f"http://{ip}:{COCKPIT_PORT}/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    body = await request.body()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(
            request.method, url,
            content=body if body else None,
            headers={"Content-Type": request.headers.get("content-type", "application/json")} if body else {},
        )
    headers = {k: v for k, v in resp.headers.items() if k.lower() not in _COCKPIT_HOP_HEADERS}
    return Response(content=resp.content, status_code=resp.status_code, headers=headers)

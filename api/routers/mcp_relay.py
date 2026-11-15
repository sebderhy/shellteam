"""``/internal/mcp/*``: the relay agents use for MCP servers that need a key
(SHE-203, see api/services/mcp_relay.py).

Streamable HTTP is forwarded as it comes: POST, the GET event stream and the
DELETE that ends a session, with the session headers both ways. Callers must be on
this box and present the relay token; the token is never forwarded; the key is added here and never
returned or logged.
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from api.routers.internal import _require_loopback
from api.services import internal_auth, mcp_relay

log = logging.getLogger(__name__)
router = APIRouter(prefix="/internal/mcp", tags=["mcp-relay"])

_FORWARD_REQUEST = ("content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id")
_FORWARD_RESPONSE = ("content-type", "mcp-session-id", "mcp-protocol-version", "cache-control")
_TIMEOUT = httpx.Timeout(connect=15.0, read=None, write=60.0, pool=15.0)


def _authorize(request: Request) -> None:
    # Agents call from this box; a relay token that leaks is useless elsewhere.
    _require_loopback(request)
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    if not internal_auth.verify_mcp_relay_token(token):
        raise HTTPException(status_code=401, detail="Invalid token")


async def _relay(request: Request, server: str, project: str = "") -> StreamingResponse | JSONResponse:
    _authorize(request)
    if server not in mcp_relay.SERVERS or (project and (server != "linear" or not mcp_relay.valid_project(project))):
        raise HTTPException(status_code=404, detail="No such MCP server")
    try:
        url, key_headers = mcp_relay.upstream(server, project)
    except mcp_relay.MissingKey as missing:
        log.warning("MCP relay: %s asked for but %s is not set", server, missing)
        return JSONResponse(status_code=503, content={"error": (
            f"{missing} is not set on this box. Add it in Settings → Secrets; "
            "the next call uses it, no restart needed.")})

    headers = {h: v for h in _FORWARD_REQUEST if (v := request.headers.get(h))}
    headers.update(key_headers)
    client = httpx.AsyncClient(timeout=_TIMEOUT)
    try:
        upstream = await client.send(
            client.build_request(request.method, url, headers=headers, content=await request.body()),
            stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        # Never the exception text: httpx can quote request headers, the key among them.
        log.warning("MCP relay: %s unreachable (%s)", server, type(e).__name__)
        return JSONResponse(status_code=502, content={"error": f"Could not reach {server} ({type(e).__name__})."})

    log.info("MCP relay: %s %s%s -> %d", request.method, server, f"/{project}" if project else "",
             upstream.status_code)

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    out = {h: v for h in _FORWARD_RESPONSE if (v := upstream.headers.get(h))}
    return StreamingResponse(body(), status_code=upstream.status_code, headers=out)


@router.api_route("/{server}", methods=["GET", "POST", "DELETE"])
async def relay(request: Request, server: str):
    return await _relay(request, server)


@router.api_route("/{server}/{project}", methods=["GET", "POST", "DELETE"])
async def relay_for_project(request: Request, server: str, project: str):
    return await _relay(request, server, project)

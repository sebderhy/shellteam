"""Proxy wildcard subdomain requests to user containers.

Handles:
  {username}.{APP_DOMAIN}/public/ → container port 80 (no auth, public folder)
  {username}.{APP_DOMAIN}/* → container port 80 (auth required, owner only)
  {username}-{port}.{APP_DOMAIN} → container:{port} (auth required, owner only)
  WebSocket connections are also proxied with cookie-based auth.
"""

import asyncio
import html as html_mod
import re
import logging
import time
from urllib.parse import quote, unquote

import httpx
import websockets

from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

from api.config import (
    API_PORT,
    APP_DOMAIN,
    FILE_PORT,
    HOME_DIR,
    MAIN_HOSTS,
    OWNER_ID,
    OWNER_TOKEN,
    OWNER_USERNAME,
    SHARE_FOOTER,
    reserved_service_ports,
)
from api.services.auth import (
    FILES_COOKIE,
    MASTER_COOKIE,
    PORT_SHARE_COOKIE,
    get_token_from_request,
    port_share_cookie_value,
    verify_port_share_cookie,
    verify_share_port_sig,
    origin_is_trusted,
    request_grants_files_read,
    token_grants_files_read,
    token_is_owner,
    verify_share_sig,
    verify_token,
)
from api.services.runtime import resolve_username_owner, start_computer
from api.services import activity, app_routes, content_inline, ports, reports
from api.services.ratelimit import note_unpublished_read

log = logging.getLogger(__name__)
router = APIRouter(tags=["proxy"])
# Separate router for specific API endpoints (avoid catch-all conflict)
_escaped_domain = re.escape(APP_DOMAIN)

# Match: alice.localhost or alice-3000.localhost
SUBDOMAIN_RE = re.compile(
    rf"^(?P<username>[a-z][a-z0-9-]+?)(?:-(?P<port>\d+))?\.{_escaped_domain}$"
)
RESERVED_SUBDOMAINS = {"app", "api", "www"}


def resolve_host(host: str) -> tuple[str, int] | None:
    """Map a subdomain host to ``(username, port)``, or None when it is not one.

    ``<owner>.<APP_DOMAIN>`` is the file host, ``<label>-<port>.<APP_DOMAIN>`` a
    port preview, and a bare ``<name>.<APP_DOMAIN>`` whose label is a registered
    named app route resolves to that route's port under the OWNER — so a named
    host and its port host are the same app to every gate downstream
    (docs/decisions/20260909-named-app-routes.md). An unregistered label keeps
    the legacy meaning (a username on the file port) so nothing else changes.
    """
    m = SUBDOMAIN_RE.match(host)
    if not m:
        return None
    username = m.group("username")
    if m.group("port"):
        return username, int(m.group("port"))
    if username != OWNER_USERNAME and username not in RESERVED_SUBDOMAINS:
        named = app_routes.port_for_name(OWNER_ID, username)
        if named is not None:
            return OWNER_USERNAME, named
    return username, FILE_PORT

_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
}

def _get_client_ip(request: Request) -> str | None:
    """The real client IP, from uvicorn's validated transport peer — NOT a raw
    header.

    The in-box trust shortcut (auth is skipped when the client IP equals the
    loopback backend) MUST derive from a value the client cannot forge.
    ``request.client.host`` is exactly that: with ``--forwarded-allow-ips
    127.0.0.1`` (the shipped systemd unit) uvicorn rewrites it from
    ``X-Forwarded-For`` only when the immediate peer is trusted (Caddy on
    loopback), and ignores an attacker's ``X-Forwarded-For`` on a direct hit to
    an exposed port. Reading the raw header instead let a spoofed
    ``X-Forwarded-For: 127.0.0.1`` claim in-box trust the moment the port was
    ever exposed (a second proxy hop, an XFF-replacing front, or a non-loopback
    bind) — an unauthenticated compromise one deployment mistake away. The rate
    limiter already keys on ``request.client.host`` for the same reason."""
    return request.client.host if request.client else None


def _has_path_traversal(path: str) -> bool:
    """Reject only actual traversal segments, not filenames that merely contain '..'."""
    decoded_path = unquote(path)
    if "\x00" in decoded_path:
        return True
    return any(segment == ".." for segment in decoded_path.split("/"))


# ShellTeam's own platform cookies — never forwarded to proxied apps (a leaked
# credential in an app's request log is replayable until expiry). Every cookie
# constant the box sets MUST be listed here; the test asserts each one by name.
# "shellteam_guest" is stripped unconditionally (not gated on the org module):
# a platform-named credential must never reach an app on any edition.
_SESSION_COOKIES = [MASTER_COOKIE, FILES_COOKIE, PORT_SHARE_COOKIE, "shellteam_guest"]


def _sanitize_forwarded_headers(request: Request) -> dict[str, str]:
    """Forward application headers, but strip hop-by-hop and platform auth state."""
    headers: dict[str, str] = {}
    for key, value in request.headers.items():
        lower = key.lower()
        if lower in _HOP_BY_HOP_HEADERS:
            continue
        # Drop every client-supplied forwarding/trust header. The cockpit gates its
        # file-write API on `X-Forwarded-By: nginx` — set by the file-server nginx
        # DOWNSTREAM of this proxy — so a client that smuggles its own
        # `X-Forwarded-By: nginx` (or spoofed X-Forwarded-For) through the subdomain
        # proxy must not have it reach the upstream and escalate a read-only files
        # credential toward file-write / RCE (M1). Legit hops re-add their own.
        if lower.startswith("x-forwarded-") or lower in ("x-real-ip", "forwarded"):
            continue
        if lower == "cookie":
            forwarded = _strip_session_cookies(value)
            if forwarded:
                headers[key] = forwarded
            continue
        headers[key] = value
    return headers


def _strip_session_cookies(cookie_header: str) -> str:
    """Return a Cookie header with every ShellTeam platform cookie removed,
    the app's own cookies preserved. Single source of truth for HTTP and WS."""
    kept = []
    for part in cookie_header.split(";"):
        part = part.strip()
        if not part or any(part.startswith(f"{c}=") for c in _SESSION_COOKIES):
            continue
        kept.append(part)
    return "; ".join(kept)


def _sanitized_ws_upstream_headers(headers_dict: dict) -> dict[str, str]:
    """Headers to forward on the upstream WebSocket connect.

    The blunt old rule was "send nothing", which stripped the APP's own session
    cookie on upgrade — so an authenticated app socket (Socket.IO, Django
    Channels) that worked over HTTP broke the moment it upgraded. Mirror the
    HTTP sanitizer: forward the app's own cookies and Origin (apps validate it),
    strip every ShellTeam credential and every spoofable forwarding header.
    `websockets` sets Host/Sec-WebSocket-* itself, so we never pass those."""
    out: dict[str, str] = {}
    raw_cookie = headers_dict.get(b"cookie", b"").decode()
    app_cookies = _strip_session_cookies(raw_cookie)
    if app_cookies:
        out["Cookie"] = app_cookies
    origin = headers_dict.get(b"origin", b"").decode()
    if origin:
        out["Origin"] = origin
    return out


_PAGE_STYLE = (
    "background:#0a0a0a;color:#888;display:flex;align-items:center;"
    "justify-content:center;height:100vh;font-family:sans-serif"
)


def _styled_error(title: str, message: str, status_code: int = 503) -> Response:
    """Return a branded HTML error page with consistent styling."""
    cockpit_url = f"https://{APP_DOMAIN}/"
    return Response(
        status_code=status_code,
        content=(
            f"<html><head><title>{title}</title></head>"
            f"<body style='{_PAGE_STYLE}'>"
            f"<div style='text-align:center;max-width:460px;padding:0 20px'>"
            f"<h2 style='color:#f5f5f5'>{title}</h2>"
            f"<p>{message}</p>"
            f"<p style='margin-top:1.5em'>"
            f"<a href='{cockpit_url}' style='color:#f59e0b;text-decoration:underline'>Go to cockpit</a>"
            f"</p></div></body></html>"
        ),
        media_type="text/html",
    )


def _offline_response(username: str) -> Response:
    safe = html_mod.escape(username)
    return _styled_error(
        "Computer offline",
        f"{safe}'s computer is currently off. Start it from the cockpit to access this page.",
    )


def _starting_response(username: str) -> Response:
    safe = html_mod.escape(username)
    cockpit_url = f"https://{APP_DOMAIN}/"
    return Response(
        status_code=503,
        content=(
            f"<html><head><title>Starting up…</title>"
            f"<meta http-equiv='refresh' content='3'>"
            f"<style>"
            f"@keyframes spin {{ to {{ transform: rotate(360deg) }} }}"
            f".spinner {{ display:inline-block;width:24px;height:24px;"
            f"border:3px solid #333;border-top-color:#f59e0b;border-radius:50%;"
            f"animation:spin .8s linear infinite }}"
            f"</style></head>"
            f"<body style='{_PAGE_STYLE}'>"
            f"<div style='text-align:center;max-width:460px;padding:0 20px'>"
            f"<div class='spinner' style='margin:0 auto 1em'></div>"
            f"<h2 style='color:#f5f5f5'>Starting {safe}'s computer…</h2>"
            f"<p>This page will refresh automatically.</p>"
            f"<p style='margin-top:1.5em'>"
            f"<a href='{cockpit_url}' style='color:#f59e0b;text-decoration:underline'>Go to cockpit</a>"
            f"</p></div></body></html>"
        ),
        media_type="text/html",
    )


async def _auto_start_container(user_id: str, username: str) -> None:
    """Fire-and-forget: start a stopped container in the background."""
    try:
        log.info("Auto-starting container for %s via proxy", username)
        await start_computer(user_id, username)
    except Exception:
        log.exception("Failed to auto-start container for %s", username)


def _login_required_response() -> Response:
    return _styled_error(
        "Sign in required",
        "This page is private. Sign in to ShellTeam first, then come back.",
        status_code=401,
    )


def _forbidden_response() -> Response:
    return _styled_error(
        "Access denied",
        "This page is private and belongs to another user.",
        status_code=403,
    )


AUTH_OK = "ok"
AUTH_NO_TOKEN = "no_token"
AUTH_BAD_TOKEN = "bad_token"
AUTH_FORBIDDEN = "forbidden"

# Methods the derived files credential may use (read-only capability). OPTIONS is
# included: it is side-effect-free and preflights must not 401 before the browser
# even sends the real request.
READ_METHODS = {"GET", "HEAD", "OPTIONS"}
# Sentinel for WebSocket upgrades in _authorize — a WS is never "read-only"
# (a socket to the cockpit drives agents), so it follows the mutating rules.
WS_METHOD = "WEBSOCKET"


def _is_public_path(path: str, port: int, owner_id: str | None = None) -> bool:
    """True when ``path`` on the file-server port is world-readable.

    ~/public is no longer an ambient grant (exposure-audit F4): a path is public
    only when it (or a parent directory) has been explicitly published through
    the owner-authed toggle. Reused by both the subdomain HTTP and WS gates.
    """
    if port != FILE_PORT or not owner_id:
        return False
    return reports.is_report_public(owner_id, path.lstrip("/"))


def _extract_cookie(cookie_header: str, name: str) -> str | None:
    """Parse one cookie out of a raw Cookie header (used for WS scope)."""
    prefix = f"{name}="
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith(prefix):
            return part[len(prefix):]
    return None


def _origin_is_owner_app_sibling(origin: str | None, target_port: int) -> bool:
    """True when ``origin`` is one of the OWNER's own NON-RESERVED app ports and
    the target is another non-reserved app port.

    This is the "full-stack app" trust edge: the owner's frontend on
    ``owner-5173`` calling its backend on ``owner-4000`` is same-owner traffic
    between two of their own app servers. Both ports must be non-reserved and
    non-file — so this never widens to the cockpit, the file host, or the
    control plane (the M1 escalation an XSS'd report page targets stays refused,
    because its origin is the FILE host, which is excluded here, and the cockpit
    is a reserved target, also excluded)."""
    if not origin:
        return False
    if target_port == FILE_PORT or target_port in reserved_service_ports():
        return False
    try:
        host = origin.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0].lower()
    except IndexError:
        return False
    resolved = resolve_host(host)
    if not resolved or resolved[0] != OWNER_USERNAME:
        return False
    origin_port = resolved[1]
    return origin_port != FILE_PORT and origin_port not in reserved_service_ports()


def _origin_trusted(origin: str | None, request_host: str) -> bool:
    """May a browser context perform non-read actions with the files credential?

    Trusted: a dashboard host (``MAIN_HOSTS`` — APP_DOMAIN, localhost, 127.0.0.1,
    VPS_IP, and any ``EXTRA_MAIN_HOSTS``) and the requested subdomain's own origin
    (the cockpit's/app's own JS calling itself). Everything else — e.g. an XSS'd
    report page on the file subdomain riding the ambient cookie into the cockpit —
    is refused. Requests WITHOUT an Origin header pass: browsers always attach
    Origin to cross-origin fetch/POST/WebSocket, so its absence means a non-browser
    client, which can only hold the HttpOnly credential legitimately.

    Uses ``MAIN_HOSTS`` (not just APP_DOMAIN) so localhost/VPS-IP dashboards work,
    and a deployment that serves the dashboard at a non-default host can add it via
    ``EXTRA_MAIN_HOSTS`` — otherwise a subdomain-hosted dashboard's direct
    dashboard→cockpit cross-origin calls would be refused. (Today the dashboard
    only reaches the cockpit same-origin via ``/api/computers/ai/*`` + the iframe's
    own WS, so this is belt-and-suspenders.)
    """
    if not origin:
        return True
    try:
        host = origin.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0].lower()
    except IndexError:
        return False
    return host in MAIN_HOSTS or host == request_host




def _authorize(
    master: str | None,
    files_cred: str | None,
    owner_id: str,
    port: int,
    method: str,
    origin: str | None,
    request_host: str,
    guest_cred: str | None = None,
) -> str:
    """Split-credential gate for subdomain requests. Returns an AUTH_* code.

    - The MASTER token grants everything (it normally lives host-only on the
      dashboard, but Bearer callers and pre-split cookies still present it here).
    - The derived FILES credential is read-only on the file host, and unlocks
      other ports (cockpit, agent apps) only from a trusted browser origin —
      so a compromised served page can neither write files nor reach the agents.
    """
    if not OWNER_TOKEN:
        # Localhost-trust mode: with OWNER_TOKEN unset there is no credential to
        # present, so skip the token requirement — but STILL apply the same
        # read-only + trusted-origin gates the files credential gets. The box is
        # loopback-bound, yet *.localhost resolves to 127.0.0.1 in the browser,
        # so without these a page the owner visits (evil.com) could ride a
        # cross-origin WebSocket/POST into the cockpit or file host (CSRF /
        # DNS-rebind). Legit same-origin and header-less GETs still pass, so
        # `owner.localhost` files and `owner-<port>.localhost` previews work.
        if port == FILE_PORT and method not in READ_METHODS:
            log.warning(
                "Trust mode: refused non-read %s on file host %s (read-only)",
                method, request_host,
            )
            return AUTH_FORBIDDEN
        if not _origin_trusted(origin, request_host):
            log.warning(
                "Trust mode: refused %s:%s — untrusted Origin %r",
                request_host, port, origin,
            )
            return AUTH_FORBIDDEN
        return AUTH_OK

    if master:
        try:
            payload = verify_token(master)
        except Exception:
            payload = None
        if payload is not None:
            return AUTH_OK if payload.get("sub") == owner_id else AUTH_FORBIDDEN

    if files_cred and token_grants_files_read(files_cred):
        # STRICTLY read-only on the FILE host: the files credential must never
        # write the owner's files.
        if port == FILE_PORT and method not in READ_METHODS:
            log.warning(
                "Files credential refused non-read %s on file host %s (read-only)",
                method, request_host,
            )
            return AUTH_FORBIDDEN
        # On the OTHER ports (cockpit, agent apps) the files credential is the
        # only credential the browser holds: the master cookie is host-only on the
        # dashboard, and the cockpit is served as a cross-origin sibling at
        # `<owner>-<AI_CHAT_PORT>.<APP_DOMAIN>`, so its own WebSocket authenticates
        # with the files cookie. Blanket-refusing non-read methods here (the M1
        # hardening) therefore killed the live cockpit socket while the unit tests
        # stayed green. ORIGIN — not method — is the real boundary on these ports:
        # the XSS'd-report-page escalation M1 targeted is cross-origin and is
        # refused by the _origin_trusted gate below.
        #
        # Mutations/WS additionally require an EXPLICITLY trusted Origin. Browsers
        # always attach Origin to WS/POST/fetch, so a header-less mutation is never
        # a legitimate browser flow — refusing it keeps M1's defense-in-depth
        # against a non-browser client that exfiltrated the cookie, without
        # breaking the cockpit. (Reads keep the lenient rule: header-less top-level
        # navigations are how files and app previews are opened.)
        if method not in READ_METHODS and not origin:
            log.warning(
                "Files credential refused non-read %s on %s:%s — no Origin",
                method, request_host, port,
            )
            return AUTH_FORBIDDEN
        # Trusted origins: a dashboard host, the port's own origin, OR another
        # of the owner's own app ports (their frontend calling their backend).
        # The sibling edge is what makes a two-private-port app work; it is
        # narrowed to non-reserved app ports on both ends, so it never reaches
        # the cockpit/file host.
        if not (
            _origin_trusted(origin, request_host)
            or _origin_is_owner_app_sibling(origin, port)
        ):
            log.warning(
                "Files credential refused on %s:%s — untrusted Origin %r",
                request_host, port, origin,
            )
            return AUTH_FORBIDDEN
        return AUTH_OK


    return AUTH_BAD_TOKEN if (master or files_cred or guest_cred) else AUTH_NO_TOKEN


def _copy_upstream_headers(resp: httpx.Response, response: Response, exclude: tuple[str, ...]) -> None:
    """Copy upstream headers preserving DUPLICATES. A dict comprehension here
    collapsed multiple ``Set-Cookie`` values into one comma-joined header — an
    app that sets a session cookie and a CSRF cookie in the same response had
    both corrupted through the proxy."""
    for k, v in resp.headers.multi_items():
        if k.lower() in exclude:
            continue
        response.headers.append(k, v)


async def _forward_http(
    request: Request, target_url: str, stream: bool = False
) -> tuple[Response, bool]:
    """Forward the request to ``target_url`` and build the outbound response.

    Returns ``(response, upstream_reached)`` — ``upstream_reached`` is False when
    the target could not be contacted (the response is then a styled error page).

    ``stream=False`` (the file-server path): body fully buffered, httpx
    auto-decompresses gzip/br so content-encoding must be stripped or browsers
    raise ERR_CONTENT_DECODING_FAILED. Buffering is required there anyway — the
    share footer and image inlining rewrite the body.

    ``stream=True`` (user app ports): the body is passed through raw as it
    arrives, so SSE, chunked responses and long downloads work; the read timeout
    is generous instead of 30s (an LLM app streaming for minutes is normal).
    Raw passthrough means content-encoding/content-length stay intact — only the
    transport framing (transfer-encoding) is ours to manage.
    """
    from starlette.background import BackgroundTask
    from starlette.responses import StreamingResponse

    if request.url.query:
        target_url += f"?{request.url.query}"
    body = await request.body()
    headers = _sanitize_forwarded_headers(request)

    if not stream:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.request(
                    method=request.method,
                    url=target_url,
                    content=body,
                    headers=headers,
                )
        except httpx.TimeoutException as e:
            log.warning("Timeout reaching %s — %s", target_url, e)
            return _styled_error(
                "Request timed out",
                "The computer took too long to respond. It may be under heavy load — try again in a moment.",
                status_code=504,
            ), False
        except httpx.HTTPError as e:
            log.warning("Cannot reach %s — %s", target_url, e)
            return _styled_error(
                "Computer unreachable",
                "Could not connect to the computer. It may be starting up — try refreshing in a few seconds.",
                status_code=502,
            ), False
        response = Response(content=resp.content, status_code=resp.status_code)
        _copy_upstream_headers(
            resp, response,
            exclude=("transfer-encoding", "content-encoding", "content-length", "connection", "keep-alive"),
        )
        return response, True

    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=15.0, read=3600.0, write=3600.0, pool=15.0)
    )
    try:
        upstream = client.build_request(
            method=request.method, url=target_url, content=body, headers=headers
        )
        resp = await client.send(upstream, stream=True)
    except httpx.TimeoutException as e:
        await client.aclose()
        log.warning("Timeout reaching %s — %s", target_url, e)
        return _styled_error(
            "Request timed out",
            "The app took too long to respond. It may be under heavy load — try again in a moment.",
            status_code=504,
        ), False
    except httpx.HTTPError as e:
        await client.aclose()
        log.warning("Cannot reach %s — %s", target_url, e)
        return _styled_error(
            "App unreachable",
            "Could not connect to the app on this port. Is the server running?",
            status_code=502,
        ), False

    async def _close() -> None:
        await resp.aclose()
        await client.aclose()

    response = StreamingResponse(
        resp.aiter_raw(),
        status_code=resp.status_code,
        background=BackgroundTask(_close),
    )
    # `date`/`server` excluded: uvicorn stamps its own on every response, so
    # copying the upstream's yields duplicate headers (observed live).
    _copy_upstream_headers(
        resp, response,
        exclude=("transfer-encoding", "connection", "keep-alive", "date", "server"),
    )
    return response, True


def _is_dotfile_path(path: str) -> bool:
    """True when any path segment is a dotfile/dir (.env, .ssh, .claude, …)."""
    return any(seg.startswith(".") for seg in unquote(path).split("/") if seg)


# Quiet, self-contained (inline styles, color:inherit + opacity so it reads on
# dark and light reports alike) — appended before </body> on shared HTML.
_SHARE_FOOTER_HTML = (
    '<div style="margin:48px auto 24px;padding:0 16px;max-width:720px;'
    "text-align:center;font:12px/1.6 system-ui,-apple-system,sans-serif;"
    'color:inherit;opacity:.55">Made with '
    '<a href="https://shellteam.sh" style="color:inherit;font-weight:600">ShellTeam</a>'
    " — your own AI cloud computer</div>"
)


def _share_footer_applies(request: Request, published: bool, via_share_sig: bool, relpath: str = "") -> bool:
    """Badge only what a third party sees — a published report or a signed share
    link — never the owner's own view, and never ``~/public`` hosting (portfolios
    and demo sites stay unbadged) (docs/decisions/20260715-share-footer.md)."""
    if not SHARE_FOOTER or request.method != "GET":
        return False
    rel = relpath.lstrip("/")
    if rel == "public" or rel.startswith("public/"):
        return False
    if via_share_sig:
        return True
    return published and not request_grants_files_read(request)


def _inline_sandboxed_images(request: Request, response: Response, relpath: str) -> Response:
    """Inline same-subtree images into HTML that will be content-sandboxed.

    The sandbox CSP (opaque origin) makes the browser CORS-block every
    subresource of a served report, so relative ``<img>`` refs render broken
    outside the cockpit panel — see api/services/content_inline.py for the full
    rationale and the safety bounds. Non-sandboxed responses (the trusted file
    UI, dashboard pages) and non-HTML pass through untouched, so this can never
    alter a page whose subresources already load.
    """
    ctype = response.headers.get("content-type", "")
    if (
        request.method != "GET"
        or response.status_code != 200
        or not ctype.lower().startswith("text/html")
    ):
        return response
    # Late import: api.main imports this router at startup, so the predicate is
    # pulled at request time to reuse the single sandbox definition without a
    # circular module import.
    from api.main import _wants_content_sandbox

    if not _wants_content_sandbox(request, response):
        return response
    body = content_inline.inline_local_images(response.body, relpath, HOME_DIR)
    if body is response.body:
        return response
    headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
    return Response(content=body, status_code=200, headers=headers)


def _append_share_footer(response: Response) -> Response:
    """Append the "Made with ShellTeam" footer to a 200 text/html response.

    Anything else (errors, images, downloads) passes through untouched. The body
    is rebuilt so Content-Length stays correct.
    """
    ctype = response.headers.get("content-type", "")
    if response.status_code != 200 or not ctype.lower().startswith("text/html"):
        return response
    body = response.body
    footer = _SHARE_FOOTER_HTML.encode()
    idx = body.lower().rfind(b"</body>")
    new_body = body[:idx] + footer + body[idx:] if idx != -1 else body + footer
    headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
    return Response(content=new_body, status_code=200, headers=headers)




async def serve_owner_file(request: Request, path: str) -> Response:
    """Serve the owner's ``~/<path>`` on the main domain (single-user OSS).

    ``https://APP_DOMAIN/<path>`` maps straight to the owner's home dir, served
    by the local nginx file server. This is the URL convention the agent-layer
    persona teaches, and it avoids the double-subdomain (`seb.seb.…`) form.
    Registered behind every API route (catch-all), so real routes always win.

    Security gates, in order:
      1. path traversal / null bytes → 400
      2. dotfile segments (.env, .ssh, …) → 404 before any forwarding, in
         addition to nginx's own `location ~ /\\.` deny (defense in depth)
      3. reads (GET/HEAD) need the master token (Bearer/cookie), the derived
         files credential, or a live signed share link (?sig=&exp=, this path
         only); anything mutating (the editor's /_api/ writes) needs the master.
         Only explicitly published paths (files or directories) stay open —
         ~/public is not an ambient grant.
    """
    if _has_path_traversal(path):
        return Response(status_code=400, content="Invalid path")
    if _is_dotfile_path(path):
        from api.config import NOT_FOUND_HTML
        return HTMLResponse(status_code=404, content=NOT_FOUND_HTML)

    # The main host exposes only explicitly published paths (files or published
    # directories). ~/public is NO LONGER ambient — a write there does not
    # publish; it must go through the owner-authed publish toggle (F4).
    p = path.lstrip("/")
    is_published_report = reports.is_report_public(OWNER_ID, p)
    is_public = is_published_report
    via_share_sig = False
    if not is_public:
        if request.method in READ_METHODS:
            allowed = request_grants_files_read(request)
            if not allowed:
                via_share_sig = verify_share_sig(
                    p,
                    request.query_params.get("sig"),
                    request.query_params.get("exp"),
                )
                allowed = via_share_sig
        else:
            # Writes (editor saves via /_api/) require the master session —
            # the read-only files credential and share links can't mutate. Plus a
            # CSRF layer: a content-sandboxed report (Origin: null) or any other
            # non-dashboard origin can never drive a write even if it somehow held
            # the master cookie.
            if not origin_is_trusted(request.headers.get("origin")):
                log.warning("Main-host write refused: cross-origin %s /%s", request.headers.get("origin"), p)
                return _login_required_response()
            allowed = token_is_owner(get_token_from_request(request))
        if not allowed:
            log.info(
                "Main-host file request denied (%s /%s: no credential)",
                request.method, p,
            )
            # Throttle slug-guessing: a legitimate reader hits published paths
            # (allowed above); only enumeration reaches this miss path. Raises
            # 429 past the budget; the response below stays a uniform 401 so a
            # private path is byte-indistinguishable from a nonexistent one.
            if request.method in READ_METHODS:
                note_unpublished_read(request)
            return _login_required_response()

    activity.touch(OWNER_ID)
    # Re-encode the (Starlette-decoded) path before handing it to httpx: a
    # filename with a literal `#`/`?` would otherwise be split as a fragment/query
    # and 404. Keep `/` as separators. httpx tolerates spaces but not these.
    forward_path = quote(path, safe="/")
    response, reached = await _forward_http(request, f"http://127.0.0.1:{FILE_PORT}/{forward_path}")
    if reached and response.status_code == 404:
        # Keep the branded 404 instead of nginx's bare one.
        from api.config import NOT_FOUND_HTML
        return HTMLResponse(status_code=404, content=NOT_FOUND_HTML)
    if reached:
        response = _inline_sandboxed_images(request, response, p)
    if reached and _share_footer_applies(request, is_published_report, via_share_sig, p):
        response = _append_share_footer(response)
    return response




@router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def proxy_subdomain(request: Request, path: str):
    """Catch-all route: owner files on the main host, wildcard subdomain proxy otherwise."""
    host = request.headers.get("host", "")

    # Main host → the owner's home dir (every registered route already matched
    # before this catch-all, so only file paths land here).
    if host.split(":")[0] in MAIN_HOSTS:
        return await serve_owner_file(request, path)

    # Only handle subdomain requests (not direct API calls on unknown hosts)
    resolved = resolve_host(host.split(":")[0])
    if not resolved:
        from api.config import NOT_FOUND_HTML
        return HTMLResponse(status_code=404, content=NOT_FOUND_HTML)

    username, port = resolved

    # Skip known subdomains
    if username in RESERVED_SUBDOMAINS:
        from api.config import NOT_FOUND_HTML
        return HTMLResponse(status_code=404, content=NOT_FOUND_HTML)

    # Validate port range
    if port < 1 or port > 65535:
        return Response(status_code=400, content="Invalid port number")

    # Never proxy the control plane to itself: `owner-<API_PORT>` would loop
    # every request back into this app. 404, same as an unknown subdomain.
    if port == API_PORT:
        from api.config import NOT_FOUND_HTML
        return HTMLResponse(status_code=404, content=NOT_FOUND_HTML)

    # Block path traversal attempts
    if _has_path_traversal(path):
        return Response(status_code=400, content="Invalid path")

    # --- Auth gate ---
    # Public: ~/public/ on the file-server port, or ports explicitly marked public.
    # Owner-only by default; shared folders grant recipient access there.
    ip, owner_id = await resolve_username_owner(username)
    if not ip:
        if owner_id:
            asyncio.create_task(_auto_start_container(owner_id, username))
            return _starting_response(username)
        return _offline_response(username)

    # A published path (file or directory) is served with no cookie auth at its
    # own URL (private→public toggle, see api/services/reports.py). ~/public is
    # not ambient — publishing is the only path to world-readable (F4).
    is_published_report = _is_public_path(path, port, owner_id)
    is_public = is_published_report
    if not is_public and owner_id and port != FILE_PORT:
        is_public = ports.is_port_public(owner_id, port)

    # `allow` accumulates non-owner grants; is_public (published/public port)
    # is one. The owner-credential gate (_authorize) runs last if still needed.
    allow = is_public
    request_host = host.split(":")[0]
    origin = request.headers.get("origin")

    is_app_port = port != FILE_PORT and port not in reserved_service_ports()

    # Signed port-share links (the app equivalent of file `?sig=&exp=` links).
    # Redeem: verify the query signature, set the host-only cookie for THIS port
    # subdomain, redirect to the clean URL so the sig never sits in the address
    # bar. Subsequent requests (assets, API calls, WS upgrades) ride the cookie.
    if not allow and is_app_port:
        sig = request.query_params.get("sig")
        exp = request.query_params.get("exp")
        if sig and exp and verify_share_port_sig(port, sig, exp):
            from starlette.responses import RedirectResponse

            clean = request.url.remove_query_params(["sig", "exp"])
            redirect = RedirectResponse(str(clean), status_code=303)
            redirect.set_cookie(
                PORT_SHARE_COOKIE,
                port_share_cookie_value(port, int(exp)),
                max_age=max(0, int(exp) - int(time.time())),
                path="/",
                secure=request.url.scheme == "https",
                httponly=True,
                samesite="lax",
            )
            log.info("Port-share link redeemed for :%d (exp=%s)", port, exp)
            return redirect
        if verify_port_share_cookie(request.cookies.get(PORT_SHARE_COOKIE), port):
            # A share grant is scoped to its OWN origin — it is NOT is_public.
            # Making it is_public would skip _authorize's origin check, letting a
            # hostile same-site sibling (owner-4999) drive credentialed requests
            # to the shared port. The recipient holds one port; only that port's
            # own JS (same-origin) or a top-level nav (no Origin) is trusted.
            if _origin_trusted(origin, request_host):
                allow = True
            else:
                log.warning(
                    "Port-share cookie refused on %s:%s — untrusted Origin %r",
                    request_host, port, origin,
                )
                return _forbidden_response()

    # A CORS preflight to an app port carries no credentials and has no side
    # effects — it only asks the app for its CORS policy. Blocking it with our
    # auth gate would 401 the preflight before the app could answer, breaking
    # every cross-origin call in a two-port app. Let OPTIONS through to app
    # ports (never the file host or reserved services); the real request that
    # follows is still authorized normally.
    if not allow and is_app_port and request.method == "OPTIONS":
        allow = True

    if not allow and _get_client_ip(request) != ip:
        decision = _authorize(
            request.cookies.get(MASTER_COOKIE),
            request.cookies.get(FILES_COOKIE),
            owner_id,
            port,
            request.method,
            origin,
            request_host,
        )
        if decision in (AUTH_NO_TOKEN, AUTH_BAD_TOKEN):
            return _login_required_response()
        if decision == AUTH_FORBIDDEN:
            return _forbidden_response()

    if owner_id:
        activity.touch(owner_id)

    # Proxy the request. App ports stream (SSE/chunked/long responses work);
    # the file-server path stays buffered — the share footer and image inlining
    # need the whole body.
    response, reached = await _forward_http(
        request, f"http://{ip}:{port}/{path}", stream=(port != FILE_PORT)
    )
    if reached and owner_id and port != FILE_PORT:
        ports.record_port_hit(owner_id, port)
    if reached and _share_footer_applies(request, is_published_report, False, path):
        response = _append_share_footer(response)
    return response


def _parse_host(scope) -> str:
    """Extract hostname without port from ASGI scope headers."""
    headers = dict(scope.get("headers", []))
    return headers.get(b"host", b"").decode().split(":")[0]


async def proxy_websocket(scope, receive, send):
    """Proxy WebSocket connections to user containers."""
    host = _parse_host(scope)
    path = scope.get("path", "/")

    log.info("WS proxy: host=%s path=%s", host, path)

    resolved = resolve_host(host)
    if not resolved:
        log.info("WS proxy: no subdomain match for %s", host)
        ws = WebSocket(scope, receive, send)
        await ws.close(1008, "Invalid host")
        return

    username, port = resolved
    log.info("WS proxy: username=%s port=%d", username, port)

    if username in RESERVED_SUBDOMAINS:
        ws = WebSocket(scope, receive, send)
        await ws.close(1008, "Reserved subdomain")
        return

    # Validate port range
    if port < 1 or port > 65535:
        ws = WebSocket(scope, receive, send)
        await ws.close(1008, "Invalid port")
        return

    # Same rule as the HTTP path: never proxy the control plane into itself.
    if port == API_PORT:
        ws = WebSocket(scope, receive, send)
        await ws.close(1008, "Reserved port")
        return

    # Block path traversal
    if _has_path_traversal(path):
        ws = WebSocket(scope, receive, send)
        await ws.close(1008, "Invalid path")
        return

    # --- Auth check (same rules as HTTP: public path, public port, owner, or shared folder) ---
    ip, owner_id = await resolve_username_owner(username)

    is_public = _is_public_path(path, port, owner_id)
    if not is_public and owner_id and port != FILE_PORT:
        is_public = ports.is_port_public(owner_id, port)

    headers_dict = dict(scope.get("headers", []))
    ws_origin = headers_dict.get(b"origin", b"").decode() or None

    # A redeemed port-share cookie also covers the app's own WebSockets — a
    # shared app with live updates must work for the link's recipient. Same rule
    # as HTTP: the grant is scoped to its OWN origin, NOT is_public. A hostile
    # same-site sibling could otherwise open and READ the shared socket (worse
    # than HTTP). Only the app's own JS (same-origin) qualifies.
    if not is_public and port != FILE_PORT and port not in reserved_service_ports():
        ws_cookies = headers_dict.get(b"cookie", b"").decode()
        if verify_port_share_cookie(_extract_cookie(ws_cookies, PORT_SHARE_COOKIE), port):
            if _origin_trusted(ws_origin, host):
                is_public = True
            else:
                log.warning("WS proxy: port-share cookie refused on %s:%d — untrusted Origin %r", username, port, ws_origin)
                ws = WebSocket(scope, receive, send)
                await ws.accept()
                await ws.close(1008, "Access denied")
                return

    if not is_public and ip:
        # In-box trust from the validated transport peer, never a raw header —
        # same reason as _get_client_ip (a spoofed X-Forwarded-For: 127.0.0.1 must
        # not grant owner trust on the WS path either). uvicorn populates
        # scope["client"] from the proxy-validated chain.
        client = scope.get("client")
        client_ip = client[0] if client else None
        if client_ip != ip:
            cookie_header = headers_dict.get(b"cookie", b"").decode()
            decision = _authorize(
                _extract_cookie(cookie_header, MASTER_COOKIE),
                _extract_cookie(cookie_header, FILES_COOKIE),
                owner_id,
                port,
                WS_METHOD,
                ws_origin,
                host,
            )
            if decision != AUTH_OK:
                log.warning("WS proxy: %s for %s:%d", decision, username, port)
                ws = WebSocket(scope, receive, send)
                close_msg = {
                    AUTH_NO_TOKEN: "Authentication required",
                    AUTH_BAD_TOKEN: "Invalid token",
                    AUTH_FORBIDDEN: "Access denied",
                }[decision]
                # Accept first so the browser receives a real close frame with code 1008.
                # Closing before accept rejects the upgrade with HTTP 403, which the browser
                # surfaces as code 1006 — making auth-specific reconnect handling impossible.
                await ws.accept()
                await ws.close(1008, close_msg)
                return

    if not ip:
        if owner_id:
            asyncio.create_task(_auto_start_container(owner_id, username))
            log.info("WS proxy: auto-starting container for %s", username)
            ws = WebSocket(scope, receive, send)
            await ws.close(1013, "Container starting")
            return
        log.warning("WS proxy: container offline for %s", username)
        ws = WebSocket(scope, receive, send)
        await ws.close(1013, "Container offline")
        return

    log.info("WS proxy: connecting to %s:%d%s", ip, port, path)

    browser_ws = WebSocket(scope, receive, send)

    # Forward the client's requested subprotocols and echo back the one the
    # upstream selects. Dev-tooling sockets refuse a subprotocol-less accept —
    # Vite's HMR client requires `vite-hmr` — so connect upstream FIRST, then
    # accept the browser with the negotiated result. Beyond subprotocols we
    # forward ONLY a sanitized header set (the app's own cookies + Origin);
    # every ShellTeam credential and spoofable forwarding header is stripped
    # (_sanitized_ws_upstream_headers). Contract-tested.
    requested_protocols = [
        p.strip()
        for p in headers_dict.get(b"sec-websocket-protocol", b"").decode().split(",")
        if p.strip()
    ]
    upstream_headers = _sanitized_ws_upstream_headers(headers_dict)

    if owner_id:
        activity.connection_opened(owner_id)

    # Connect to the container's WebSocket (include query string)
    qs = scope.get("query_string", b"").decode()
    target_url = f"ws://{ip}:{port}{path}" + (f"?{qs}" if qs else "")
    try:
        async with websockets.connect(
            target_url,
            max_size=20 * 1024 * 1024,
            subprotocols=requested_protocols or None,
            additional_headers=upstream_headers or None,
        ) as container_ws:
            await browser_ws.accept(subprotocol=container_ws.subprotocol)
            if owner_id and port != FILE_PORT:
                ports.record_port_hit(owner_id, port)

            async def browser_to_container():
                while True:
                    try:
                        data = await browser_ws.receive()
                    except (WebSocketDisconnect, RuntimeError):
                        return
                    if data.get("type") == "websocket.disconnect":
                        return
                    text = data.get("text")
                    bdata = data.get("bytes")
                    if text is not None:
                        await container_ws.send(text)
                    elif bdata is not None:
                        await container_ws.send(bdata)

            async def container_to_browser():
                async for msg in container_ws:
                    if isinstance(msg, str):
                        await browser_ws.send_text(msg)
                    else:
                        await browser_ws.send_bytes(msg)

            tasks = [
                asyncio.create_task(browser_to_container()),
                asyncio.create_task(container_to_browser()),
            ]
            # Wait for the first task to finish, then cancel the other
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except WebSocketDisconnect:
        pass
    except websockets.exceptions.ConnectionClosed:
        pass
    except (OSError, ConnectionRefusedError, websockets.exceptions.InvalidHandshake) as e:
        log.warning("WebSocket proxy failed for %s:%s — %s", ip, port, e)
        # Upstream never connected, so the browser socket was never accepted.
        # Accept before the close in `finally` so the client receives a real
        # close frame (mirrors the auth-refusal path above).
        from starlette.websockets import WebSocketState

        if browser_ws.application_state == WebSocketState.CONNECTING:
            try:
                await browser_ws.accept()
            except Exception:
                pass
    finally:
        if owner_id:
            activity.connection_closed(owner_id)
        try:
            await browser_ws.close()
        except Exception:
            pass

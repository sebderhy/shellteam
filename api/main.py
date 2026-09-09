import json
import logging
import os
from pathlib import Path

from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

from api.config import APP_DOMAIN, MAIN_HOSTS, OWNER_ID, OWNER_USERNAME, OWNER_TOKEN, HOME_DIR  # noqa: E402

AI_CHAT_PORT = os.environ.get("AI_CHAT_PORT", "3456")

from api.config import RUNTIME, migrate_legacy_state_dir  # noqa: E402
from api.routers import ai_tools, auth, computers, enroll, feedback, integrations, knowledge, mirror, settings, terminal, internal, proxy  # noqa: E402
from api.services import ports as port_service, reports as report_service  # noqa: E402
from api.services.ratelimit import RateLimiter  # noqa: E402

# Global rate limit — 120 req/min per IP (catch-all safety net)
_global_limit = RateLimiter(rate=120, period=60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Converge the git-pull upgrade path with install.sh: move state off the old
    # /data/users default before the seeders read it (no-op unless a legacy dir
    # exists and DATA_DIR is unset).
    migrate_legacy_state_dir()
    from api.config import validate_modules
    validate_modules()
    # Fail closed on a public deployment with no auth boundary. When APP_DOMAIN is
    # anything but localhost the box is meant to be reachable off-machine, and an
    # empty OWNER_TOKEN means "trust every request" — a silent open door to the
    # owner's files and the cockpit shell (the structural root of several audit
    # findings: make the safe path the only path). Refuse to boot rather than
    # serve wide open. Escape hatch for a deliberately-trusted overlay (e.g. a
    # locked-down tailnet): ALLOW_TOKENLESS_PUBLIC=1.
    _public_bind = APP_DOMAIN not in ("localhost", "127.0.0.1", "::1")
    if _public_bind and not OWNER_TOKEN and os.environ.get("ALLOW_TOKENLESS_PUBLIC") != "1":
        raise RuntimeError(
            f"Refusing to start: APP_DOMAIN={APP_DOMAIN!r} is a public bind but OWNER_TOKEN "
            "is empty — every request would be trusted. Set a strong OWNER_TOKEN in .env "
            "(install.sh --remote/--domain does this), or set ALLOW_TOKENLESS_PUBLIC=1 if "
            "this box is only reachable over a trusted private overlay."
        )
    port_service.seed_from_disk()
    report_service.seed_from_disk()
    # ~/public is no longer an ambient world-readable mount (a stray write or a
    # prompt-injected agent could publish by touching a path). Serving now
    # requires an explicit publish entry. Migrate any pre-0.1.7 ~/public content
    # so live links survive, and log the full world-readable inventory every boot
    # so exposure is never invisible (exposure-audit F3/F4).
    report_service.migrate_ambient_public_grant(OWNER_ID, HOME_DIR)
    _exposed = report_service.exposure(OWNER_ID, HOME_DIR)
    if _exposed:
        logging.getLogger(__name__).warning(
            "%d world-readable path(s) published: %s",
            len(_exposed), ", ".join(e["path"] for e in _exposed),
        )
    else:
        logging.getLogger(__name__).info("No world-readable published paths.")
    # Re-render the agent layer from CURRENT config on every boot (SHE-77): the
    # layer bakes APP_DOMAIN into the persona's file-URL guidance, and a §4.5
    # install renders it while `.env` still says localhost — the documented
    # "edit .env, restart services" flow must converge it, or agents teach dead
    # `https://<owner>.localhost/…` links forever. Idempotent; native only (Cloud
    # materializes per-container). Skipped under pytest: the suite's hermetic env
    # (localhost, MODULES="") would otherwise clobber the real box's live layer.
    if RUNTIME == "native" and "PYTEST_CURRENT_TEST" not in os.environ:
        from api.config import OWNER_EMAIL
        from api.services.processes import _materialize_config

        _materialize_config(OWNER_USERNAME, OWNER_EMAIL)
        logging.getLogger(__name__).info(
            "Agent layer re-rendered for APP_DOMAIN=%s", APP_DOMAIN
        )
    yield


# Schema/docs are OFF by default: the interactive docs and the machine-readable
# OpenAPI spec hand an attacker a full route/parameter map of the control plane
# for free. Opt back in with SHELLTEAM_DOCS=1 for local development.
_DOCS_ON = os.environ.get("SHELLTEAM_DOCS", "") == "1"
app = FastAPI(
    title="ShellTeam Control Plane",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if _DOCS_ON else None,
    redoc_url="/redoc" if _DOCS_ON else None,
    openapi_url="/openapi.json" if _DOCS_ON else None,
)

@app.exception_handler(StarletteHTTPException)
async def custom_http_exception(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        from api.config import NOT_FOUND_HTML
        return HTMLResponse(content=NOT_FOUND_HTML, status_code=404)
    return JSONResponse(content={"detail": exc.detail}, status_code=exc.status_code)


def is_main_host(request: Request) -> bool:
    """Check if request is to the main domain (not a user subdomain)."""
    host = request.headers.get("host", "").split(":")[0]
    return host in MAIN_HOSTS


def uses_sibling_ports(host: str) -> bool:
    """True when the cockpit/file services are reached as sibling local ports
    (localhost or a bare IP — e.g. a Tailscale 100.x address) rather than as
    owner-subdomains. These hosts have no wildcard DNS, so the dashboard frames
    the cockpit at ``<host>:<AI_CHAT_PORT>`` — a cross-origin sibling that the
    CSP and the cockpit-URL resolver must both account for."""
    return host in ("localhost", "127.0.0.1", "::1") or host.replace(".", "").isdigit()


class SubdomainProxyMiddleware:
    """ASGI middleware that intercepts subdomain requests before route matching.

    Without this, app.mount("/static", ...) would catch /static/* requests
    on subdomain hosts, returning 404 instead of proxying to containers.
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] in ("http", "websocket"):
            host = proxy._parse_host(scope)
            if host not in MAIN_HOSTS and proxy.SUBDOMAIN_RE.match(host):
                if scope["type"] == "websocket":
                    await proxy.proxy_websocket(scope, receive, send)
                    return
                # Build a FastAPI Request from the ASGI scope
                request = Request(scope, receive)
                path = scope.get("path", "/").lstrip("/")
                response = await proxy.proxy_subdomain(request, path)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


# CORS applies to the CONTROL PLANE only — registered before the subdomain proxy
# so the proxy wraps it (Starlette: last-added = outermost). With the order
# reversed, our CORSMiddleware answered every cross-subdomain preflight itself:
# a frontend on `owner-5173.APP_DOMAIN` calling its own backend on
# `owner-8000.APP_DOMAIN` got `400 Disallowed CORS origin` at our edge and the
# user's backend never saw the OPTIONS — no app-side CORS config could fix it.
# Proxied apps define their own CORS policy; ShellTeam must not impose one.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"https://{APP_DOMAIN}",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Shellteam-User-Id"],
)

app.add_middleware(SubdomainProxyMiddleware)


# Content-Security-Policy — all third-party JS/CSS/images/fonts are self-hosted
# under /static/vendor/ (marketing, dashboard) and /vendor/ (chat UI), so
# cdn.jsdelivr.net and Google Fonts were dropped entirely. Only Tailwind's CDN
# runtime remains.
def _csp_for(request: Request) -> str:
    """Build the dashboard CSP for this request's host.

    The Agents/Terminal/Files tabs are iframes. In domain mode the cockpit and
    file server live at ``*.APP_DOMAIN`` subdomains (covered by the wildcard
    rules). In localhost / bare-IP mode (e.g. over Tailscale) there is no
    wildcard DNS, so the cockpit is framed at the cross-origin sibling
    ``<scheme>://<host>:<AI_CHAT_PORT>`` — which must be added explicitly to
    ``frame-src``/``connect-src`` or the browser blocks the Agents tab.
    """
    frame = ["'self'", f"https://*.{APP_DOMAIN}"]
    connect = ["'self'", f"wss://{APP_DOMAIN}", f"wss://*.{APP_DOMAIN}"]

    host = request.url.hostname or ""
    if host and uses_sibling_ports(host):
        scheme = request.url.scheme
        ws = "wss" if scheme == "https" else "ws"
        cockpit = f"{scheme}://{host}:{AI_CHAT_PORT}"
        frame.append(cockpit)
        connect.extend([cockpit, f"{ws}://{host}:{AI_CHAT_PORT}"])

    return "; ".join([
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' cdn.tailwindcss.com",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data: blob:",
        f"connect-src {' '.join(connect)}",
        f"frame-src {' '.join(frame)}",
        "object-src 'none'",
        "base-uri 'self'",
        # Clickjacking: only ShellTeam's own pages may frame the dashboard shell
        # (it frames its own cockpit/file children; nothing frames it).
        "frame-ancestors 'self'",
    ])


def _permissions_policy_for(request: Request) -> str:
    """Restrictive feature policy for the dashboard shell — deny everything except
    the microphone, which the cockpit needs for voice input.

    The cockpit runs in a CROSS-ORIGIN iframe (the `<owner>-<port>.APP_DOMAIN`
    subdomain, or the sibling `host:AI_CHAT_PORT` in localhost/Tailscale mode), so
    `microphone=(self)` alone blocks it even though the iframe carries
    `allow="microphone"` — the parent must delegate the feature to the child's
    ORIGIN. Include the cockpit origin (mirrors `_cockpit_url`/`_csp_for`). Origins
    are quoted in Permissions-Policy; `self` is a bare keyword.
    """
    host = request.url.hostname or ""
    if host and uses_sibling_ports(host):
        cockpit = f"{request.url.scheme}://{host}:{AI_CHAT_PORT}"
    else:
        cockpit = f"https://{OWNER_USERNAME}-{AI_CHAT_PORT}.{APP_DOMAIN}"
    return f'camera=(), geolocation=(), payment=(), usb=(), microphone=(self "{cockpit}")'


# Paths whose responses are the app's own HTML shells — the only documents the
# dashboard CSP is written for. Everything else on the main host (owner files,
# the /_editor Monaco page, /_ls, agent-built HTML…) is proxied from the nginx
# file server and must NOT inherit this CSP: it blocked the editor's Monaco CDN
# and broke every /_editor deep link (SHE-41/37). Every first-party shell route
# must be listed here — an omitted one falls through to CONTENT_SANDBOX_CSP,
# whose opaque origin sends its API fetches as `Origin: null` and breaks the
# page entirely (that's how /knowledge shipped unusable).
_CSP_PATHS = ("/", "/terminal", "/browser", "/knowledge", "/reports", "/apps")

# Owner/agent HTML served through the main-host file catch-all runs on the
# dashboard origin. Without isolation, a hostile or prompt-injected HTML file
# (an agent renders scraped web content into a report; a lure in ~/public) could
# ride the owner's ambient HttpOnly master cookie into the terminal WS, /enroll
# (which mints a durable session), /share, or /_api/ file writes — an owner-shell
# RCE and persistent takeover from merely opening the file. We stamp such
# documents with `Content-Security-Policy: sandbox` (no `allow-same-origin`),
# which forces an opaque origin: interactive reports still run JS, submit forms,
# and open links, but the browser no longer treats them as APP_DOMAIN, so the
# host-only master cookie is never attached to their fetches/WebSockets. The
# capability sinks additionally reject the resulting `Origin: null`
# (dependencies.require_trusted_origin) as a second layer.
# See docs/decisions/20260717-served-content-sandbox.md.
CONTENT_SANDBOX_CSP = (
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox "
    "allow-downloads allow-forms allow-modals"
)

# ShellTeam's OWN trusted file-UI pages (the Monaco editor, directory listings,
# the file-write API) are served under the main host too, but must keep the real
# origin — they make credentialed same-origin fetches to do their job — so they
# are exempt from the content sandbox. Everything else main-host HTML is content.
_TRUSTED_FILE_UI_PREFIXES = ("/_editor", "/_ls", "/_files", "/_api", "/api/computers/cockpit")


def _wants_content_sandbox(request: Request, response) -> bool:
    """True for owner/agent HTML served through the main-host file catch-all."""
    if not is_main_host(request) or _wants_dashboard_csp(request):
        return False
    path = request.url.path
    if any(path == p or path.startswith(p + "/") for p in _TRUSTED_FILE_UI_PREFIXES):
        return False
    return response.headers.get("content-type", "").startswith("text/html")


def _wants_dashboard_csp(request: Request) -> bool:
    # Exact-or-slash, never a bare prefix: `startswith("/static")` would also
    # stamp owner files like `/static-site/index.html` (which fall through to
    # serve_owner_file, not the /static mount) and `/enrollment-report.html`,
    # re-imposing the CDN-blocking CSP that SHE-41 removed from proxied files.
    path = request.url.path
    is_shell = (
        path in _CSP_PATHS
        or path == "/enroll" or path.startswith("/enroll/")
        or path == "/static" or path.startswith("/static/")
    )
    return is_main_host(request) and is_shell


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Add Content-Security-Policy to the app's own dashboard pages only.

    Subdomain-proxied responses and owner files served through the main-host
    catch-all must not get the dashboard CSP — those documents define their
    own security posture (see _CSP_PATHS above).
    """
    response = await call_next(request)
    # Never leak the server/stack banner (fingerprinting aid) — on any response.
    response.headers["Server"] = "ShellTeam"
    if _wants_dashboard_csp(request):
        response.headers["Content-Security-Policy"] = _csp_for(request)
        # Belt-and-suspenders clickjacking guard for browsers that predate CSP
        # frame-ancestors, plus a least-privilege feature policy.
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Permissions-Policy"] = _permissions_policy_for(request)
    elif _wants_content_sandbox(request, response):
        response.headers["Content-Security-Policy"] = CONTENT_SANDBOX_CSP
    # Owner/agent content served off the main host must never be indexed: its
    # confidentiality rests on no inbound link existing, and a header (not a meta
    # tag) also covers .md/.pdf/images (exposure-audit F5). The dashboard shell
    # and ShellTeam's own file-UI keep the default (they carry no secrets and
    # marketing pages may want indexing) — this targets served home content.
    if _wants_content_sandbox(request, response) or _is_served_home_content(request):
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


def _is_served_home_content(request: Request) -> bool:
    """A main-host request that falls through to the owner's home files (not a
    registered API route, not the dashboard shell, not /static)."""
    if not is_main_host(request):
        return False
    path = request.url.path
    if _wants_dashboard_csp(request) or path == "/health" or path == "/robots.txt":
        return False
    return not path.startswith("/api/") and not path.startswith("/internal/")


@app.middleware("http")
async def global_rate_limit(request: Request, call_next):
    """Global safety-net rate limit — 120 req/min per IP.

    The limiter raises FastAPI's HTTPException, which route-level exception
    handling would turn into a 429 — but user middleware runs OUTSIDE that
    handling, so letting it escape here surfaced as a traceback and a 500
    (round-6 audit P2-02). Convert it to the real response at the boundary.
    """
    if not _global_limit.allow(request):
        return JSONResponse(status_code=429, content={"detail": "Too many requests"})
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/robots.txt", include_in_schema=False)
async def robots_txt():
    """Served unauthenticated with a blanket Disallow. A published report's
    confidentiality rests on no inbound link existing; if one leaks, this keeps
    a compliant crawler from turning a guessable slug into a search result
    (exposure-audit F5). The per-file X-Robots-Tag header is the real control;
    this is the site-wide belt-and-suspenders. Never 401 — a 401 robots.txt
    gives a crawler no directive at all."""
    return PlainTextResponse("User-agent: *\nDisallow: /\n")


# API routers
app.include_router(auth.router)
app.include_router(enroll.router)
app.include_router(computers.router)
app.include_router(terminal.router)
app.include_router(internal.router)
app.include_router(ai_tools.router)
app.include_router(feedback.router)
app.include_router(mirror.router)
app.include_router(integrations.router)
app.include_router(settings.router)
app.include_router(knowledge.router)

# Serve frontend static files
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR / "static"), name="static")

    # NOTE: ~/public is deliberately NOT auto-mounted. A file there is served only
    # after an explicit publish (api/services/reports.py) — writing a path no
    # longer makes it world-readable (exposure-audit F4). Requests for /public/…
    # fall through to serve_owner_file, which serves them only when published.

    def _cockpit_url(request: Request) -> str:
        """Where the ai-chat cockpit lives for this request.

        On localhost (no wildcard DNS) the cockpit is a sibling local port. For a
        domain deployment it is reachable through the owner's port-subdomain,
        proxied by this control plane.
        """
        host = request.url.hostname or "127.0.0.1"
        if uses_sibling_ports(host):
            return f"//{host}:{AI_CHAT_PORT}/"
        return f"{request.url.scheme}://{OWNER_USERNAME}-{AI_CHAT_PORT}.{APP_DOMAIN}/"

    def _asset_version() -> str:
        """A version string that changes whenever a served HTML shell changes.

        The dashboard loads the terminal/browser pages in iframes. Browsers cache
        those iframe URLs, so a fixed `/terminal` URL can keep serving a stale copy
        even after a deploy (and `no-store` only governs *future* fetches of that
        URL, not what's already cached). We stamp the iframe src with this version
        — derived from the files' mtimes — so any change yields a never-before-seen
        URL the browser is forced to fetch fresh. Cheap stat, computed per request,
        so HTML edits take effect with no restart.
        """
        names = ("dashboard.html", "terminal.html", "browser.html", "guest.html", "knowledge.html", "reports.html", "apps.html")
        mtimes = [(FRONTEND_DIR / n).stat().st_mtime for n in names if (FRONTEND_DIR / n).exists()]
        return str(int(max(mtimes))) if mtimes else "0"

    def _trial_json() -> str:
        """The trial banner config as JSON for a <script type=application/json>
        block, or ``null``. Read per request so the file can appear after boot
        (the demo writes it when a seat starts). Only known keys, typed, make it
        into the page; ``</`` is escaped so the file cannot close the script."""
        from api.config import TRIAL_FILE

        if not TRIAL_FILE.exists():
            return "null"
        try:
            raw = json.loads(TRIAL_FILE.read_text(encoding="utf-8"))
            cfg = {
                "ends_at": int(raw["ends_at"]),
                "label": str(raw.get("label", "Trial")),
                "cta_url": str(raw.get("cta_url", "")),
                "cta_label": str(raw.get("cta_label", "")),
            }
        except (ValueError, TypeError, KeyError, OSError) as exc:
            logging.getLogger(__name__).warning("Ignoring malformed %s: %s", TRIAL_FILE, exc)
            return "null"
        if cfg["cta_url"] and not cfg["cta_url"].startswith("https://"):
            logging.getLogger(__name__).warning("Ignoring non-https trial cta_url in %s", TRIAL_FILE)
            cfg["cta_url"] = ""
        return json.dumps(cfg).replace("</", "<\\/")

    def _render(filename: str, request: Request) -> HTMLResponse:
        """Serve a frontend HTML page with owner/cockpit placeholders filled in.

        Single-user deploy: the owner identity and cockpit URL are known
        server-side, so we inject them at serve time rather than fetching a
        profile client-side.
        """
        html = (FRONTEND_DIR / filename).read_text(encoding="utf-8")
        html = html.replace("__OWNER_USERNAME__", OWNER_USERNAME)
        html = html.replace("__COCKPIT_URL__", _cockpit_url(request))
        # The dashboard auth gate needs the parent domain (to scope the token
        # cookie to subdomains) and whether a token is required at all.
        html = html.replace("__APP_DOMAIN__", APP_DOMAIN)
        html = html.replace("__OWNER_TOKEN_SET__", "1" if OWNER_TOKEN else "0")
        html = html.replace("__ASSET_VERSION__", _asset_version())
        # Whether the browser module is installed — the dashboard hides the
        # Browser tab without it, and browser.html explains how to enable it
        # instead of presenting a dead "offline" retry loop.
        from api.config import MODULES

        html = html.replace("__HAS_BROWSER__", "true" if "browser" in MODULES else "false")
        # Steel's host-side loopback port (browser.html builds the screencast WS
        # URL from it; default deliberately off :3000 — see api/config.py).
        from api.config import STEEL_PORT

        html = html.replace("__STEEL_PORT__", str(STEEL_PORT))
        html = html.replace("__TRIAL_JSON__", _trial_json())
        # These shells are tiny and change with every deploy; never let a browser
        # serve a stale dashboard/terminal/browser page (it would show old chrome).
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    @app.get("/")
    async def dashboard_page(request: Request):
        from fastapi.responses import RedirectResponse
        from api.services.auth import apply_session_cookies, get_token_from_request, token_is_owner
        from api.services.ratelimit import note_auth_failure

        secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"

        # One-time URL redemption (decisions/20260702-split-credentials.md): a
        # valid `/?token=` is accepted exactly once — set the HttpOnly session
        # cookies and redirect with the query scrubbed, so the token never
        # persists in the address bar, history, or bookmarks. This keeps the
        # install-banner "open this URL" flow working with no readable cookie.
        url_token = request.query_params.get("token")
        if url_token is not None:
            resp = RedirectResponse(url="/", status_code=303)
            if OWNER_TOKEN and token_is_owner(url_token):
                apply_session_cookies(resp, secure=secure)
                logging.getLogger(__name__).info(
                    "Redeemed one-time ?token= dashboard URL into session cookies"
                )
            else:
                # A GET /?token= loop is otherwise an unthrottled dictionary
                # oracle for OWNER_TOKEN. Feed the same per-IP backoff that
                # POST /api/auth/login uses (escalates to 429) so this path is
                # not a softer target than the login endpoint.
                note_auth_failure(request)
                logging.getLogger(__name__).warning(
                    "Rejected ?token= dashboard URL (invalid token) — redirecting to login"
                )
            return resp

        resp = _render("dashboard.html", request)
        # Refresh/migrate the session cookies on every authed dashboard load:
        # upgrades pre-split sessions (JS-readable domain-wide master) to the
        # HttpOnly split pair and deletes the legacy cookie.
        if OWNER_TOKEN and token_is_owner(get_token_from_request(request)):
            apply_session_cookies(resp, secure=secure)
        return resp


    @app.get("/terminal")
    async def terminal_page(request: Request):
        return FileResponse(FRONTEND_DIR / "terminal.html", headers={"Cache-Control": "no-store"})

    @app.get("/browser")
    async def browser_page(request: Request):
        return _render("browser.html", request)

    @app.get("/reports")
    async def reports_page(request: Request):
        # The Reports tab shell. Like /terminal and /browser, the shell itself
        # is servable to anyone — every byte of data behind it (the listing
        # API, the previewed files) is owner-authed. Registered as an explicit
        # route, it shadows only the literal `/reports` path (previously a
        # non-servable directory hit on the file catch-all); `/reports/<file>`
        # still flows through serve_owner_file untouched.
        return _render("reports.html", request)

    @app.get("/apps")
    async def apps_page(request: Request):
        # The Apps tab shell (GitHub + Composio app connections). Servable to
        # anyone like the other shells; every action behind it is owner-authed
        # (/api/integrations, the cockpit's github card). Also the OAuth
        # landing page: Composio redirects to /apps?app_connected=<toolkit>.
        return _render("apps.html", request)

    @app.get("/knowledge")
    async def knowledge_page(request: Request):
        # Only exists with the dreaming module — literally the same gate as
        # its API, so page and API can never disagree.
        knowledge._require_dreaming()
        return _render("knowledge.html", request)


# Browser tabs API (before catch-all proxy)

# Subdomain proxy — LAST (catch-all route for wildcard subdomains)
app.include_router(proxy.router)

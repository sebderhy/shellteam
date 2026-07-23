"""Device enrollment — log in a new device via a one-time link, no token typing.

Three endpoints:
  POST /api/auth/enroll  (owner-authed) → mint a one-time link + QR for it
  GET  /enroll?code=...  (unauthed)     → show a confirm page; does NOT consume the code
  POST /enroll           (unauthed)     → redeem it: set the session cookie, bounce home

The redeem is split into a safe GET (renders a button) and a consuming POST
(the button's action) on purpose: a GET must be idempotent. Link scanners
(Palo Alto / SafeLinks), chat link-preview bots, and browser prefetch all issue
GETs against any URL they see — a single-use code redeemed on GET gets burned by
the scanner before the human clicks, and the human then sees "Link expired".
Only the explicit POST consumes the code, and bots don't POST.

The raw OWNER_TOKEN never appears in a URL, a prompt, or the clipboard — only the
single-use code does, and it dies in 5 minutes or on first use. A precursor to
WebAuthn passkeys; ship the nice flow now, harden to nothing-leak-able later.
"""

import logging

import segno
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from api.config import APP_DOMAIN, OWNER_TOKEN
from api.dependencies import get_current_user, require_trusted_origin
from api.services import enrollment
from api.services.auth import apply_session_cookies
from api.services.ratelimit import RateLimiter

log = logging.getLogger(__name__)
router = APIRouter(tags=["enroll"])

# Minting is owner-authed already; cap it anyway so a stolen session can't mint a
# flood of live links. Redeeming is unauthed (that's the point) — the code is
# 256-bit and single-use, but rate-limit per IP as defence in depth.
_mint_limit = RateLimiter(rate=10, period=60)
_redeem_limit = RateLimiter(rate=20, period=60)


def _request_origin(request: Request) -> str:
    """Absolute ``scheme://host`` for the host the enrollment link points at.

    On a public deploy the link is pinned to APP_DOMAIN — never the client's
    Host header, which an attacker-crafted request could spoof to mint a QR
    pointing at their own host. Localhost-mode keeps the request host so
    Tailscale-IP / 127.0.0.1 links still work.
    """
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    if APP_DOMAIN and APP_DOMAIN != "localhost":
        return f"{proto}://{APP_DOMAIN}"
    host = request.headers.get("host", APP_DOMAIN)
    return f"{proto}://{host}"


@router.post("/api/auth/enroll")
async def create_enrollment(
    request: Request,
    user: dict = Depends(get_current_user),
    _origin=Depends(require_trusted_origin),
    _rl=Depends(_mint_limit),
):
    """Mint a one-time device-enrollment link (owner only).

    Open the returned URL on a new device — or scan the QR — to set its session
    cookie without ever handling the raw OWNER_TOKEN.
    """
    if not OWNER_TOKEN:
        raise HTTPException(
            status_code=409,
            detail="No OWNER_TOKEN set — this box is in localhost-trust mode, nothing to enroll.",
        )
    code, ttl = enrollment.mint_code()
    url = f"{_request_origin(request)}/enroll?code={code}"
    # Inline SVG QR (CSP-safe: no external asset, rendered straight into the modal).
    # omitsize=True drops the fixed width/height and emits a viewBox instead, so the
    # dashboard's `width:100%` sizing scales the QR to fit. Without it the SVG keeps
    # its intrinsic 225px size and CSS-resizing only clips it — the modal showed the
    # top-left ~70% of the code, which no scanner can read.
    qr_svg = segno.make(url, error="m").svg_inline(
        scale=5, dark="#0a0a0a", light="#ffffff", omitsize=True
    )
    log.info("Issued device-enrollment link for the owner (ttl=%ss)", ttl)
    return {"url": url, "qr_svg": qr_svg, "expires_in": ttl}


_PAGE_CSS = (
    "body{margin:0;min-height:100vh;display:flex;align-items:center;"
    "justify-content:center;background:#0a0a0a;color:#e5e5e5;"
    "font-family:system-ui,-apple-system,sans-serif;text-align:center}"
    ".w{max-width:360px;padding:24px}h1{margin:0 0 8px}p{color:#888;line-height:1.6}"
    "button{margin-top:20px;width:100%;padding:14px 20px;font-size:16px;font-weight:600;"
    "color:#0a0a0a;background:#f59e0b;border:0;border-radius:10px;cursor:pointer}"
    "button:hover{background:#fbbf24}"
)

_REDEEM_FAIL_HTML = (
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Link expired</title>"
    f"<style>{_PAGE_CSS} h1{{color:#f59e0b}}</style></head><body><div class='w'>"
    "<h1>Link expired</h1><p>This device-enrollment link is invalid or already used. "
    "Generate a fresh one from Settings &rarr; Devices on a device you're signed in on.</p>"
    "</div></body></html>"
)


def _confirm_html(code: str) -> str:
    """The interactive page a GET renders: a button that POSTs to consume the code.

    No JS auto-submit — consumption must require a real human click so a scanner
    that merely loads the page (or even executes its JS) still can't redeem it.
    The code rides in a hidden field; it is escaped to keep the markup safe even
    though it is always a url-safe token.
    """
    safe = code.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<meta name='robots' content='noindex'><title>Enroll this device</title>"
        f"<style>{_PAGE_CSS} h1{{color:#e5e5e5}}</style></head><body><div class='w'>"
        "<h1>Enroll this device</h1>"
        "<p>This will sign this device in to your ShellTeam dashboard and keep it "
        "signed in. Only continue on a device you own.</p>"
        "<form method='post' action='/enroll'>"
        f"<input type='hidden' name='code' value='{safe}'>"
        "<button type='submit'>Sign in this device</button>"
        "</form></div></body></html>"
    )


@router.get("/enroll")
async def confirm_enrollment(request: Request, code: str = "", _rl=Depends(_redeem_limit)):
    """Show the confirm page. Validates the code but does NOT consume it.

    Safe for scanners/prefetch to hit: consumption only happens on the POST below.
    """
    if not enrollment.peek_code(code):
        return HTMLResponse(_REDEEM_FAIL_HTML, status_code=400)
    return HTMLResponse(_confirm_html(code))


@router.post("/enroll")
async def redeem_enrollment(
    request: Request, code: str = Form(""), _rl=Depends(_redeem_limit)
):
    """Redeem a one-time link: consume the code, set the session cookie, bounce home."""
    if not enrollment.redeem_code(code):
        return HTMLResponse(_REDEEM_FAIL_HTML, status_code=400)

    resp = RedirectResponse(url="/", status_code=303)
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    # Split-credential session (see api/services/auth.py:apply_session_cookies):
    # HttpOnly host-only master + HttpOnly domain-wide read-only files credential.
    # No page JavaScript anywhere can read either.
    apply_session_cookies(resp, secure=secure)
    client = request.headers.get("x-forwarded-for", "") or (request.client.host if request.client else "?")
    log.info("Device enrolled via one-time link (client=%s)", client.split(",")[-1].strip())
    return resp

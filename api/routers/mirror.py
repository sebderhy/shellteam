"""Environment Mirror import endpoints (the laptop wizard's box side).

Two routes:

- ``GET /api/mirror/command`` (owner-authed, dashboard) mints the copy-paste
  import command for the laptop: the wizard one-liner with this box's URL and a
  24h purpose-bound upload credential baked in (never the master token).
- ``POST /api/mirror/upload`` (Bearer: master token OR live mirror credential)
  receives the wizard's tarball into ``~/.mirror-inbox/`` and asks the cockpit
  to start a migration tab immediately, so the user opens their box to an
  agent already moving them in.

**Be honest about what the 24h credential is worth.** It opens exactly one
route, but that route hands an archive to an agent running with
``--dangerously-skip-permissions`` whose skill then installs MCP servers,
dotfiles and skills out of it. Anyone who reads the credential inside its
window can therefore run code on the box. Treat it as a box credential with an
expiry, not as a narrow upload token: it is passed to the wizard through the
environment (never argv, which is world-readable in ``/proc``), and rotating
``OWNER_TOKEN`` revokes every outstanding one.

The inbox is a DOT-directory on purpose. The tarball can contain the user's
agent logins and chat history, and the file server serves ``~/<path>`` to
anything holding the weaker read-only files credential — dotfiles are the only
paths it hard-denies. A non-dot ``~/mirror-inbox`` would make credentials that
are unreachable in their native ``~/.claude`` location reachable over the web
once packed.
"""

import logging
import os
import time
from datetime import datetime, timezone

from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse

from api.config import HOME_DIR
from api.dependencies import get_current_user, require_trusted_origin
from api.routers.computers import COCKPIT_PORT
from api.services.auth import mirror_upload_cred, token_is_owner, verify_mirror_cred
from api.services.ratelimit import note_auth_failure

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mirror", tags=["mirror"])

# The laptop-side wizard scripts are served by THIS box (below), not fetched
# from GitHub: what runs on the user's laptop is then exactly the version this
# box runs, and no third party sits in the path of a command that reads the
# laptop. See docs/decisions/20260728-wizard-scripts-served-from-box.md.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
WIZARD_SCRIPTS = ("mirror-import.sh", "mirror-inventory.sh")
CRED_TTL_SECONDS = 24 * 3600
MAX_UPLOAD_MB = int(os.environ.get("MIRROR_MAX_UPLOAD_MB", "512"))
INBOX = HOME_DIR / ".mirror-inbox"

KICKOFF_PROMPT = (
    "My laptop environment just arrived via the ShellTeam import wizard: {path} "
    "(sections I selected in the wizard are inside). Please run the `migrate` "
    "skill on it now and move me in — I may not be watching yet, so proceed "
    "autonomously and finish with the migration report."
)


def _box_url(request: Request) -> str:
    host = request.headers.get("host", "localhost")
    scheme = "http" if host.split(":")[0] in ("localhost", "127.0.0.1") else "https"
    return f"{scheme}://{host}"


@router.get("/command", dependencies=[Depends(require_trusted_origin)])
async def get_import_command(request: Request, user: dict = Depends(get_current_user)) -> dict:
    """The ready-to-copy laptop command shown in Settings/onboarding."""
    exp = int(time.time()) + CRED_TTL_SECONDS
    cred = mirror_upload_cred(exp)
    # The credential rides in the ENVIRONMENT, not argv: a positional argument
    # is world-readable in /proc/<pid>/cmdline for the length of the run, so on
    # any shared laptop every other user could lift it.
    box = _box_url(request)
    command = (
        f'SHELLTEAM_MIRROR_CRED="{cred}" '
        f'bash <(curl -fsSL {box}/api/mirror/mirror-import.sh) "{box}"'
    )
    return {"command": command, "expires": exp}


@router.get("/{script_name}")
async def get_wizard_script(script_name: str) -> PlainTextResponse:
    """Serve the laptop-side wizard scripts from this box's own checkout.

    Unauthenticated on purpose: the scripts are public source code, and the
    laptop fetches them before it has any credential. Only the two fixed names
    are served — no path parameter reaches the filesystem."""
    if script_name not in WIZARD_SCRIPTS:
        raise HTTPException(status_code=404, detail="unknown script")
    return PlainTextResponse(
        (SCRIPTS_DIR / script_name).read_text(), media_type="text/x-shellscript"
    )


async def _kickoff_migration(path: str) -> bool:
    """Ask the cockpit to open a tab and start the migrate skill on ``path``."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"http://127.0.0.1:{COCKPIT_PORT}/internal/mirror/kickoff",
                json={"prompt": KICKOFF_PROMPT.format(path=path), "title": "Laptop import"},
                # Custom header (not CORS-safelisted) — the cockpit refuses this
                # endpoint without it, so a page in the owner's browser cannot
                # start an agent by POSTing here. See lib/internal-auth.mjs.
                headers={"X-Shellteam-Internal": os.environ.get("SHELLTEAM_AI_TOKEN", "")},
            )
            resp.raise_for_status()
            slot = resp.json().get("slot")
            log.info("Mirror migration started in cockpit tab %s for %s", slot, path)
            return True
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("Mirror uploaded but cockpit kickoff failed (%s) — user must start the migrate skill manually", exc)
        return False


@router.post("/upload")
async def upload_mirror(request: Request) -> dict:
    """Receive the wizard's tarball. Bearer-only auth: the laptop is not a browser."""
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    if not (verify_mirror_cred(token) or (token and token_is_owner(token))):
        note_auth_failure(request)
        raise HTTPException(status_code=401, detail="Invalid or expired import credential")

    INBOX.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = INBOX / f"shellteam-mirror-{stamp}.tar.gz"
    limit = MAX_UPLOAD_MB * 1024 * 1024
    received = 0
    try:
        with open(dest, "wb") as fh:
            os.fchmod(fh.fileno(), 0o600)
            async for chunk in request.stream():
                received += len(chunk)
                if received > limit:
                    fh.close()
                    raise HTTPException(status_code=413, detail=f"Upload exceeds {MAX_UPLOAD_MB}MB")
                fh.write(chunk)
    except BaseException:
        # ANY interruption — over-limit, client disconnect mid-stream, cancelled
        # task — must not leave a truncated tarball of the user's credentials
        # sitting in the inbox: nothing prunes it, and it never reaches the gzip
        # check that would have deleted it.
        dest.unlink(missing_ok=True)
        raise

    with open(dest, "rb") as fh:
        magic = fh.read(2)
    if received == 0 or magic != b"\x1f\x8b":
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Body is not a gzip tarball")

    log.info("Mirror tarball received: %s (%d bytes)", dest, received)
    started = await _kickoff_migration(str(dest))
    return {"ok": True, "path": str(dest), "bytes": received, "migration_started": started}

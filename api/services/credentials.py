"""CLI credential injection — bridges Composio OAuth tokens to native CLIs.

After a user OAuth's via Composio, we extract raw tokens and inject them
into container CLIs (gws) so both humans and agents get full native CLI
access.

GitHub is intentionally excluded: Composio's managed OAuth App tokens have
narrower scopes than user-issued PATs, and re-injecting them periodically
clobbers any credentials the user set up themselves with `gh auth login`.
Users authenticate to GitHub directly with their own PAT instead.
"""

import logging
import os
from pathlib import Path


from api.services import composio as composio_svc

log = logging.getLogger(__name__)

GOOGLE_TOOLKIT = "googlesuper"
CLI_TOOLKITS = {GOOGLE_TOOLKIT}



def inject_google(home_dir: Path, token: str, container_name: str | None = None) -> None:
    """Inject Google OAuth token into token file and set up cron refresh."""
    config_dir = home_dir / ".config" / "shellteam"
    config_dir.mkdir(parents=True, exist_ok=True)
    _chown(home_dir / ".config")
    _chown(config_dir)

    token_file = config_dir / "google-token"
    token_file.write_text(token)
    _chown(token_file)



def inject_all(home_dir: Path, user_id: str, container_name: str | None = None) -> None:
    """Inject CLI credentials for all connected apps.

    Writes token files to the bind-mounted home dir (works pre-start).
    If *container_name* is given and the container is running, also sets up
    in-container cron jobs.  Callers that need cron but aren't sure the
    container is ready should call ``setup_container_crons()`` separately
    after the container is up.
    """
    try:
        connections = composio_svc.list_connections(user_id)
    except Exception:
        log.warning("Failed to list Composio connections for %s", user_id, exc_info=True)
        return

    injected: list[str] = []
    for conn in connections:
        toolkit = conn.get("toolkit", "")
        if toolkit not in CLI_TOOLKITS:
            continue
        try:
            creds = composio_svc.get_credentials(conn["id"])
            if not creds or not creds.get("access_token"):
                log.warning("No access_token in Composio credentials for %s/%s", user_id, toolkit)
                continue
            token = creds["access_token"]
            if toolkit == GOOGLE_TOOLKIT:
                inject_google(home_dir, token, container_name)
            injected.append(toolkit)
        except Exception:
            log.warning("Credential injection failed for %s/%s", user_id, toolkit, exc_info=True)

    if injected:
        log.info("Injected credentials for %s: %s", user_id, ", ".join(injected))




def revoke_google(home_dir: Path, container_name: str | None = None) -> None:
    """Remove Google token file and cron job."""
    token_file = home_dir / ".config" / "shellteam" / "google-token"
    if token_file.exists():
        token_file.unlink()



def _chown(path: Path) -> None:
    """Set ownership to uid/gid 1000 (container 'user')."""
    try:
        os.chown(path, 1000, 1000)
    except PermissionError:
        pass



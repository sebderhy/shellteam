"""Shared configuration constants — single source of truth."""

import os
from pathlib import Path

APP_DOMAIN = os.environ.get("APP_DOMAIN", "localhost")
APP_URL = f"https://{APP_DOMAIN}"

# --- Single-user (OSS) ownership ---
# ShellTeam OSS is single-tenant: one owner controls the whole box. The owner's
# identity is fixed from the environment (no database, no per-request users).
OWNER_ID = os.environ.get("OWNER_ID", "owner")
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "owner@localhost")
OWNER_USERNAME = os.environ.get("OWNER_USERNAME", "owner")

# Auth model: localhost-trust by default; OWNER_TOKEN required on a public bind.
# When OWNER_TOKEN is set, every request must present it (Bearer/query/cookie).
# When empty, the box is assumed bound to localhost and all requests are trusted.
OWNER_TOKEN = os.environ.get("OWNER_TOKEN", "")

# Control-plane state (profile, port/report visibility). The default lives
# under the owner's home so a fresh native install works without any
# privileged directory setup; Cloud deployments override with DATA_DIR=/data/users.
DATA_DIR = Path(
    os.environ.get("DATA_DIR", str(Path.home() / ".local/state/shellteam/data"))
)
# True when DATA_DIR was set explicitly (Cloud, or a custom native path); the
# startup migration below only touches the default location.
DATA_DIR_OVERRIDDEN = bool(os.environ.get("DATA_DIR"))
_LEGACY_DATA_DIR = Path("/data/users")  # the pre-2026-07 Cloud-era default


def migrate_legacy_state_dir() -> None:
    """Move control-plane state from the old /data/users default to DATA_DIR.

    The DATA_DIR default moved from ``/data/users`` to
    ``~/.local/state/shellteam/data`` in 2026-07. ``install.sh`` migrates on a
    full install, but the documented upgrade path (``git pull`` + service
    restart) never runs it — so a box that never set ``DATA_DIR`` would restart
    into empty state: published reports 404, public ports flip owner-only, the
    profile resets. Mirror the installer's migration here at startup so both
    upgrade paths converge. Idempotent; logs loudly on either outcome. Called
    from the FastAPI lifespan before the state seeders.
    """
    import logging
    import shutil

    log = logging.getLogger(__name__)
    if DATA_DIR_OVERRIDDEN:
        return  # explicit DATA_DIR (incl. Cloud's /data/users) — nothing to move
    legacy = _LEGACY_DATA_DIR / OWNER_ID
    target = DATA_DIR / OWNER_ID
    if not legacy.is_dir():
        return
    if target.exists() and any(target.iterdir()):
        return  # already migrated, or fresh state already present — don't clobber
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(legacy, target, dirs_exist_ok=True)
        log.warning(
            "Migrated control-plane state %s → %s (DATA_DIR default moved off "
            "/data/users). The old copy is left in place — remove it once verified.",
            legacy, target,
        )
    except OSError:
        log.error(
            "FAILED to migrate control-plane state %s → %s. Published reports and "
            "public-port visibility stay empty until resolved — copy it manually or "
            "set DATA_DIR=%s in .env and restart.",
            legacy, target, _LEGACY_DATA_DIR, exc_info=True,
        )

# Hosts that serve the dashboard + the owner's files directly (not `<user>.`
# subdomains). VPS_IP must be set explicitly in production — no hardcoded
# default. EXTRA_MAIN_HOSTS lets a deployment register additional hostnames
# (e.g. a staging domain) so SubdomainProxyMiddleware treats them as the main
# host instead of trying to resolve them as `<user>.<APP_DOMAIN>`.
_vps_ip = os.environ.get("VPS_IP", "")
_extra_main_hosts = {
    h.strip() for h in os.environ.get("EXTRA_MAIN_HOSTS", "").split(",") if h.strip()
}
MAIN_HOSTS = (
    {APP_DOMAIN, "localhost", "127.0.0.1"}
    | ({_vps_ip} if _vps_ip else set())
    | _extra_main_hosts
)

# --- Runtime backend ---
# The public edition is always native: agents + services run as host processes.
RUNTIME = "native"

# --- Opt-in modules (the core-purity gate) ---
# Empty (the default) = pure core: cockpit-spawned agents get ZERO ShellTeam
# injection — no plugin/skills, no MCP servers, no appended system prompt;
# behavior is bit-identical to running the CLI by hand (contract-tested).
# Each module re-enables exactly the layer pieces it needs:
#   persona  — ShellTeam's system prompt + skills + hooks + docs MCP (context7,
#              deepwiki): the full "assistant with superpowers" experience
#   browser  — the shared Steel browser MCP (part of install.sh --full)
#   composio — Composio app connections over MCP (also needs COMPOSIO_API_KEY)
#   linear   — Linear MCP (also needs LINEAR_API_KEY)
#   dreaming — nightly knowledge consolidation: a systemd --user timer sweeps the
#              day's agent sessions into ~/.shellteam/knowledge/ (per-folder
#              tree), agents spawn with their folder's knowledge, and the
#              dashboard gains a Knowledge tab
#              (see docs/decisions/20260708-dreaming-v1.md)
KNOWN_MODULES = {"persona", "browser", "composio", "linear", "dreaming"}
def parse_modules(value: str) -> list[str]:
    """Normalize a MODULES= comma list (shared with the feature-keys .env
    round-trip, so the two can never parse the same line differently)."""
    return [m.strip().lower() for m in value.split(",") if m.strip()]


MODULES = frozenset(parse_modules(os.environ.get("MODULES", "")))


def validate_modules() -> None:
    """Log unknown MODULES entries loudly (called from the API lifespan)."""
    import logging

    unknown = MODULES - KNOWN_MODULES
    if unknown:
        logging.getLogger(__name__).error(
            "Unknown MODULES entries %s ignored — known modules: %s",
            sorted(unknown), sorted(KNOWN_MODULES),
        )

# The single owner's home directory — where agent config is materialized and
# where the cloud-computer file server is rooted. In the native edition this is
# the VPS user's $HOME (no per-user partitioning).
HOME_DIR = Path(os.environ.get("SHELLTEAM_HOME", str(Path.home())))

# Port the cloud-computer file server (nginx) listens on. The subdomain proxy
# forwards bare-username requests (no "-<port>" suffix) here, and this is the
# "default port" that carries public-folder / guest-chat auth semantics. Override
# via FILE_PORT in .env when :80 is already taken (e.g. FILE_PORT=8081). Values
# >= 1024 need no privileged bind, so install.sh skips the nginx setcap step.
FILE_PORT = int(os.environ.get("FILE_PORT", "80"))

# "Made with ShellTeam" footer on HTML served to third parties — published
# reports and signed share links. The owner's own views are never badged
# (docs/decisions/20260715-share-footer.md). Set SHARE_FOOTER=false to disable.
SHARE_FOOTER = os.environ.get("SHARE_FOOTER", "true").strip().lower() not in (
    "0", "false", "no", "off",
)

# Branded 404 page (dark theme, matches app design)
NOT_FOUND_HTML = (
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    '<title>404 \u2014 ShellTeam</title>'
    '<link rel="icon" type="image/svg+xml" href="/static/favicon.svg?v=3">'
    '<style>'
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    'background:#0a0a0a;color:#e5e5e5;font-family:system-ui,-apple-system,sans-serif;'
    'text-align:center}'
    '.wrap{max-width:400px;padding:24px}'
    'h1{font-size:4rem;margin:0;color:#f59e0b;font-weight:700}'
    'p{color:#888;line-height:1.6;margin:16px 0 32px}'
    'a{display:inline-block;padding:10px 24px;background:#f59e0b;color:#0a0a0a;'
    'border-radius:8px;text-decoration:none;font-weight:600;font-size:0.9rem}'
    'a:hover{background:#d97706}'
    '</style></head><body><div class="wrap">'
    '<h1>404</h1>'
    '<p>This page doesn\u2019t exist. It may have been moved or you may have mistyped the URL.</p>'
    '<a href="/">Back to ShellTeam</a>'
    '</div></body></html>'
)

# Same visual shell, guest flavor: shown when a guest link/cookie is invalid,
# expired, or revoked. Deliberately does not say which.
GUEST_DENIED_HTML = NOT_FOUND_HTML.replace(
    "<h1>404</h1>", "<h1>401</h1>"
).replace(
    "This page doesn\u2019t exist. It may have been moved or you may have mistyped the URL.",
    "This guest link is invalid, expired, or was revoked. "
    "Ask the owner for a fresh link.",
).replace('<a href="/">Back to ShellTeam</a>', "").replace(
    "<title>404 \u2014 ShellTeam</title>", "<title>Guest access \u2014 ShellTeam</title>"
)

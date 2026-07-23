"""Composio integration — Tool Router for 500+ app connections via MCP.

Uses Composio's Tool Router (not the legacy MCP API) so the AI agent sees
only ~6 meta-tools (search, connect, execute) instead of thousands of
individual action schemas.  Any app the user connects is discoverable at
runtime through COMPOSIO_SEARCH_TOOLS.
"""

import logging
import os
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

_client = None


def is_configured() -> bool:
    """Whether the optional Composio integration has an API key right now."""
    return bool(os.environ.get("COMPOSIO_API_KEY", "").strip())


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("COMPOSIO_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("COMPOSIO_API_KEY not set")
        # Imported here, not at module top: merely importing the SDK creates
        # ~/.composio/ as a side effect, and this module is reached from the
        # always-imported integrations router — a pure-core box with no
        # Composio key must leave zero footprint (round-6 audit P2-03).
        from composio import Composio

        _client = Composio(api_key=api_key)
    return _client


GOOGLESUPER_SLUG = "googlesuper"
GOOGLESUPER_COVERED_SUBTOOLKITS = (
    "gmail",
    "googledrive",
    "googlecalendar",
    "googledocs",
    "googlesheets",
    "googletasks",
    "googlephotos",
    "googlecontacts",
    "googlemeet",
)


def _fetch_active_toolkit_slugs(user_id: str) -> set[str]:
    """Return the set of toolkit slugs the user currently has ACTIVE connections for.

    Returns an empty set if the Composio API is unreachable — the caller should
    treat that as "no filtering" so container startup never blocks on Composio.
    """
    try:
        return {c["toolkit"] for c in list_connections(user_id)}
    except Exception:
        log.warning("Failed to list Composio connections for %s", user_id, exc_info=True)
        return set()


def _subtoolkits_shadowed_by_googlesuper(connected: set[str]) -> list[str]:
    """Sub-toolkits whose actions are already covered by the user's googlesuper connection.

    A sub-toolkit is shadowed only when the user has googlesuper AND has NOT
    connected that sub-toolkit individually — so a user who explicitly connects
    just Gmail keeps the dedicated GMAIL_* catalog.
    """
    if GOOGLESUPER_SLUG not in connected:
        return []
    return [s for s in GOOGLESUPER_COVERED_SUBTOOLKITS if s not in connected]


def _build_session_kwargs(user_id: str) -> dict:
    kwargs: dict = {
        "user_id": user_id,
        "manage_connections": {"enable": True, "wait_for_connections": True},
    }
    shadowed = _subtoolkits_shadowed_by_googlesuper(_fetch_active_toolkit_slugs(user_id))
    if shadowed:
        kwargs["toolkits"] = {"disable": shadowed}
        log.info("Tool Router for %s: disabling %s (shadowed by googlesuper)", user_id, shadowed)
    return kwargs


def generate_mcp_config(user_id: str) -> dict:
    """Create a Tool Router session and return MCP server config for Claude Code.

    When the user has `googlesuper` connected, sub-toolkits it shadows are
    disabled so COMPOSIO_SEARCH_TOOLS surfaces GOOGLESUPER_* actions instead of
    dead-end "gmail not connected" branches. Individually-connected Google
    sub-toolkits are preserved. Without googlesuper, the full catalogue is
    available as before.
    """
    client = _get_client()
    session = client.create(**_build_session_kwargs(user_id))
    log.info("Created Tool Router session %s for user %s", session.session_id, user_id)
    return {
        "type": "http",
        "url": session.mcp.url,
        "headers": session.mcp.headers,
    }


def refresh_mcp_in_claude_json(user_id: str, home_dir: Path) -> None:
    """Regenerate the Tool Router session and update ~/.claude.json.

    Called after connection state changes (new OAuth, disconnect) so the
    coding agent's Composio MCP reflects current toolkit availability —
    e.g. disabling gmail when googlesuper is connected.

    Failures are logged but never propagated — credential sync must not
    break because of a Composio API hiccup.
    """
    import json
    claude_json = Path(home_dir) / ".claude.json"
    if not claude_json.exists():
        log.warning("No .claude.json at %s — skipping MCP refresh", claude_json)
        return

    try:
        mcp_config = generate_mcp_config(user_id)
    except Exception:
        log.warning("Composio MCP refresh failed for %s — keeping existing session", user_id, exc_info=True)
        return

    existing = json.loads(claude_json.read_text())
    existing.setdefault("mcpServers", {})["composio"] = mcp_config
    claude_json.write_text(json.dumps(existing, indent=2))
    log.info("Refreshed Composio MCP session in %s for user %s", claude_json, user_id)


def list_connections(user_id: str) -> list[dict]:
    """List active connected accounts for a user."""
    client = _get_client()
    result = client.connected_accounts.list(
        user_ids=[user_id],
        statuses=["ACTIVE"],
    )
    return [
        {
            "id": item.id,
            "toolkit": item.toolkit.slug if hasattr(item.toolkit, "slug") else str(item.toolkit),
            "status": item.status,
            "created_at": str(item.created_at) if item.created_at else None,
        }
        for item in result.items
    ]


def get_required_fields(toolkit: str) -> list[dict]:
    """Get required fields for connecting a toolkit (via REST API).

    Returns list of {name, displayName, description, type} dicts.
    Empty list means simple OAuth with no extra params needed.
    """
    api_key = os.environ.get("COMPOSIO_API_KEY", "")
    resp = httpx.get(
        f"https://backend.composio.dev/api/v3/toolkits/{toolkit}",
        headers={"x-api-key": api_key},
    )
    resp.raise_for_status()
    data = resp.json()
    # Find the Composio-managed auth scheme's initiation fields
    for ac in data.get("auth_config_details", []):
        if ac.get("mode") in data.get("composio_managed_auth_schemes", []):
            initiation = ac.get("fields", {}).get("connected_account_initiation", {})
            return [
                {
                    "name": f["name"],
                    "displayName": f.get("displayName", f["name"]),
                    "description": f.get("description", ""),
                    "type": f.get("type", "string"),
                }
                for f in initiation.get("required", [])
            ]
    return []


def initiate_connection(
    user_id: str,
    toolkit: str,
    callback_url: str,
    config_params: dict | None = None,
) -> str:
    """Start OAuth flow for a toolkit. Returns the redirect URL."""
    client = _get_client()
    # toolkits.authorize() doesn't forward callback_url, so call the
    # underlying connected_accounts.initiate() directly.
    auth_config_id = client.toolkits._get_auth_config_id(toolkit=toolkit)

    kwargs: dict = {
        "user_id": user_id,
        "auth_config_id": auth_config_id,
        "callback_url": callback_url,
    }
    if config_params:
        kwargs["config"] = {"auth_scheme": "OAUTH2", "val": config_params}

    connection_request = client.connected_accounts.initiate(**kwargs)
    return connection_request.redirect_url


def get_credentials(connection_id: str) -> dict | None:
    """Retrieve raw OAuth tokens for a connected account."""
    client = _get_client()
    account = client.connected_accounts.get(nanoid=connection_id)
    if not hasattr(account, "state") or not account.state:
        return None
    val = account.state.val
    return {
        "access_token": getattr(val, "access_token", None),
        "refresh_token": getattr(val, "refresh_token", None),
        "token_type": getattr(val, "token_type", None),
    }


def refresh_and_get_credentials(connection_id: str) -> dict | None:
    """Refresh OAuth token via Composio and return fresh credentials."""
    client = _get_client()
    client.connected_accounts.refresh(nanoid=connection_id)
    return get_credentials(connection_id)


def disconnect(connected_account_id: str) -> None:
    """Delete a connected account."""
    client = _get_client()
    client.connected_accounts.delete(connected_account_id)

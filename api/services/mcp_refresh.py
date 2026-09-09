"""Refresh MCP config after integration state changes.

Native ShellTeam is additive: it must never mutate the owner's real coding-agent
dotfiles. Docker/Cloud still owns a per-container home, so refreshing
``~/.claude.json`` there remains the correct path.
"""

import logging
from pathlib import Path

from api.config import OWNER_USERNAME, RUNTIME
from api.services import composio as composio_svc

log = logging.getLogger(__name__)


def refresh_composio_mcp(user_id: str, home_dir: Path, email: str = "") -> None:
    """Reflect a Composio connection change in coding agents' MCP config.

    Docker (Cloud): update the bind-mounted per-container ``~/.claude.json``.
    Native (OSS): rebuild ShellTeam's additive agent-layer instead; it carries
    the generated Composio MCP server while leaving user dotfiles untouched.
    """
    home_dir = Path(home_dir)


    from api.services.agent_layer import build_agent_layer

    build_agent_layer(home_dir, OWNER_USERNAME, user_id=user_id, email=email)
    log.info(
        "Rebuilt agent-layer to refresh Composio MCP for %s (native; dotfiles untouched)",
        user_id,
    )

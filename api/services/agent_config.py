"""Agent config materialization — filesystem setup shared by all coding agents.

`~/.claude.json` (mcpServers) is the single source of truth; this module fans it
out to Codex (`config.toml`) and Gemini (`settings.json`) on every start. This is plain filesystem setup with no Docker
dependency, so it is preserved as-is for the native (non-containerized) edition.
"""

import json
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

CONFIG_TEMPLATE_DIR = Path(__file__).parent.parent.parent / "computer" / "claude-config"
SHARED_TEMPLATE_DIR = Path(__file__).parent.parent.parent / "computer" / "shared"

# Native edition runs the control plane on localhost — no Docker bridge gateway.
AI_PROXY_BASE = os.environ.get("AI_PROXY_BASE", "http://127.0.0.1:8000")




def _chown_safe(path: Path) -> None:
    """Best-effort ownership fixup when ``AGENT_UID`` is configured."""
    uid = os.environ.get("AGENT_UID")
    if not uid:
        return
    try:
        os.chown(path, int(uid), int(uid), follow_symlinks=False)
    except (PermissionError, FileNotFoundError, ValueError):
        pass






KNOWLEDGE_FILES = {
    "identity": "# Identity\n\n<!-- Who the user is — name, role, expertise, background -->\n",
    "projects": "# Projects\n\n<!-- Active projects — goals, priorities, deadlines, tech stack -->\n",
    "preferences": "# Preferences\n\n<!-- Communication style, tool preferences, pet peeves -->\n",
    "feedback": "# Feedback\n\n<!-- Corrections and confirmed approaches from the user -->\n",
    "contacts": "# Contacts\n\n<!-- People the user works with — names, roles, context -->\n",
}


def _setup_knowledge_layer(home_dir: Path, username: str) -> None:
    """Create ~/.shellteam/knowledge/ with seed templates for new users.

    Only creates files that don't already exist — preserves existing knowledge.
    """
    knowledge_dir = home_dir / ".shellteam" / "knowledge"
    knowledge_dir.mkdir(parents=True, exist_ok=True)

    for name, template in KNOWLEDGE_FILES.items():
        path = knowledge_dir / f"{name}.md"
        if not path.exists():
            path.write_text(template)

    # Ensure ownership is correct (no-op on native)
    for p in (home_dir / ".shellteam").rglob("*"):
        _chown_safe(p)
    _chown_safe(home_dir / ".shellteam")

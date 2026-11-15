"""The MCP relay (SHE-203): agents reach MCP servers that need a key through
the control plane, which adds the key on the way out.

Why: the launch layer is read by every agent, and an agent that opens one of
its files prints whatever is in it. On 14 Nov 2026 that printed the Composio
key into a transcript. With the relay, the layer holds an address on this box
and a token that only opens the relay (``internal_auth.mcp_relay_token``);
the key never leaves ShellTeam's own process.

The key is read when the request is forwarded, from ShellTeam's ``.env`` as
it is on disk now (the secrets vault rewrites it when the owner replaces a
key), so a replaced key works on the next call with no rebuild or restart.

Servers:
  composio  Composio's Tool Router session (its URL is made when the layer is
            built and kept in ``relay/composio.json``; it is not a secret)
  linear    Linear's hosted MCP, with the project's own key when the project
            has one (``/internal/mcp/linear/<top folder>``)
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from api.config import API_PORT, HOME_DIR
from api.services import feature_keys, internal_auth

LINEAR_URL = "https://mcp.linear.app/mcp"
SERVERS = ("composio", "linear")
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class MissingKey(LookupError):
    """No key for this server: said to the agent, never forwarded upstream."""


def relay_server(name: str, project: str = "") -> dict:
    """The MCP server entry a launch layer carries for ``name``."""
    url = f"http://127.0.0.1:{API_PORT}/internal/mcp/{name}" + (f"/{project}" if project else "")
    return {"type": "http", "url": url,
            "headers": {"Authorization": f"Bearer {internal_auth.mcp_relay_token()}"}}


def _composio_session_file() -> Path:
    from api.services.agent_layer import layer_dir
    return layer_dir(HOME_DIR) / "relay" / "composio.json"


def remember_composio_session(url: str) -> None:
    path = _composio_session_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"url": url}))


def _env_value(path: Path, name: str) -> str | None:
    """``name``'s value in a dotenv file, as the cockpit reads it
    (``readEnvValue`` in computer/ai-chat/lib/agent-layer.mjs)."""
    if not path.is_file():
        return None
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(name)}\s*=\s*(.*)\s*$")
    for line in path.read_text().splitlines():
        m = pattern.match(line)
        if not m:
            continue
        v = m.group(1).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        else:
            v = re.sub(r"\s+#.*$", "", v).strip()
        return v or None
    return None


def current_key(name: str) -> str | None:
    """ShellTeam's own key ``name`` as it is now: the .env on disk, then the
    process environment (a box configured by its unit file only)."""
    return _env_value(feature_keys.env_file_path(), name) or os.environ.get(name) or None


def _slug(project: str) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^A-Za-z0-9]+", "_", project)).upper()


def linear_key(project: str = "") -> str | None:
    """The Linear key for a top folder, by the cockpit's rules
    (``linearKeyForCwd``): ``<PROJECT>_LINEAR_API_KEY`` or
    ``LINEAR_API_KEY_<PROJECT>``, then the project's ``.env`` or
    ``code/.env``, then ShellTeam's own ``LINEAR_API_KEY``."""
    if project:
        slug = _slug(project)
        for name in (f"{slug}_LINEAR_API_KEY", f"LINEAR_API_KEY_{slug}"):
            if value := current_key(name):
                return value
        root = HOME_DIR / project
        for path in (root / ".env", root / "code" / ".env"):
            if value := _env_value(path, "LINEAR_API_KEY"):
                return value
    return current_key("LINEAR_API_KEY")


def upstream(server: str, project: str = "") -> tuple[str, dict[str, str]]:
    """Where to forward and the key header to add. Raises MissingKey."""
    if server == "composio":
        key = current_key("COMPOSIO_API_KEY")
        session = _composio_session_file()
        if not key or not session.is_file():
            raise MissingKey("COMPOSIO_API_KEY")
        return json.loads(session.read_text())["url"], {"x-api-key": key}
    if server == "linear":
        key = linear_key(project)
        if not key:
            raise MissingKey("LINEAR_API_KEY")
        return LINEAR_URL, {"Authorization": f"Bearer {key}"}
    raise KeyError(server)


def valid_project(project: str) -> bool:
    return bool(PROJECT_RE.match(project)) and ".." not in project

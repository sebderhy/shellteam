"""SHE-165: follow-ups from the 2026-11-10 audit."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_the_file_editor_loads_no_script_from_another_site():
    # /_editor runs on the dashboard origin (it is exempt from the content
    # sandbox), so a script from a CDN there is a script with the owner's
    # session. Monaco came from jsDelivr with no integrity check.
    html = (ROOT / "computer" / "file-editor.html").read_text()
    assert not re.findall(r"""(?:src|href)=["']https?://""", html)
    assert "paths: { vs: '/_editor/vs' }" in html
    install = (ROOT / "install.sh").read_text()
    assert 'cp -r "$MONACO_SRC" "$STATE/file-editor/vs"' in install
    lock = (ROOT / "computer" / "ai-chat" / "package-lock.json").read_text()
    assert '"node_modules/monaco-editor"' in lock and "sha512-" in lock


def test_mcp_keys_reach_codex_by_environment_not_argv(tmp_path):
    # `-c mcp_servers.x.http_headers={...}` put the Composio and Linear keys in
    # Codex's argv, readable in `ps` by every local user.
    import json

    from api.services import agent_layer

    servers = {
        "composio": {"url": "https://mcp.example.com/mcp", "headers": {"x-api-key": "ck_live_secret"}},
        "context7": {"command": "context7-mcp"},
    }
    overrides = agent_layer.build_codex_overrides(tmp_path, servers)
    assert not any("ck_live_secret" in o for o in overrides)
    assert 'mcp_servers.composio.env_http_headers={ "x-api-key" = "SHELLTEAM_MCP_COMPOSIO_X_API_KEY_SECRET" }' in [
        " ".join(o.split()) for o in overrides
    ] or any("SHELLTEAM_MCP_COMPOSIO_X_API_KEY_SECRET" in o and "env_http_headers" in o for o in overrides)
    assert agent_layer.codex_header_env(servers) == {"SHELLTEAM_MCP_COMPOSIO_X_API_KEY_SECRET": "ck_live_secret"}
    assert json.dumps(overrides)  # stays plain JSON for the Node spawner


def test_install_time_sudo_is_removed_even_when_the_install_is_interrupted():
    src = (ROOT / "install.sh").read_text()
    grant = src.index("NOPASSWD:ALL\\n' \"$user\" > \"/etc/sudoers.d/$user\"")
    handoff = src.index('su - "$user" -c', grant)
    between = src[grant:handoff]
    assert "trap \"rm -f '/etc/sudoers.d/$user'\" EXIT INT TERM HUP" in between

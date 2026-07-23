"""Tests for the additive Claude launch-layer (api/services/agent_layer.py).

The cardinal invariant: building the layer NEVER writes to the owner's
coding-agent dotfiles. See docs/design/vps-footprint.md.

These tests exercise the FULL layer (all modules on). The pure-core default
(no modules → no layer) is covered by tests/test_purity_gate.py.
"""

import json
import os
from pathlib import Path

import pytest

from api.services.agent_layer import (
    antigravity_plugin_dir,
    antigravity_workspace_dir,
    build_agent_layer,
    build_codex_overrides,
    canonical_mcp_servers,
    claude_mcp_config_file,
    claude_plugin_dir,
    claude_system_prompt_file,
    codex_overrides_file,
    codex_session_home_dir,
    harness_skills_dir,
    opencode_config_file,
)

FULL = frozenset({"persona", "browser", "composio", "linear"})


def full_mcp(home: Path) -> dict:
    return canonical_mcp_servers(home, modules=FULL)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    return tmp_path


def test_build_does_not_touch_user_dotfiles(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    # The whole point: NONE of the agents' config dirs are created or modified.
    assert not (home / ".claude").exists()
    assert not (home / ".claude.json").exists()
    assert not (home / ".gitconfig").exists()
    assert not (home / ".codex").exists()
    assert not (home / ".config" / "opencode").exists()
    assert not (home / ".gemini").exists()


def test_codex_overrides_are_additive_c_flags(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    overrides = json.loads(codex_overrides_file(home).read_text())
    # Each entry is a TOML key=value string for a Codex `-c` flag; never writes config.
    assert any(o.startswith("mcp_servers.browser.command=") for o in overrides)
    assert any(o.startswith("project_doc_fallback_filenames=") for o in overrides)
    # Values must be valid TOML: JSON literals (strings/arrays) or inline tables —
    # a Python repr (single-quoted) would fail json.loads.
    for o in overrides:
        value = o.split("=", 1)[1]
        if not value.startswith("{"):  # inline tables are built by _toml_value
            json.loads(value)


def test_codex_overrides_leave_the_shared_prompt_to_the_launch_adapter(home: Path):
    """The dynamic launch adapter reads the same rendered prompt Claude gets.

    Keeping it out of the static overrides file lets the adapter append the
    current workspace's dreaming knowledge exactly once for every agent family.
    """
    build_agent_layer(home, "alice", modules=FULL)
    overrides = json.loads(codex_overrides_file(home).read_text())
    dev = [o for o in overrides if o.startswith("developer_instructions=")]
    assert dev == []
    prompt = claude_system_prompt_file(home).read_text()
    assert "Always share URLs, never paths" in prompt
    assert "/_editor/" in prompt
    assert "{username}" not in prompt  # hydrated for the real owner
    assert not any(o.startswith("model_instructions_file") for o in overrides)


def test_codex_overrides_omit_developer_instructions_without_persona(home: Path):
    # Purity gate: no persona module → no injected instructions of any kind.
    overrides = build_codex_overrides(
        home, full_mcp(home), include_doc_fallback=False, developer_instructions=None
    )
    assert not any(o.startswith("developer_instructions=") for o in overrides)


def test_codex_overrides_omit_runtime_provider(home: Path):
    # The OpenAI provider depends on runtime key state — added by the cockpit at
    # spawn, never baked into the built layer.
    overrides = build_codex_overrides(home, full_mcp(home))
    assert not any("model_provider" in o for o in overrides)


def test_opencode_config_points_at_layer_not_user_dirs(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    cfg = json.loads(opencode_config_file(home).read_text())
    # Every adapter reads the same canonical skills and rendered prompt.
    assert cfg["skills"]["paths"] == [str(harness_skills_dir(home))]
    assert cfg["instructions"] == [str(claude_system_prompt_file(home))]
    assert "fireworks" in cfg["provider"]


def test_layer_structure_and_plugin_contents(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    plugin = claude_plugin_dir(home)
    assert (plugin / ".claude-plugin" / "plugin.json").is_file()
    assert (plugin / "hooks" / "hooks.json").is_file()
    assert (plugin / "skills").is_dir() and any((plugin / "skills").iterdir())
    assert claude_system_prompt_file(home).is_file()
    # MCP must NOT live in the plugin (Claude Code won't surface plugin MCP tools);
    # it rides in a standalone --mcp-config file instead.
    assert not (plugin / ".mcp.json").exists()


def test_shared_harness_has_identical_prompt_skills_and_mcp_set_for_all_agents(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    canonical_skills = harness_skills_dir(home)
    claude_skills = claude_plugin_dir(home) / "skills"
    antigravity = antigravity_plugin_dir(home)
    codex_skills = codex_session_home_dir(home) / ".agents" / "skills"

    def skill_files(root: Path) -> dict[str, str]:
        return {
            str(path.relative_to(root)): path.read_text()
            for path in root.rglob("SKILL.md")
        }

    expected_skills = skill_files(canonical_skills)
    assert skill_files(claude_skills) == expected_skills
    assert skill_files(antigravity / "skills") == expected_skills
    assert skill_files(codex_skills) == expected_skills

    prompt = claude_system_prompt_file(home).read_text()
    assert (antigravity / "rules" / "shellteam.md").read_text() == prompt

    canonical_mcp = json.loads(claude_mcp_config_file(home).read_text())["mcpServers"]
    opencode_mcp = json.loads(opencode_config_file(home).read_text())["mcp"]
    antigravity_mcp = json.loads((antigravity / "mcp_config.json").read_text())["mcpServers"]
    assert set(opencode_mcp) == set(canonical_mcp)
    assert set(antigravity_mcp) == set(canonical_mcp)
    assert antigravity_mcp["deepwiki"]["serverUrl"] == canonical_mcp["deepwiki"]["url"]

    # The actual Antigravity plugin lives in ShellTeam's own workspace, not
    # ~/.gemini or the project currently being worked on.
    assert antigravity_workspace_dir(home).is_dir()


def test_mcp_servers_in_standalone_config_not_plugin(home: Path):
    """MCP servers go to claude-mcp.json (loaded via --mcp-config), since Claude
    Code health-checks but does not expose a plugin's MCP tools to the agent."""
    build_agent_layer(home, "alice", modules=FULL)
    mcp_cfg = json.loads(claude_mcp_config_file(home).read_text())
    servers = mcp_cfg["mcpServers"]
    assert "browser" in servers  # the canonical set is present here, not in the plugin
    assert set(servers) == set(full_mcp(home))


def test_plugin_hooks_point_at_repo_not_cloud_path(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    hooks = (claude_plugin_dir(home) / "hooks" / "hooks.json").read_text()
    # The Cloud template hardcodes /opt/claude-config; the layer must rewrite it.
    assert "/opt/claude-config" not in hooks
    # Plugin hooks.json must be wrapped in a top-level "hooks" record.
    assert "PreToolUse" in json.loads(hooks)["hooks"]


def test_browser_mcp_rendered_for_this_box(home: Path):
    mcp = full_mcp(home)
    args = mcp["browser"]["args"]
    # output-dir points at the real home, not the Cloud /home/user.
    assert str(home / "tmp") in args
    assert "/home/user/tmp" not in args


def test_linear_mcp_is_opt_in_on_api_key(home: Path, monkeypatch):
    """Linear MCP appears only when LINEAR_API_KEY is set, authed via the
    Authorization: Bearer header on the hosted server (no interactive OAuth)."""
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    assert "linear" not in full_mcp(home)

    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_secret")
    linear = full_mcp(home)["linear"]
    assert linear["url"] == "https://mcp.linear.app/mcp"
    assert linear["headers"]["Authorization"] == "Bearer lin_api_secret"


def test_persona_has_no_unrendered_placeholders(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    persona = claude_system_prompt_file(home).read_text()
    assert "{username}" not in persona
    assert "/home/user" not in persona


def test_rebuild_is_idempotent(home: Path):
    build_agent_layer(home, "alice", modules=FULL)
    first = sorted(p.name for p in (claude_plugin_dir(home) / "skills").iterdir())
    build_agent_layer(home, "alice", modules=FULL)  # rebuild from scratch
    second = sorted(p.name for p in (claude_plugin_dir(home) / "skills").iterdir())
    assert first == second




# --- SHE-77: file-URL guidance must track the CURRENT APP_DOMAIN -------------------
# A §4.5 install renders the layer while .env still says localhost; the persona
# then taught dead `https://<owner>.localhost/…` links forever. Two halves:
# the localhost render must emit WORKING main-domain-path URLs (not the
# subdomain passthrough), and the API lifespan must re-render the layer on
# every boot so "edit .env + restart" converges.


def test_localhost_render_emits_reachable_main_domain_urls(home: Path):
    """APP_DOMAIN=localhost (conftest): no `<owner>.localhost` subdomain links —
    the canonical form is `http://localhost:<API_PORT>/<path>`."""
    from api.services.agent_layer import _persona_template_with_environment, _render_box_template

    rendered = _render_box_template(_persona_template_with_environment(), "owner", home)
    assert "owner.localhost" not in rendered
    assert "{username}" not in rendered
    api_port = os.environ.get("API_PORT", "8000")
    assert f"http://localhost:{api_port}/tmp/chart.png" in rendered
    # Port previews point at the sibling local port, not a dead https subdomain.
    assert "http://localhost:3000" in rendered
    assert "https://owner-3000.localhost" not in rendered


def test_domain_render_uses_app_domain_everywhere(home: Path, monkeypatch):
    """APP_DOMAIN=box.example.com: file URLs ride the domain, port hosts hang off
    its registrable base, and no localhost form survives."""
    import api.services.agent_layer as al

    monkeypatch.setattr(al, "APP_DOMAIN", "box.example.com")
    rendered = al._render_box_template(al._persona_template_with_environment(), "owner", home)
    assert "https://box.example.com/tmp/chart.png" in rendered
    assert ".localhost" not in rendered
    assert "owner.localhost" not in rendered
    # Port previews hang off the FULL dashboard domain (`<owner>-<port>.<APP_DOMAIN>`,
    # what SUBDOMAIN_RE matches + the Caddy wildcard covers) — the old
    # registrable-base rewrite taught `owner-PORT.example.com`, which resolves nowhere.
    assert "owner-PORT.box.example.com" in rendered
    assert "owner-PORT.example.com" not in rendered


def test_lifespan_rematerializes_agent_layer(monkeypatch):
    """The API boot must re-render the layer from current config (the SHE-77 root
    cause: nothing did after install, so a §4.5 domain flip never landed). The
    pytest guard is lifted and the materializer mocked so no real HOME is touched."""
    from unittest.mock import patch as _patch
    from fastapi.testclient import TestClient
    from api.main import app

    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    with _patch("api.services.processes._materialize_config") as mock_mat:
        with TestClient(app):
            pass
    assert mock_mat.called, "lifespan must re-render the agent layer on boot"

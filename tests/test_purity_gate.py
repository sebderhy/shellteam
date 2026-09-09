"""The core-purity gate (docs/decisions/20260704-purity-gate-modules.md).

The headline guarantee: with no MODULES enabled (the default), a cockpit-spawned
agent is bit-identical to a hand-run CLI — no plugin/skills, no MCP servers, no
appended system prompt. The Node half of the contract (spawn argv) is pinned in
computer/ai-chat/test/purity-contract.test.mjs; this half pins the builder: pure
core produces NO behavior-injecting artifacts, and each module re-adds exactly
its own pieces.
"""

import json
from pathlib import Path

import pytest

from api.services.agent_layer import (
    antigravity_workspace_dir,
    build_agent_layer,
    canonical_mcp_servers,
    claude_mcp_config_file,
    claude_plugin_dir,
    claude_system_prompt_file,
    codex_overrides_file,
    codex_session_home_dir,
    harness_skills_dir,
    layer_manifest_file,
    opencode_config_file,
)

CORE = frozenset()
FULL = frozenset({"persona", "browser", "composio", "linear"})


@pytest.fixture
def home(tmp_path: Path) -> Path:
    return tmp_path


def manifest(home: Path) -> dict:
    return json.loads(layer_manifest_file(home).read_text())


class TestPureCore:
    def test_no_injection_artifacts(self, home: Path):
        build_agent_layer(home, "alice", modules=CORE)
        assert not claude_plugin_dir(home).exists()
        assert not claude_system_prompt_file(home).exists()
        assert not claude_mcp_config_file(home).exists()
        assert not codex_overrides_file(home).exists()
        assert not harness_skills_dir(home).exists()
        assert not antigravity_workspace_dir(home).exists()
        assert not codex_session_home_dir(home).exists()

    def test_manifest_records_pure_core(self, home: Path):
        build_agent_layer(home, "alice", modules=CORE)
        m = manifest(home)
        assert m["modules"] == []
        assert m["artifacts"] == {
            "claude_plugin": False,
            "claude_mcp": False,
            "claude_system_prompt": False,
            "codex_overrides": False,
            "codex_session_home": False,
            "harness_skills": False,
            "antigravity_plugin": False,
            "opencode_config": True,
        }

    def test_opencode_config_is_provider_only(self, home: Path):
        """The one core-mode artifact: OpenCode's proxied provider (credential
        plumbing — without it the agent can't run). Zero behavior injection."""
        build_agent_layer(home, "alice", modules=CORE)
        cfg = json.loads(opencode_config_file(home).read_text())
        assert "fireworks" in cfg["provider"]
        assert "mcp" not in cfg
        assert "skills" not in cfg
        assert "instructions" not in cfg

    def test_no_mcp_servers(self, home: Path):
        assert canonical_mcp_servers(home, modules=CORE) == {}

    def test_default_modules_are_pure_core(self, home: Path):
        """conftest pins MODULES='' — the builder's default must be pure core."""
        build_agent_layer(home, "alice")  # no modules argument: reads config
        assert manifest(home)["modules"] == []
        assert not claude_plugin_dir(home).exists()


class TestDowngradePurges:
    def test_full_then_core_removes_everything(self, home: Path):
        """Purity means ABSENT: a box switching to core sheds the layer, so a
        stale artifact can't silently keep injecting."""
        build_agent_layer(home, "alice", modules=FULL)
        assert claude_plugin_dir(home).is_dir()
        assert claude_mcp_config_file(home).is_file()

        build_agent_layer(home, "alice", modules=CORE)
        assert not claude_plugin_dir(home).exists()
        assert not claude_system_prompt_file(home).exists()
        assert not claude_mcp_config_file(home).exists()
        assert not codex_overrides_file(home).exists()
        assert not harness_skills_dir(home).exists()
        assert not antigravity_workspace_dir(home).exists()
        assert not codex_session_home_dir(home).exists()
        assert manifest(home)["modules"] == []


class TestPerModuleGranularity:
    def test_browser_only(self, home: Path):
        """browser module: the browser MCP and NOTHING else — no persona, no
        skills, no docs MCP."""
        build_agent_layer(home, "alice", modules={"browser"})
        assert not claude_plugin_dir(home).exists()
        assert not claude_system_prompt_file(home).exists()
        servers = json.loads(claude_mcp_config_file(home).read_text())["mcpServers"]
        assert set(servers) == {"browser"}
        # Codex gets the same MCP but no doc-fallback (persona behavior).
        overrides = json.loads(codex_overrides_file(home).read_text())
        assert any(o.startswith("mcp_servers.browser.") for o in overrides)
        assert not any(o.startswith("project_doc_fallback") for o in overrides)

    def test_persona_only(self, home: Path):
        """persona module: plugin + system prompt + docs MCP, but no browser."""
        build_agent_layer(home, "alice", modules={"persona"})
        assert claude_plugin_dir(home).is_dir()
        assert claude_system_prompt_file(home).is_file()
        servers = json.loads(claude_mcp_config_file(home).read_text())["mcpServers"]
        assert "browser" not in servers
        assert {"context7", "deepwiki"} <= set(servers)
        # OpenCode gets the layer skills + persona instructions again.
        cfg = json.loads(opencode_config_file(home).read_text())
        assert str(harness_skills_dir(home)) in cfg["skills"]["paths"]

    def test_linear_requires_key(self, home: Path, monkeypatch):
        monkeypatch.delenv("LINEAR_API_KEY", raising=False)
        assert canonical_mcp_servers(home, modules={"linear"}) == {}
        monkeypatch.setenv("LINEAR_API_KEY", "lin_api_secret")
        servers = canonical_mcp_servers(home, modules={"linear"})
        assert set(servers) == {"linear"}

    def test_runtime_only_modules_keep_an_antigravity_transport(self, home: Path, monkeypatch):
        """Dreaming and project-scoped Linear additions are composed at launch.
        AGY needs an otherwise-empty session plugin to receive them too."""
        monkeypatch.delenv("LINEAR_API_KEY", raising=False)
        for modules in ({"dreaming"}, {"linear"}):
            build_agent_layer(home, "alice", modules=modules)
            assert antigravity_workspace_dir(home).is_dir()
            assert manifest(home)["artifacts"]["antigravity_plugin"] is True

    def test_composio_requires_key(self, home: Path, monkeypatch):
        monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
        assert canonical_mcp_servers(home, "uid", modules={"composio"}) == {}


class TestModulesConfig:
    def test_modules_parse(self, monkeypatch):
        import importlib
        import api.config as config
        monkeypatch.setenv("MODULES", " Persona, browser ,")
        importlib.reload(config)
        assert config.MODULES == frozenset({"persona", "browser"})
        monkeypatch.setenv("MODULES", "")
        importlib.reload(config)
        assert config.MODULES == frozenset()

    def test_unknown_module_logs_error(self, monkeypatch, caplog):
        import importlib
        import api.config as config
        monkeypatch.setenv("MODULES", "persona,typo-module")
        importlib.reload(config)
        config.validate_modules()
        assert any("typo-module" in r.message for r in caplog.records)
        monkeypatch.setenv("MODULES", "")
        importlib.reload(config)

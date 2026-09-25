"""Dreaming follows the company gateway exactly like the cockpit's agents.

Regression (2026-09-25): dreaming stripped the API keys but kept a .env
ANTHROPIC_BASE_URL, so with an x-api-key gateway the owner's subscription
login went to the gateway host; and a gateway entered in Settings was ignored,
so the nightly run bypassed the company gateway.
"""

import json
from pathlib import Path

from api.services import dreaming, llm_gateway

GW = "https://genai.example-corp.com"


def _launch(monkeypatch, tmp_path: Path, engine: str, env: dict[str, str]):
    for var in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
                "OPENAI_BASE_URL", "OPENAI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return dreaming._engine_launch(engine, "opus", tmp_path, tmp_path, tmp_path / "r.json")


def _save_settings_gateway(home: Path, name: str, base_url: str, token: str) -> None:
    cfg = home / ".config" / "shellteam"
    cfg.mkdir(parents=True, exist_ok=True)
    (cfg / name).write_text(json.dumps({"baseUrl": base_url, "token": token}))


def test_env_gateway_with_bearer_token_is_used(monkeypatch, tmp_path):
    env, argv = _launch(monkeypatch, tmp_path, "claude",
                        {"ANTHROPIC_BASE_URL": GW, "ANTHROPIC_AUTH_TOKEN": "corp"})
    assert env["ANTHROPIC_BASE_URL"] == GW
    assert env["ANTHROPIC_AUTH_TOKEN"] == "corp"
    assert "ANTHROPIC_API_KEY" not in env
    assert argv[0] == "claude"


def test_env_gateway_taking_an_api_key_keeps_it(monkeypatch, tmp_path):
    env, _ = _launch(monkeypatch, tmp_path, "claude",
                     {"ANTHROPIC_BASE_URL": GW, "ANTHROPIC_API_KEY": "corp-key"})
    assert env["ANTHROPIC_BASE_URL"] == GW
    assert env["ANTHROPIC_API_KEY"] == "corp-key"


def test_gateway_url_without_token_is_stripped_so_the_subscription_stays_home(monkeypatch, tmp_path):
    env, _ = _launch(monkeypatch, tmp_path, "claude", {"ANTHROPIC_BASE_URL": GW})
    assert "ANTHROPIC_BASE_URL" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env


def test_no_gateway_strips_metered_keys(monkeypatch, tmp_path):
    env, _ = _launch(monkeypatch, tmp_path, "claude",
                     {"ANTHROPIC_API_KEY": "sk-ant-x", "OPENAI_API_KEY": "sk-x"})
    assert "ANTHROPIC_API_KEY" not in env and "OPENAI_API_KEY" not in env


def test_settings_gateway_wins_over_env(monkeypatch, tmp_path):
    _save_settings_gateway(tmp_path, "claude-gateway.json", GW, "settings-token")
    env, _ = _launch(monkeypatch, tmp_path, "claude",
                     {"ANTHROPIC_BASE_URL": "https://other.example.com", "ANTHROPIC_AUTH_TOKEN": "env"})
    assert env["ANTHROPIC_BASE_URL"] == GW
    assert env["ANTHROPIC_AUTH_TOKEN"] == "settings-token"


def test_codex_through_a_gateway_gets_the_provider_block(monkeypatch, tmp_path):
    _save_settings_gateway(tmp_path, "openai-gateway.json", f"{GW}/v1", "corp")
    env, argv = _launch(monkeypatch, tmp_path, "codex", {})
    assert env["OPENAI_API_KEY"] == "corp"
    assert argv[:2] == ["codex", "exec"]
    assert f'model_providers.openai-api.base_url="{GW}/v1"' in argv


def test_python_and_node_emit_the_same_codex_provider_block():
    node = (Path(__file__).parents[1] / "computer/ai-chat/lib/agent-layer.mjs").read_text()
    for override in llm_gateway.codex_provider_overrides("X"):
        if "base_url" in override:
            continue
        assert f"'{override}'" in node, override

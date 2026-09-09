"""Settings → Dreaming engine (docs/decisions/20260903-dreaming-engine-choice.md).

The endpoint persists DREAM_ENGINE to .env and os.environ (so both the nightly
timer and an in-process "dream now" pick it up without a restart), rejects
unknown engines, and refuses an engine whose CLI isn't installed.
"""

import os

import pytest

from api import config
from api.routers import settings as settings_router


@pytest.fixture
def env_file(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("DREAM_ENGINE=claude\n")
    monkeypatch.setenv("SHELLTEAM_ENV_FILE", str(env))
    monkeypatch.delenv("DREAM_ENGINE", raising=False)
    return env


@pytest.fixture
def both_clis(monkeypatch):
    monkeypatch.setattr(settings_router.shutil, "which", lambda name: f"/usr/bin/{name}")


def test_requires_owner_token(client, env_file):
    assert client.get("/api/settings/dream-engine").status_code == 401


def test_get_defaults_to_claude_and_reports_cli_availability(
    client, auth_header, env_file, monkeypatch
):
    monkeypatch.setattr(settings_router.shutil, "which",
                        lambda name: "/usr/bin/claude" if name == "claude" else None)
    monkeypatch.setattr(config, "MODULES", {"dreaming"})
    resp = client.get("/api/settings/dream-engine", headers=auth_header)
    assert resp.status_code == 200
    assert resp.json() == {
        "engine": "claude", "enabled": True,
        "available": {"claude": True, "codex": False},
    }


def test_enabled_false_without_dreaming_module(client, auth_header, env_file, both_clis, monkeypatch):
    monkeypatch.setattr(config, "MODULES", set())
    assert client.get("/api/settings/dream-engine", headers=auth_header).json()["enabled"] is False


@pytest.mark.parametrize("engine", ["codex", "claude", "Codex "])
def test_set_persists_to_env_file_and_process(client, auth_header, env_file, both_clis, engine):
    resp = client.post("/api/settings/dream-engine", json={"engine": engine}, headers=auth_header)
    assert resp.status_code == 200, resp.text
    want = engine.strip().lower()
    assert resp.json()["engine"] == want
    assert f"DREAM_ENGINE={want}" in env_file.read_text()
    assert os.environ["DREAM_ENGINE"] == want


def test_unknown_engine_rejected_and_env_untouched(client, auth_header, env_file, both_clis):
    resp = client.post("/api/settings/dream-engine", json={"engine": "gemini"}, headers=auth_header)
    assert resp.status_code == 400
    assert "DREAM_ENGINE" in resp.json()["detail"]
    assert env_file.read_text() == "DREAM_ENGINE=claude\n"
    assert "DREAM_ENGINE" not in os.environ


def test_missing_cli_rejected_with_a_precise_reason(client, auth_header, env_file, monkeypatch):
    monkeypatch.setattr(settings_router.shutil, "which", lambda name: None)
    resp = client.post("/api/settings/dream-engine", json={"engine": "codex"}, headers=auth_header)
    assert resp.status_code == 400
    assert "codex CLI is not installed" in resp.json()["detail"]
    assert env_file.read_text() == "DREAM_ENGINE=claude\n"

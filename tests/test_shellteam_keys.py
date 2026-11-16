"""ShellTeam's own keys live in Settings -> Secrets with every other key.

Before, they had a card of their own ("Feature keys") that wrote ShellTeam's
.env and never the vault: on 15 Nov 2026 the owner replaced the Composio key in
Secrets and found the old one was never there, and the vault's OpenAI key was
dead while ShellTeam's own copy worked. Now one list holds every key:

- a ShellTeam key pasted in Secrets is checked with its provider first, then
  kept in the vault, written to ShellTeam's .env, live in the API at once, and
  its feature's module turned on;
- keys found only in ShellTeam's .env are adopted into the vault at start;
  a vault value that differs from ShellTeam's own copy is shown, not guessed.

Hermetic: tmp vault and .env, every provider call respx-mocked.
"""

import json
import os

import httpx
import pytest
import respx

from api.services import feature_keys, secrets_vault as vault

FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/models"
COMPOSIO_URL = "https://backend.composio.dev/api/v3/toolkits?limit=1"
LINEAR_URL = "https://api.linear.app/graphql"

ENV_TEMPLATE = """\
# ShellTeam test .env: comments and other lines must survive writes
APP_DOMAIN=localhost
MODULES=persona,browser
OWNER_TOKEN=owner-login-secret-value
SHELLTEAM_AI_TOKEN=internal-capability-secret
FIREWORKS_API_KEY=
"""


@pytest.fixture
def env_file(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text(ENV_TEMPLATE)
    monkeypatch.setenv("SHELLTEAM_ENV_FILE", str(path))
    monkeypatch.setenv("SHELLTEAM_SECRETS_FILE", str(tmp_path / "vault" / "secrets.json"))
    for spec in feature_keys.FEATURE_KEYS.values():
        monkeypatch.delenv(spec.env_var, raising=False)
    monkeypatch.setenv("MODULES", "")
    return path


def _line(path, var):
    return next((l for l in path.read_text().splitlines() if l.startswith(f"{var}=")), None)


def _save(client, auth_header, name, value):
    return client.post("/api/settings/secrets", headers=auth_header, json={"name": name, "value": value})


class TestPastingAShellTeamKeyInSecrets:
    @respx.mock
    def test_it_is_checked_kept_written_and_live(self, client, auth_header, env_file):
        respx.get(FIREWORKS_URL).mock(return_value=httpx.Response(200, json={"data": []}))
        resp = _save(client, auth_header, "FIREWORKS_API_KEY", "fw-valid-key-123")
        assert resp.status_code == 200 and "fw-valid-key-123" not in resp.text
        assert vault.load()["secrets"]["FIREWORKS_API_KEY"]["value"] == "fw-valid-key-123"
        assert _line(env_file, "FIREWORKS_API_KEY") == "FIREWORKS_API_KEY=fw-valid-key-123"
        assert os.environ["FIREWORKS_API_KEY"] == "fw-valid-key-123", "Pi turns on with no restart"
        assert _line(env_file, "OWNER_TOKEN") == "OWNER_TOKEN=owner-login-secret-value"
        row = next(r for r in resp.json()["secrets"] if r["name"] == "FIREWORKS_API_KEY")
        assert row["shellteam"]["label"].startswith("Pi")

    @respx.mock
    def test_a_key_the_provider_rejects_is_kept_nowhere(self, client, auth_header, env_file):
        respx.get(FIREWORKS_URL).mock(return_value=httpx.Response(401, json={}))
        before = env_file.read_text()
        resp = _save(client, auth_header, "FIREWORKS_API_KEY", "fw-bogus-key-123")
        assert resp.status_code == 400 and "Fireworks rejected this key" in resp.json()["detail"]
        assert env_file.read_text() == before and "FIREWORKS_API_KEY" not in vault.load()["secrets"]

    @respx.mock
    @pytest.mark.parametrize("key, kind", [("ck_LWQnIpiLX6MF", "Composio Connect key"), ("uak_abc123def", "user key")])
    def test_the_wrong_kind_of_composio_key_says_which_to_get(self, client, auth_header, env_file, key, kind):
        resp = _save(client, auth_header, "COMPOSIO_API_KEY", key)
        assert resp.status_code == 400 and kind in resp.json()["detail"] and "ak_" in resp.json()["detail"]

    @respx.mock
    def test_composio_turns_its_module_on_and_says_a_restart_is_needed(self, client, auth_header, env_file):
        respx.get(COMPOSIO_URL).mock(return_value=httpx.Response(200, json={"items": []}))
        resp = _save(client, auth_header, "COMPOSIO_API_KEY", "ak_valid_project_key")
        assert resp.status_code == 200
        assert _line(env_file, "MODULES") == "MODULES=persona,browser,composio"
        shellteam = [r for r in resp.json()["results"] if r["target"] == "ShellTeam"]
        assert shellteam and "Restart ShellTeam" in shellteam[0]["detail"]

    @respx.mock
    def test_replacing_a_key_whose_module_is_on_needs_no_restart(self, client, auth_header, env_file):
        respx.post(LINEAR_URL).mock(return_value=httpx.Response(200, json={"data": {"viewer": {"id": "u"}}}))
        _save(client, auth_header, "LINEAR_API_KEY", "lin_api_first_key_123")
        resp = _save(client, auth_header, "LINEAR_API_KEY", "lin_api_second_key_123")
        shellteam = [r for r in resp.json()["results"] if r["target"] == "ShellTeam"]
        assert shellteam[0]["ok"] and "Restart" not in shellteam[0]["detail"]
        assert _line(env_file, "LINEAR_API_KEY") == "LINEAR_API_KEY=lin_api_second_key_123"

    def test_a_key_with_a_line_break_is_refused_without_echoing_it(self, client, auth_header, env_file):
        resp = _save(client, auth_header, "COMPOSIO_API_KEY", "ak_SECRETVALUE\nOWNER_TOKEN=x")
        assert resp.status_code == 400 and "SECRETVALUE" not in resp.text and "line break" in resp.text

    def test_deleting_it_turns_the_feature_off(self, client, auth_header, env_file, monkeypatch):
        monkeypatch.setenv("MODULES", "")
        vault.set_secret("COMPOSIO_API_KEY", "ak_old_key_12345")
        vault.write_env(str(env_file), {"COMPOSIO_API_KEY": "COMPOSIO_API_KEY"})
        feature_keys.set_module_enabled("composio", enabled=True)
        resp = client.delete("/api/settings/secrets/COMPOSIO_API_KEY", headers=auth_header)
        assert resp.status_code == 200
        assert _line(env_file, "COMPOSIO_API_KEY") == "COMPOSIO_API_KEY="
        assert _line(env_file, "MODULES") == "MODULES=persona,browser"

    def test_the_old_feature_keys_card_and_route_are_gone(self, client, auth_header, env_file):
        from api.main import app
        assert not [r for r in app.routes if "feature-keys" in getattr(r, "path", "")]
        suggestions = client.get("/api/settings/secrets", headers=auth_header).json()["suggestions"]
        ours = {s["name"] for s in suggestions if s["group"] == "ShellTeam"}
        assert ours == {"FIREWORKS_API_KEY", "ELEVENLABS_API_KEY", "COMPOSIO_API_KEY", "LINEAR_API_KEY"}


class TestAdoptingShellTeamsOwnFile:
    def test_keys_only_in_shellteams_env_join_the_vault(self, env_file):
        env_file.write_text(ENV_TEMPLATE + "LINEAR_API_KEY=lin_api_from_env_1234\nELEVENLABS_API_KEY=el-from-env-1234\n")
        vault.set_secret("ELEVENLABS_API_KEY", "el-from-env-1234")
        report = vault.adopt_env_file(env_file)
        data = vault.load()
        assert data["secrets"]["LINEAR_API_KEY"]["value"] == "lin_api_from_env_1234"
        assert report == {"adopted": ["LINEAR_API_KEY"], "differs": []}
        use = next(u for u in data["uses"] if u["file"] == str(env_file))
        assert set(use["vars"]) == {"LINEAR_API_KEY", "ELEVENLABS_API_KEY"}, "both now follow the vault"
        assert "OWNER_TOKEN" not in data["secrets"] and "SHELLTEAM_AI_TOKEN" not in data["secrets"], \
            "ShellTeam's own sign-in and internal tokens are not the owner's keys"
        assert vault.adopt_env_file(env_file) == {"adopted": [], "differs": []}, "nothing twice"

    def test_a_different_value_is_shown_never_overwritten(self, env_file):
        env_file.write_text(ENV_TEMPLATE + "OPENAI_API_KEY=" + "sk-" + "shellteam-copy-123456" + "\n")
        vault.set_secret("OPENAI_API_KEY", "sk-" + "vault-copy-1234567")
        assert vault.adopt_env_file(env_file) == {"adopted": [], "differs": ["OPENAI_API_KEY"]}
        assert _line(env_file, "OPENAI_API_KEY") == "OPENAI_API_KEY=" + "sk-" + "shellteam-copy-123456"
        row = next(r for r in vault.status() if r["name"] == "OPENAI_API_KEY")
        assert "ShellTeam uses a different value" in row["differs"]
        assert not any(u.get("file") == str(env_file) for u in vault.load()["uses"])

        vault.set_secret("OPENAI_API_KEY", "sk-" + "the-one-to-keep-12345")
        vault.write_env(str(env_file), {"OPENAI_API_KEY": "OPENAI_API_KEY"})
        assert not next(r for r in vault.status() if r["name"] == "OPENAI_API_KEY").get("differs")


class TestInternalAiStatus:
    """GET /internal/ai/status — the cockpit's live-availability source."""

    def _get(self, client, monkeypatch, **env):
        from api.services.internal_auth import make_token

        for var in ("ELEVENLABS_API_KEY", "FIREWORKS_API_KEY"):
            monkeypatch.delenv(var, raising=False)
        for var, value in env.items():
            monkeypatch.setenv(var, value)
        return client.get(
            "/internal/ai/status",
            headers={
                "Authorization": f"Bearer {make_token('u1')}",
                "X-Shellteam-User-Id": "u1",
            },
        )

    def test_requires_hmac_token(self, client):
        assert client.get("/internal/ai/status").status_code in (401, 403)
        resp = client.get(
            "/internal/ai/status",
            headers={"Authorization": "Bearer wrong", "X-Shellteam-User-Id": "u1"},
        )
        assert resp.status_code == 401

    def test_reads_environment_at_request_time(self, client, monkeypatch):
        resp = self._get(client, monkeypatch)
        assert resp.status_code == 200
        # One key can gate more than one capability: ElevenLabs is both the
        # cockpit's ears (stt) and its voice (tts).
        assert resp.json() == {"stt": False, "tts": False, "pi": False}
        resp = self._get(client, monkeypatch, ELEVENLABS_API_KEY="el", FIREWORKS_API_KEY="fk")
        assert resp.json() == {"stt": True, "tts": True, "pi": True}



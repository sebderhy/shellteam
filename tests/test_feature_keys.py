"""Tests for dashboard-managed feature keys — /api/settings/feature-keys.

Hermetic: the .env under test is a tmp file (SHELLTEAM_ENV_FILE), every
validator HTTP call is respx-mocked, and monkeypatch restores os.environ.
"""

import os

import httpx
import pytest
import respx

from api.services import feature_keys

ENDPOINT = "/api/settings/feature-keys"
FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/models"
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/user"
COMPOSIO_URL = "https://backend.composio.dev/api/v3/toolkits?limit=1"

ENV_TEMPLATE = """\
# ShellTeam test .env — comments and unrelated lines must survive writes
APP_DOMAIN=localhost
MODULES=persona,browser
FIREWORKS_API_KEY=
OWNER_TOKEN=fake-jwt-token
"""


@pytest.fixture
def env_file(tmp_path, monkeypatch):
    """A throwaway .env + a clean slate for the three feature-key env vars."""
    path = tmp_path / ".env"
    path.write_text(ENV_TEMPLATE)
    monkeypatch.setenv("SHELLTEAM_ENV_FILE", str(path))
    for spec in feature_keys.FEATURE_KEYS.values():
        monkeypatch.delenv(spec.env_var, raising=False)
    # MODULES is pinned by conftest; register it with monkeypatch so module
    # toggles during a test are restored afterwards.
    monkeypatch.setenv("MODULES", "")
    return path


def _env_line(path, var):
    for line in path.read_text().splitlines():
        if line.startswith(f"{var}="):
            return line
    return None


class TestAuth:
    def test_get_requires_owner_token(self, client, env_file):
        assert client.get(ENDPOINT).status_code == 401

    def test_post_requires_owner_token(self, client, env_file):
        resp = client.post(ENDPOINT, json={"name": "fireworks", "key": "fk-x"})
        assert resp.status_code == 401


class TestStatus:
    def test_get_reports_set_flags_and_never_leaks_values(self, client, auth_header, env_file, monkeypatch):
        monkeypatch.setenv("FIREWORKS_API_KEY", "fk-super-secret-value")
        resp = client.get(ENDPOINT, headers=auth_header)
        assert resp.status_code == 200
        keys = resp.json()["keys"]
        assert set(keys) == {"fireworks", "elevenlabs", "composio"}
        assert keys["fireworks"] == {
            "set": True,
            "label": "OpenCode coding agent (Fireworks)",
            "hint": "Unlocks the OpenCode coding agent on frontier open-source models.",
            "hint_url": "https://fireworks.ai",
        }
        assert keys["elevenlabs"]["set"] is False
        assert keys["composio"]["set"] is False
        assert "fk-super-secret-value" not in resp.text


class TestSetKey:
    @respx.mock
    def test_valid_fireworks_key_persists_to_env_file_and_process(self, client, auth_header, env_file):
        respx.get(FIREWORKS_URL).mock(return_value=httpx.Response(200, json={"data": []}))
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "fireworks", "key": "fk-valid"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["set"] is True
        assert data["needs_restart"] is False
        assert data["keys"]["fireworks"]["set"] is True
        assert "fk-valid" not in resp.text  # response carries status, never the value
        assert _env_line(env_file, "FIREWORKS_API_KEY") == "FIREWORKS_API_KEY=fk-valid"
        assert os.environ["FIREWORKS_API_KEY"] == "fk-valid"
        # Every other line survived byte-for-byte.
        assert "# ShellTeam test .env" in env_file.read_text()
        assert _env_line(env_file, "OWNER_TOKEN") == "OWNER_TOKEN=fake-jwt-token"

    @respx.mock
    def test_invalid_key_returns_400_and_leaves_env_untouched(self, client, auth_header, env_file):
        respx.get(FIREWORKS_URL).mock(return_value=httpx.Response(401, json={"error": "bad key"}))
        before = env_file.read_text()
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "fireworks", "key": "fk-bogus"})
        assert resp.status_code == 400
        assert "Fireworks rejected this key" in resp.json()["detail"]
        assert env_file.read_text() == before
        assert "FIREWORKS_API_KEY" not in os.environ

    @respx.mock
    def test_validator_network_failure_is_a_400_not_a_500(self, client, auth_header, env_file):
        respx.get(ELEVENLABS_URL).mock(side_effect=httpx.ConnectError("no route"))
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "elevenlabs", "key": "el-x-123"})
        assert resp.status_code == 400
        assert "Could not reach ElevenLabs" in resp.json()["detail"]

    @respx.mock
    def test_elevenlabs_valid_key_appends_missing_env_line(self, client, auth_header, env_file):
        respx.get(ELEVENLABS_URL).mock(return_value=httpx.Response(200, json={}))
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "elevenlabs", "key": "el-valid"})
        assert resp.status_code == 200
        # ELEVENLABS_API_KEY wasn't in the template — it must be appended.
        assert _env_line(env_file, "ELEVENLABS_API_KEY") == "ELEVENLABS_API_KEY=el-valid"
        assert env_file.read_text().endswith("\n")
        assert os.environ["ELEVENLABS_API_KEY"] == "el-valid"

    @respx.mock  # no routes registered: any HTTP call would fail the test
    def test_clear_skips_validation_and_clears_everywhere(self, client, auth_header, env_file, monkeypatch):
        monkeypatch.setenv("FIREWORKS_API_KEY", "fk-old")
        feature_keys.persist("FIREWORKS_API_KEY", "fk-old")
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "fireworks", "key": ""})
        assert resp.status_code == 200
        assert resp.json()["set"] is False
        assert _env_line(env_file, "FIREWORKS_API_KEY") == "FIREWORKS_API_KEY="
        assert "FIREWORKS_API_KEY" not in os.environ

    def test_unknown_name_is_a_400(self, client, auth_header, env_file):
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "nope", "key": "x" * 12})
        assert resp.status_code == 400
        assert "Unknown feature key" in resp.json()["detail"]


class TestComposioModuleToggle:
    @respx.mock
    def test_set_enables_module_and_reports_needs_restart(self, client, auth_header, env_file):
        respx.get(COMPOSIO_URL).mock(return_value=httpx.Response(200, json={"items": []}))
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "composio", "key": "comp-valid"})
        assert resp.status_code == 200
        assert resp.json()["needs_restart"] is True
        assert _env_line(env_file, "COMPOSIO_API_KEY") == "COMPOSIO_API_KEY=comp-valid"
        # The module joins MODULES without disturbing the existing entries.
        assert _env_line(env_file, "MODULES") == "MODULES=persona,browser,composio"

    @respx.mock
    def test_invalid_composio_key_neither_persists_nor_toggles_module(self, client, auth_header, env_file):
        respx.get(COMPOSIO_URL).mock(return_value=httpx.Response(401, json={}))
        before = env_file.read_text()
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "composio", "key": "comp-bogus"})
        assert resp.status_code == 400
        assert env_file.read_text() == before

    @respx.mock
    def test_clear_removes_module_again(self, client, auth_header, env_file, monkeypatch):
        monkeypatch.setenv("COMPOSIO_API_KEY", "comp-old")
        feature_keys.persist("COMPOSIO_API_KEY", "comp-old")
        feature_keys.set_module_enabled("composio", enabled=True)
        resp = client.post(ENDPOINT, headers=auth_header, json={"name": "composio", "key": ""})
        assert resp.status_code == 200
        assert resp.json()["needs_restart"] is True
        assert _env_line(env_file, "COMPOSIO_API_KEY") == "COMPOSIO_API_KEY="
        assert _env_line(env_file, "MODULES") == "MODULES=persona,browser"
        assert "COMPOSIO_API_KEY" not in os.environ


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
        assert resp.json() == {"stt": False, "opencode": False}
        resp = self._get(client, monkeypatch, ELEVENLABS_API_KEY="el", FIREWORKS_API_KEY="fk")
        assert resp.json() == {"stt": True, "opencode": True}

"""Keys stay with ShellTeam: MCP servers that need a key are reached through
the control plane's relay (SHE-203).

On 14 Nov 2026 an agent opened a launch-layer file to inspect it and printed
the Composio key into its transcript: the layer held the Composio and Linear
keys in plain text, in a dozen files every agent can read. Now the layer holds
only the relay's address and the relay's own capability token; the relay adds
the key when it forwards a request, reading the current value each time, so a
replaced key works on the next call with no rebuild and no restart.
"""

import json
import os
from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from api.services import internal_auth, mcp_relay
from api.services.agent_layer import build_agent_layer, canonical_mcp_servers, layer_dir

COMPOSIO_KEY = "ak_composio_" + "0123456789abcdefghij"
LINEAR_KEY = "lin_api_" + "default0123456789abcdef"
PROJECT_LINEAR_KEY = "lin_api_" + "project0123456789abcdef"
SESSION_URL = "https://backend.composio.dev/tool_router/trs_test/mcp"
FULL = frozenset({"persona", "browser", "composio", "linear"})
LOCAL = ("127.0.0.1", 50000)


@pytest.fixture
def box(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    env_file = tmp_path / "shellteam.env"
    env_file.write_text(f"COMPOSIO_API_KEY={COMPOSIO_KEY}\nLINEAR_API_KEY={LINEAR_KEY}\n")
    monkeypatch.setenv("SHELLTEAM_ENV_FILE", str(env_file))
    monkeypatch.setenv("SHELLTEAM_HOME", str(home))
    monkeypatch.setattr(mcp_relay, "HOME_DIR", home)
    monkeypatch.setenv("COMPOSIO_API_KEY", COMPOSIO_KEY)
    monkeypatch.setenv("LINEAR_API_KEY", LINEAR_KEY)
    monkeypatch.setattr(internal_auth, "_SECRET", b"master-secret-for-tests")

    from api.services import composio
    monkeypatch.setattr(composio, "generate_mcp_config", lambda user_id: {
        "type": "http", "url": SESSION_URL, "headers": {"x-api-key": os.environ["COMPOSIO_API_KEY"]}})
    return home, env_file


def _every_layer_file(home: Path):
    for path in layer_dir(home).rglob("*"):
        if path.is_file() and not path.is_symlink():
            yield path, path.read_text(errors="replace")


def test_no_key_is_written_into_any_file_agents_are_given(box):
    home, _ = box
    build_agent_layer(home, "alice", user_id="u1", modules=FULL)
    for path, text in _every_layer_file(home):
        for key in (COMPOSIO_KEY, LINEAR_KEY):
            assert key not in text, f"{key[:8]}… written into {path.relative_to(home)}"

    servers = json.loads((layer_dir(home) / "claude-mcp.json").read_text())["mcpServers"]
    for name in ("composio", "linear"):
        assert servers[name]["url"] == f"http://127.0.0.1:8000/internal/mcp/{name}"
        assert servers[name]["headers"] == {"Authorization": f"Bearer {internal_auth.mcp_relay_token()}"}


def test_a_build_clears_runtime_configs_written_before_the_relay(box):
    home, _ = box
    runtime = layer_dir(home) / "runtime"
    runtime.mkdir(parents=True)
    (runtime / "claude-mcp-orchard.json").write_text(LINEAR_KEY)
    (runtime / "pi-orchard.json").write_text(LINEAR_KEY)
    (runtime / "opencode-orchard.json").write_text(LINEAR_KEY)
    (runtime / "antigravity-orchard").mkdir()
    (runtime / "prompt-keep.md").write_text("a live chat's prompt")
    build_agent_layer(home, "alice", user_id="u1", modules=FULL)
    assert sorted(p.name for p in runtime.iterdir()) == ["prompt-keep.md"]
    manifest = json.loads((layer_dir(home) / "layer.json").read_text())
    assert manifest["mcp_relay"] == {"base": "http://127.0.0.1:8000/internal/mcp",
                                     "authorization": f"Bearer {internal_auth.mcp_relay_token()}"}


def test_the_relay_token_opens_the_relay_and_nothing_else():
    token = internal_auth.mcp_relay_token()
    assert internal_auth.verify_mcp_relay_token(token)
    assert not internal_auth.verify_token(token, "anyone"), "not an /internal/ai credential"
    assert not internal_auth.verify_notify_token(token)
    assert not internal_auth.verify_mcp_relay_token("wrong") and not internal_auth.verify_mcp_relay_token("")


def _post(client, path, token=None, **headers):
    token = internal_auth.mcp_relay_token() if token is None else token
    return client.post(path, content=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
                       headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                                "Accept": "application/json, text/event-stream", **headers})


@respx.mock
def test_the_relay_adds_the_current_key_and_passes_the_session_through(box):
    home, env_file = box
    build_agent_layer(home, "alice", user_id="u1", modules=FULL)
    upstream = respx.post(SESSION_URL).mock(return_value=httpx.Response(
        200, text='data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
        headers={"content-type": "text/event-stream", "mcp-session-id": "sess-1"}))
    from api.main import app
    with TestClient(app, client=LOCAL) as client:
        resp = _post(client, "/internal/mcp/composio", **{"mcp-session-id": "sess-0"})
        assert resp.status_code == 200 and resp.headers["mcp-session-id"] == "sess-1"
        assert '"result"' in resp.text
        sent = upstream.calls.last.request
        assert sent.headers["x-api-key"] == COMPOSIO_KEY and sent.headers["mcp-session-id"] == "sess-0"
        assert "authorization" not in sent.headers, "the relay token never leaves the box"

        # The owner replaces the key: the very next call uses the new one.
        env_file.write_text(f"COMPOSIO_API_KEY=ak_composio_{'n' * 20}\nLINEAR_API_KEY={LINEAR_KEY}\n")
        _post(client, "/internal/mcp/composio")
        assert upstream.calls.last.request.headers["x-api-key"] == "ak_composio_" + "n" * 20


@respx.mock
def test_linear_uses_the_projects_own_key_when_it_has_one(box):
    home, _ = box
    (home / "orchard").mkdir()
    (home / "orchard" / ".env").write_text(f"LINEAR_API_KEY={PROJECT_LINEAR_KEY}\n")
    upstream = respx.post("https://mcp.linear.app/mcp").mock(return_value=httpx.Response(200, json={}))
    from api.main import app
    with TestClient(app, client=LOCAL) as client:
        _post(client, "/internal/mcp/linear/orchard")
        assert upstream.calls.last.request.headers["authorization"] == f"Bearer {PROJECT_LINEAR_KEY}"
        _post(client, "/internal/mcp/linear/elsewhere")
        assert upstream.calls.last.request.headers["authorization"] == f"Bearer {LINEAR_KEY}"
        _post(client, "/internal/mcp/linear")
        assert upstream.calls.last.request.headers["authorization"] == f"Bearer {LINEAR_KEY}"


@pytest.mark.parametrize("path, token, status", [
    ("/internal/mcp/composio", "wrong", 401),
    ("/internal/mcp/composio", "", 401),
    ("/internal/mcp/github", None, 404),
    ("/internal/mcp/linear/..", None, 404),
    ("/internal/mcp/linear/.hidden", None, 404),
])
def test_the_relay_refuses(box, path, token, status):
    from api.main import app
    with TestClient(app, client=LOCAL) as client:
        assert _post(client, path, token=token).status_code == status


def test_a_call_from_off_the_box_is_refused_even_with_the_token(box):
    from api.main import app
    with TestClient(app, client=("203.0.113.9", 50000)) as client:
        assert _post(client, "/internal/mcp/composio").status_code == 403


@respx.mock
def test_a_missing_key_is_said_plainly_never_forwarded(box):
    _, env_file = box
    env_file.write_text("")
    os.environ.pop("LINEAR_API_KEY")
    route = respx.post("https://mcp.linear.app/mcp")
    from api.main import app
    with TestClient(app, client=LOCAL) as client:
        resp = _post(client, "/internal/mcp/linear")
    assert resp.status_code == 503 and "LINEAR_API_KEY" in resp.text and "Settings" in resp.text
    assert not route.called


def test_linear_appears_only_with_a_key(box, monkeypatch):
    home, env_file = box
    env_file.write_text(f"COMPOSIO_API_KEY={COMPOSIO_KEY}\n")
    monkeypatch.delenv("LINEAR_API_KEY")
    assert "linear" not in canonical_mcp_servers(home, user_id="u1", modules=FULL)

"""SHE-164: secrets and background-service fixes from the 2026-11-10 audit."""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from api.services import dreaming, internal_auth, notify, security_watch


def test_a_scoped_token_is_not_a_per_user_internal_credential(monkeypatch):
    # The notify token is HMAC(secret, "notify-v1"); so was make_token("notify-v1"),
    # and the user id is a request header a guest container sets freely.
    monkeypatch.setattr(internal_auth, "_SECRET", b"s" * 32)
    scoped = internal_auth.notify_token()
    assert internal_auth.verify_notify_token(scoped) is True
    assert internal_auth.verify_token(scoped, "notify-v1") is False
    assert internal_auth.verify_token(internal_auth.make_token("owner"), "owner") is True


@pytest.mark.asyncio
async def test_telegram_alerts_are_plain_text(monkeypatch):
    # parse_mode=Markdown made Telegram answer 400 to any alert holding a lone
    # underscore ("change OWNER_TOKEN"), so sign-in alerts never arrived.
    monkeypatch.setenv("NOTIFY_TELEGRAM_BOT_TOKEN", "1:x")
    monkeypatch.setenv("NOTIFY_TELEGRAM_CHAT_ID", "1")
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(return_value=MagicMock(status_code=200))
    with patch("api.services.notify.httpx.AsyncClient", return_value=client):
        await notify._send_telegram("New sign-in", "If this was not you, change OWNER_TOKEN.", None)
    payload = client.post.call_args.kwargs["json"]
    assert "parse_mode" not in payload
    assert payload["text"] == "New sign-in\nIf this was not you, change OWNER_TOKEN."


def test_only_lines_the_security_logger_wrote_are_events():
    real = '2026-11-06 15:05:11,011 api.services.security_watch WARNING SECURITY {"event": "auth_failure", "ip": "203.0.113.9", "ts": 1}'
    lines = [
        real,
        # An outsider's Origin header, logged by the terminal before any auth.
        "2026-11-10 10:00:00,000 api.routers.terminal WARNING Terminal WS refused: cross-origin SECURITY {}",
        '2026-11-10 10:00:00,000 api.routers.terminal WARNING Terminal WS refused: cross-origin SECURITY {"event": "new_device", "ip": "203.0.113.1"}',
        "2026-11-10 10:00:00,000 api.services.security_watch WARNING SECURITY {}",
        "2026-11-10 10:00:00,000 api.services.security_watch WARNING SECURITY [1]",
    ]
    assert security_watch._events_from(lines) == [{"event": "auth_failure", "ip": "203.0.113.9", "ts": 1}]


def test_state_dir_is_made_owner_only(tmp_path, monkeypatch):
    from api import config

    state = tmp_path / ".shellteam"
    state.mkdir(mode=0o755)
    monkeypatch.setenv("HOME", str(tmp_path))
    config.lock_state_dir()
    assert (state.stat().st_mode & 0o777) == 0o700


def test_dreaming_runs_claude_without_tools():
    argv = dreaming._claude_argv("opus")
    assert argv[argv.index("--tools") + 1] == ""


def test_the_web_terminal_shell_does_not_inherit_the_master_token():
    from pathlib import Path

    src = (Path(__file__).resolve().parent.parent / "api" / "services" / "processes.py").read_text()
    child = src.split("async def open_shell", 1)[1].split("os.execvp", 1)[0]
    assert 'os.environ.pop("OWNER_TOKEN", None)' in child

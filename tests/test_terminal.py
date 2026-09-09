"""Tests for terminal WebSocket — /api/terminal endpoint."""

import asyncio
import json
import time

import pytest
from unittest.mock import patch, AsyncMock

from fastapi.testclient import TestClient
from api.main import app


class FakeShell:
    """Stands in for processes.PtyShell in router tests."""

    def __init__(self, chunks=()):
        self._chunks = list(chunks)
        self.written: list[bytes] = []
        self.resizes: list[tuple[int, int]] = []
        self.closed = False

    async def read(self) -> bytes:
        if self._chunks:
            return self._chunks.pop(0)
        # No scripted output left: stay open until the router cancels us,
        # like a real idle shell.
        while True:
            await asyncio.sleep(3600)

    def write(self, data: bytes) -> None:
        self.written.append(data)

    def resize(self, rows: int, cols: int) -> None:
        self.resizes.append((rows, cols))

    def close(self) -> None:
        self.closed = True


def _mock_verify_token(payload=None):
    if payload is None:
        payload = {"sub": "user-1", "email": "test@example.com"}
    return patch("api.routers.terminal.verify_token", return_value=payload)


def _mock_get_status(status="running"):
    return patch(
        "api.routers.terminal.runtime.get_status",
        new_callable=AsyncMock,
        return_value={"status": status, "container_id": "abc", "ip": "172.20.0.5"},
    )


def _mock_open_shell(shell=None):
    if shell is None:
        shell = FakeShell(chunks=[b""])  # exits immediately
    return patch(
        "api.routers.terminal.runtime.open_shell",
        new_callable=AsyncMock,
        return_value=shell,
    )


class TestTerminalJWTEdgeCases:
    def test_missing_sub_claim_closes_4001(self):
        """JWT without 'sub' claim should close with 4001, not crash."""
        with patch(
            "api.routers.terminal.verify_token",
            return_value={"email": "test@example.com"},  # no 'sub'
        ):
            with TestClient(app) as client:
                with pytest.raises(Exception):
                    with client.websocket_connect(
                        "/api/terminal?token=no-sub-jwt"
                    ) as ws:
                        ws.receive_text()


class TestTerminalAuth:
    def test_query_param_token_ignored(self):
        """?token= must NOT authenticate the terminal (split-credential model:
        URL-borne master tokens leak). Only the session cookie counts — a query
        token with no cookie verifies as the empty string."""
        with (
            _mock_verify_token() as mock_verify,
            _mock_get_status(),
            _mock_open_shell(),
        ):
            with TestClient(app) as client:
                with client.websocket_connect("/api/terminal?token=my-jwt"):
                    pass

            mock_verify.assert_called_once_with("")

    def test_missing_token_uses_localhost_trust(self):
        """No token query param hands an empty string to verify_token, which
        accepts it in localhost-trust mode (OWNER_TOKEN unset)."""
        with (
            _mock_verify_token() as mock_verify,
            _mock_get_status(),
            _mock_open_shell(),
        ):
            with TestClient(app) as client:
                with client.websocket_connect("/api/terminal"):
                    pass

            mock_verify.assert_called_once_with("")

    def test_invalid_token_closes_4001(self):
        """Invalid token should close with code 4001."""
        with patch(
            "api.routers.terminal.verify_token",
            side_effect=Exception("bad token"),
        ):
            with TestClient(app) as client:
                with pytest.raises(Exception):
                    with client.websocket_connect(
                        "/api/terminal?token=bad"
                    ) as ws:
                        ws.receive_text()


class TestTerminalShellCheck:
    def test_computer_not_running_closes_4002(self):
        """Should close with 4002 if the stack is not running."""
        with (
            _mock_verify_token(),
            _mock_get_status(status="stopped"),
        ):
            with TestClient(app) as client:
                with pytest.raises(Exception):
                    with client.websocket_connect(
                        "/api/terminal?token=valid"
                    ) as ws:
                        ws.receive_text()

    def test_open_shell_failure_closes_4003(self):
        """Should close with 4003 if the shell cannot be spawned."""
        with (
            _mock_verify_token(),
            _mock_get_status(),
            patch(
                "api.routers.terminal.runtime.open_shell",
                new_callable=AsyncMock,
                side_effect=RuntimeError("fork failed"),
            ),
        ):
            with TestClient(app) as client:
                with pytest.raises(Exception):
                    with client.websocket_connect(
                        "/api/terminal?token=valid"
                    ) as ws:
                        ws.receive_text()


class TestTerminalIO:
    def test_shell_output_sent_to_websocket(self):
        """Data from the shell should be sent to the WebSocket client."""
        shell = FakeShell(chunks=[b"hello from shell", b""])

        with (
            _mock_verify_token(),
            _mock_get_status(),
            _mock_open_shell(shell),
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/api/terminal?token=valid"
                ) as ws:
                    data = ws.receive_bytes()
                    assert data == b"hello from shell"

        assert shell.closed

    def test_resize_command(self):
        """Resize JSON messages should call shell.resize."""
        shell = FakeShell()  # idle shell, stays open

        with (
            _mock_verify_token(),
            _mock_get_status(),
            _mock_open_shell(shell),
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/api/terminal?token=valid"
                ) as ws:
                    ws.send_text(
                        json.dumps({"type": "resize", "cols": 120, "rows": 40})
                    )
                    time.sleep(0.2)

        assert (40, 120) in shell.resizes

    def test_keystrokes_reach_the_shell(self):
        """Plain text that is not a resize command is written to the shell."""
        shell = FakeShell()

        with (
            _mock_verify_token(),
            _mock_get_status(),
            _mock_open_shell(shell),
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/api/terminal?token=valid"
                ) as ws:
                    ws.send_text("ls -la\n")
                    time.sleep(0.2)

        assert b"ls -la\n" in shell.written

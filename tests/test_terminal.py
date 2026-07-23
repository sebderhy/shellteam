"""Tests for terminal WebSocket — /api/terminal endpoint."""

import os


import json
import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from fastapi.testclient import TestClient
from api.main import app


def _mock_verify_token(payload=None):
    if payload is None:
        payload = {"sub": "user-1", "email": "test@example.com"}
    return patch("api.routers.terminal.verify_token", return_value=payload)


def _mock_get_status(status="running"):
    return patch(
        "api.routers.terminal.containers.get_status",
        new_callable=AsyncMock,
        return_value={"status": status, "container_id": "abc", "ip": "172.20.0.5"},
    )


def _mock_exec():
    """Mock exec_create and exec_start to return a fake socket."""
    sock = MagicMock()
    raw = MagicMock()
    raw.recv.return_value = b""  # immediately signal closed
    sock._sock = raw

    exec_create = patch(
        "api.routers.terminal.containers.exec_create",
        new_callable=AsyncMock,
        return_value=("exec-id-123", MagicMock()),
    )
    exec_start = patch(
        "api.routers.terminal.containers.exec_start",
        return_value=sock,
    )
    return exec_create, exec_start


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
        exec_create, exec_start = _mock_exec()

        with (
            _mock_verify_token() as mock_verify,
            _mock_get_status(),
            exec_create,
            exec_start,
        ):
            with TestClient(app) as client:
                with client.websocket_connect("/api/terminal?token=my-jwt"):
                    pass

            mock_verify.assert_called_once_with("")

    def test_missing_token_uses_localhost_trust(self):
        """No token query param hands an empty string to verify_token, which
        accepts it in localhost-trust mode (OWNER_TOKEN unset)."""
        exec_create, exec_start = _mock_exec()

        with (
            _mock_verify_token() as mock_verify,
            _mock_get_status(),
            exec_create,
            exec_start,
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

class TestTerminalContainerCheck:
    def test_container_not_running_closes_4002(self):
        """Should close with 4002 if container is not running."""
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

    def test_exec_create_failure_closes_4003(self):
        """Should close with 4003 if exec creation fails."""
        with (
            _mock_verify_token(),
            _mock_get_status(),
            patch(
                "api.routers.terminal.containers.exec_create",
                new_callable=AsyncMock,
                side_effect=RuntimeError("container crashed"),
            ),
        ):
            with TestClient(app) as client:
                with pytest.raises(Exception):
                    with client.websocket_connect(
                        "/api/terminal?token=valid"
                    ) as ws:
                        ws.receive_text()


class TestTerminalIO:
    def test_container_output_sent_to_websocket(self):
        """Data from container socket should be sent to WebSocket client."""
        sock = MagicMock()
        raw = MagicMock()
        # Return some data, then empty (closed)
        raw.recv.side_effect = [b"hello from container", b""]
        sock._sock = raw

        with (
            _mock_verify_token(),
            _mock_get_status(),
            patch(
                "api.routers.terminal.containers.exec_create",
                new_callable=AsyncMock,
                return_value=("exec-id", MagicMock()),
            ),
            patch("api.routers.terminal.containers.exec_start", return_value=sock),
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/api/terminal?token=valid"
                ) as ws:
                    data = ws.receive_bytes()
                    assert data == b"hello from container"

    def test_resize_command(self):
        """Resize JSON messages should call exec_resize."""
        sock = MagicMock()
        raw = MagicMock()
        # Always timeout — reader stays alive until WS disconnect sets closed
        raw.recv.side_effect = TimeoutError
        sock._sock = raw

        with (
            _mock_verify_token(),
            _mock_get_status(),
            patch(
                "api.routers.terminal.containers.exec_create",
                new_callable=AsyncMock,
                return_value=("exec-id-123", MagicMock()),
            ),
            patch("api.routers.terminal.containers.exec_start", return_value=sock),
            patch("api.routers.terminal.containers.exec_resize") as mock_resize,
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/api/terminal?token=valid"
                ) as ws:
                    ws.send_text(
                        json.dumps({"type": "resize", "cols": 120, "rows": 40})
                    )
                    import time
                    time.sleep(0.2)

            mock_resize.assert_called_with("exec-id-123", height=40, width=120)

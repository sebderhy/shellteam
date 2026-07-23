"""Unit tests for the native (non-Docker) runtime backend + the runtime facade."""

import os


import time
import pytest
from unittest.mock import patch, AsyncMock

from api.config import OWNER_ID, OWNER_USERNAME
from api.services import processes


class TestStatusAndResolution:
    @pytest.mark.asyncio
    async def test_status_running_when_stack_up(self):
        with patch.object(processes, "_port_open", return_value=True):
            status = await processes.get_status()
        assert status["status"] == "running"
        assert status["ip"] == "127.0.0.1"
        assert status["username"] == OWNER_USERNAME

    @pytest.mark.asyncio
    async def test_status_stopped_when_stack_down(self):
        with patch.object(processes, "_port_open", return_value=False):
            status = await processes.get_status()
        assert status["status"] == "stopped"
        assert status["ip"] is None

    @pytest.mark.asyncio
    async def test_resolve_username_owner_returns_localhost_and_owner(self):
        with patch.object(processes, "_port_open", return_value=True):
            ip, owner = await processes.resolve_username_owner("anyone")
        assert ip == "127.0.0.1"
        assert owner == OWNER_ID

    @pytest.mark.asyncio
    async def test_resolve_username_owner_no_ip_when_down_but_owner_kept(self):
        """Owner is always returned so the proxy can render a 'starting' page."""
        with patch.object(processes, "_port_open", return_value=False):
            ip, owner = await processes.resolve_username_owner("anyone")
        assert ip is None
        assert owner == OWNER_ID

    @pytest.mark.asyncio
    async def test_verify_container_ip_loopback_only(self):
        assert await processes.verify_container_ip("u", "127.0.0.1") is True
        assert await processes.verify_container_ip("u", "::1") is True
        assert await processes.verify_container_ip("u", "10.0.0.5") is False

    def test_user_home_dir_ignores_user_id(self):
        from api.config import HOME_DIR
        assert processes.user_home_dir("whatever") == HOME_DIR


class TestStartStop:
    @pytest.mark.asyncio
    async def test_start_materializes_config_and_reports_running(self, tmp_path):
        with (
            patch.object(processes, "HOME_DIR", tmp_path),
            patch.object(processes, "_materialize_config") as materialize,
            patch.object(processes, "_systemctl") as systemctl,
            patch.object(processes, "_port_open", return_value=True),
        ):
            result = await processes.start_computer(username="alice")
        materialize.assert_called_once()
        systemctl.assert_not_called()  # already up
        assert result["status"] == "running"
        assert result["ip"] == "127.0.0.1"

    @pytest.mark.asyncio
    async def test_start_nudges_systemd_when_down(self):
        with (
            patch.object(processes, "_materialize_config"),
            patch.object(processes, "_systemctl") as systemctl,
            patch.object(processes, "_port_open", side_effect=[False, False]),
        ):
            result = await processes.start_computer(username="alice")
        systemctl.assert_called_once_with("start")
        assert result["status"] == "starting"

    @pytest.mark.asyncio
    async def test_stop_calls_systemctl(self):
        with patch.object(processes, "_systemctl") as systemctl:
            result = await processes.stop_computer()
        systemctl.assert_called_once_with("stop")
        assert result["status"] == "stopped"


class TestNativePty:
    @pytest.mark.asyncio
    async def test_pty_roundtrip(self, tmp_path):
        with patch.object(processes, "HOME_DIR", tmp_path):
            session_id, container = await processes.exec_create()
        assert container is None
        handle = processes.exec_start(session_id)
        sock = handle._sock
        sock.settimeout(2.0)
        try:
            sock.sendall(b"echo shellteam_ok\n")
            buf = b""
            deadline = time.time() + 3
            while time.time() < deadline and b"shellteam_ok" not in buf:
                try:
                    chunk = sock.recv(1024)
                except TimeoutError:
                    continue
                if not chunk:
                    break
                buf += chunk
            assert b"shellteam_ok" in buf
        finally:
            sock.sendall(b"exit\n")
            sock.close()

    def test_exec_resize_unknown_session_is_noop(self):
        # Should not raise for an unknown session id.
        processes.exec_resize("does-not-exist", height=40, width=120)


class TestRuntimeFacade:
    @pytest.mark.asyncio
    async def test_facade_dispatches_to_native_by_default(self):
        from api.services import runtime

        with patch.object(processes, "_port_open", return_value=True):
            status = await runtime.get_status("u")
        assert status["container_id"] == "native"


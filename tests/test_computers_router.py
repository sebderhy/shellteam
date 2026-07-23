"""Tests for computers router — /api/computers/* endpoints."""

import os


import httpx
import pytest
import respx
from unittest.mock import patch, AsyncMock

from api.services import ports as port_service


class TestStartComputer:
    def test_start_success(self, client, auth_header):
        with patch(
            "api.routers.computers.containers.start_computer",
            new_callable=AsyncMock,
            return_value={
                "status": "running",
                "container_id": "abc123",
                "ip": "172.20.0.5",
            },
        ):
            resp = client.post("/api/computers", headers=auth_header)

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "running"
        assert data["username"] == "alice"
        assert data["public_url"] == "https://alice.localhost"

    def test_start_without_username(self, client, auth_header, mock_get_user_profile):
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "username": None, "tier": "plus"}
        resp = client.post("/api/computers", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "error"



    def test_start_profile_missing_username_key(self, client, auth_header, mock_get_user_profile):
        """Profile without 'username' key should return error, not crash with KeyError."""
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "tier": "plus"}
        resp = client.post("/api/computers", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "error"


class TestStopComputer:
    def test_stop_success(self, client, auth_header):
        with patch(
            "api.routers.computers.containers.stop_computer",
            new_callable=AsyncMock,
            return_value={"status": "stopped"},
        ):
            resp = client.delete("/api/computers", headers=auth_header)

        assert resp.status_code == 200
        assert resp.json()["status"] == "stopped"

    def test_stop_no_container(self, client, auth_header):
        """Stopping when no container exists should still return stopped."""
        with patch(
            "api.routers.computers.containers.stop_computer",
            new_callable=AsyncMock,
            return_value={"status": "stopped"},
        ):
            resp = client.delete("/api/computers", headers=auth_header)

        assert resp.status_code == 200
        assert resp.json()["status"] == "stopped"


class TestComputerStatus:
    def test_running_status(self, client, auth_header):
        with patch(
            "api.routers.computers.containers.get_status",
            new_callable=AsyncMock,
            return_value={
                "status": "running",
                "container_id": "abc123",
                "ip": "172.20.0.5",
            },
        ):
            resp = client.get("/api/computers/status", headers=auth_header)

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "running"
        assert data["public_url"] == "https://alice.localhost"

    def test_stopped_status(self, client, auth_header):
        with patch(
            "api.routers.computers.containers.get_status",
            new_callable=AsyncMock,
            return_value={"status": "stopped", "container_id": None, "ip": None},
        ):
            resp = client.get("/api/computers/status", headers=auth_header)

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "stopped"

    def test_status_without_username(self, client, auth_header, mock_get_user_profile):
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "username": None, "tier": "plus"}
        with patch(
            "api.routers.computers.containers.get_status",
            new_callable=AsyncMock,
            return_value={"status": "stopped", "container_id": None, "ip": None},
        ):
            resp = client.get("/api/computers/status", headers=auth_header)

        assert resp.status_code == 200
        assert resp.json()["public_url"] is None

    def test_status_profile_missing_username_key(self, client, auth_header, mock_get_user_profile):
        """Profile without 'username' key should not crash with KeyError."""
        mock_get_user_profile.return_value = {"id": "user-uuid-1234", "tier": "plus"}
        with patch(
            "api.routers.computers.containers.get_status",
            new_callable=AsyncMock,
            return_value={"status": "stopped", "container_id": None, "ip": None},
        ):
            resp = client.get("/api/computers/status", headers=auth_header)

        assert resp.status_code == 200
        assert resp.json()["public_url"] is None


class TestPortVisibility:
    """Test /api/computers/ports endpoints."""

    @pytest.fixture(autouse=True)
    def _clean_ports(self, tmp_path):
        port_service._public_ports.clear()
        with patch.object(port_service, "DATA_DIR", tmp_path):
            yield
        port_service._public_ports.clear()

    def test_set_port_public(self, client, auth_header):
        resp = client.post(
            "/api/computers/ports",
            headers=auth_header,
            json={"port": 3000, "public": True},
        )
        assert resp.status_code == 200
        assert 3000 in resp.json()["public_ports"]

    def test_set_port_private(self, client, auth_header):
        port_service._public_ports["user-uuid-1234"] = {3000}
        resp = client.post(
            "/api/computers/ports",
            headers=auth_header,
            json={"port": 3000, "public": False},
        )
        assert resp.status_code == 200
        assert 3000 not in resp.json()["public_ports"]

    def test_list_ports(self, client, auth_header):
        port_service._public_ports["user-uuid-1234"] = {3000, 8080}
        resp = client.get("/api/computers/ports", headers=auth_header)
        assert resp.status_code == 200
        assert set(resp.json()["public_ports"]) == {3000, 8080}

    def test_list_ports_empty(self, client, auth_header):
        resp = client.get("/api/computers/ports", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["public_ports"] == []

    def test_max_limit_returns_400(self, client, auth_header):
        with patch.object(port_service, "MAX_PUBLIC_PORTS", 2):
            client.post("/api/computers/ports", headers=auth_header, json={"port": 3000, "public": True})
            client.post("/api/computers/ports", headers=auth_header, json={"port": 8080, "public": True})
            resp = client.post("/api/computers/ports", headers=auth_header, json={"port": 9000, "public": True})
        assert resp.status_code == 400
        assert "Maximum" in resp.json()["detail"]

    def test_invalid_port_returns_422(self, client, auth_header):
        resp = client.post(
            "/api/computers/ports",
            headers=auth_header,
            json={"port": 0, "public": True},
        )
        assert resp.status_code == 422

    def test_invalid_port_too_high_returns_422(self, client, auth_header):
        resp = client.post(
            "/api/computers/ports",
            headers=auth_header,
            json={"port": 70000, "public": True},
        )
        assert resp.status_code == 422


class TestAIProxy:
    """/api/computers/ai/{path} — proxy to the cockpit + status enrichment."""

    @respx.mock
    def test_status_enriches_opencode_available_true(self, client, auth_header, monkeypatch):
        monkeypatch.setenv("FIREWORKS_API_KEY", "fw-secret")
        respx.get("http://127.0.0.1:3456/api/status").mock(
            return_value=httpx.Response(200, json={"hasApiKey": False, "hasOAuth": False})
        )
        with patch("api.routers.computers.containers.get_container_ip",
                   new_callable=AsyncMock, return_value="127.0.0.1"):
            resp = client.get("/api/computers/ai/status", headers=auth_header)
        assert resp.status_code == 200
        body = resp.json()
        assert body["openCodeAvailable"] is True
        assert body["hasApiKey"] is False  # passthrough preserved

    @respx.mock
    def test_status_opencode_available_false_without_key(self, client, auth_header, monkeypatch):
        monkeypatch.delenv("FIREWORKS_API_KEY", raising=False)
        respx.get("http://127.0.0.1:3456/api/status").mock(
            return_value=httpx.Response(200, json={"hasApiKey": True})
        )
        with patch("api.routers.computers.containers.get_container_ip",
                   new_callable=AsyncMock, return_value="127.0.0.1"):
            resp = client.get("/api/computers/ai/status", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["openCodeAvailable"] is False

    def test_proxy_503_when_stack_down(self, client, auth_header):
        with patch("api.routers.computers.containers.get_container_ip",
                   new_callable=AsyncMock, return_value=None):
            resp = client.get("/api/computers/ai/status", headers=auth_header)
        assert resp.status_code == 503

    @respx.mock
    def test_non_status_path_passthrough_unmodified(self, client, auth_header):
        respx.post("http://127.0.0.1:3456/api/key").mock(
            return_value=httpx.Response(200, json={"success": True, "provider": "claude"})
        )
        with patch("api.routers.computers.containers.get_container_ip",
                   new_callable=AsyncMock, return_value="127.0.0.1"):
            resp = client.post("/api/computers/ai/key", headers=auth_header,
                               json={"key": "sk-ant-xxx"})
        assert resp.status_code == 200
        assert resp.json() == {"success": True, "provider": "claude"}  # no openCodeAvailable added

    @respx.mock
    def test_usage_refresh_query_is_forwarded_to_cockpit(self, client, auth_header):
        route = respx.get("http://127.0.0.1:3456/api/usage?refresh=1").mock(
            return_value=httpx.Response(200, json={"generated_at": "2026-07-10T00:00:00Z", "providers": {}})
        )
        with patch("api.routers.computers.containers.get_container_ip",
                   new_callable=AsyncMock, return_value="127.0.0.1"):
            resp = client.get("/api/computers/ai/usage?refresh=1", headers=auth_header)
        assert resp.status_code == 200
        assert route.called

"""Tests for internal port activity/cleanup endpoints."""

import os


from unittest.mock import patch

from fastapi.testclient import TestClient

from api.main import app


def _make_auth_headers(user_id="user-uuid-1234"):
    from api.services.internal_auth import make_token

    token = make_token(user_id)
    return {
        "Authorization": f"Bearer {token}",
        "X-Shellteam-User-Id": user_id,
    }


def test_get_port_activity_internal():
    headers = _make_auth_headers()
    with (
        patch("api.routers.internal.ports.get_public_ports", return_value={3000}),
        patch(
            "api.routers.internal.ports.get_port_activity",
            return_value={3000: {"last_hit_at": 100.0, "hit_count": 2}},
        ),
    ):
        with TestClient(app) as client:
            resp = client.get("/internal/ports/activity", headers=headers)

    assert resp.status_code == 200
    assert resp.json()["public_ports"] == [3000]
    assert resp.json()["activity"]["3000"]["hit_count"] == 2


def test_cleanup_stale_ports_internal():
    headers = _make_auth_headers()
    with patch("api.routers.internal.ports.cleanup_stale_public_ports", return_value=[3000, 8080]):
        with TestClient(app) as client:
            resp = client.post("/internal/ports/cleanup", headers=headers, json={"idle_days": 7})

    assert resp.status_code == 200
    assert resp.json()["closed_ports"] == [3000, 8080]

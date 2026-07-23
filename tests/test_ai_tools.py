"""Tests for AI tools token auth — all endpoints share _verify_token."""

import os

from unittest.mock import patch
from fastapi.testclient import TestClient

from api.main import app
from api.services.internal_auth import make_token


ENDPOINT = "/internal/ai/stt"
USER_ID = "test-user-123"


def _files():
    return {"file": ("note.mp3", b"fake-audio-bytes", "audio/mpeg")}


class TestAiToolsAuth:
    """All AI endpoints share _verify_token dependency. Test via /stt."""

    def test_no_bearer_header_returns_401(self):
        """Missing Authorization header → 401."""
        with TestClient(app) as client:
            resp = client.post(ENDPOINT, files=_files())
        assert resp.status_code == 401

    def test_wrong_token_returns_401(self):
        with TestClient(app) as client:
            resp = client.post(
                ENDPOINT,
                files=_files(),
                headers={
                    "Authorization": "Bearer wrong-token",
                    "X-Shellteam-User-Id": USER_ID,
                },
            )
        assert resp.status_code == 401

    def test_token_for_different_user_returns_401(self):
        """Token derived from user A cannot be used with user B's ID."""
        token = make_token("other-user-456")
        with TestClient(app) as client:
            resp = client.post(
                ENDPOINT,
                files=_files(),
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Shellteam-User-Id": USER_ID,
                },
            )
        assert resp.status_code == 401

    def test_missing_user_id_header_returns_401(self):
        """Token without X-Shellteam-User-Id header → 401."""
        token = make_token(USER_ID)
        with TestClient(app) as client:
            resp = client.post(
                ENDPOINT,
                files=_files(),
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 401

    def test_valid_token_passes_auth(self):
        """Correct HMAC token passes auth — downstream may error, but auth succeeded."""
        token = make_token(USER_ID)
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": ""}, clear=False):
            with TestClient(app) as client:
                resp = client.post(
                    ENDPOINT,
                    files=_files(),
                    headers={
                        "Authorization": f"Bearer {token}",
                        "X-Shellteam-User-Id": USER_ID,
                    },
                )
        # 502 = ELEVENLABS_API_KEY not configured, which means auth passed
        assert resp.status_code == 502
        assert "Feature keys" in resp.json()["detail"]  # points at Settings, not .env+restart

    def test_master_secret_passes_auth(self):
        """OSS single-user: the master SHELLTEAM_AI_TOKEN is itself a valid
        credential (the cockpit + agents present it raw, with any user id)."""
        master = os.environ["SHELLTEAM_AI_TOKEN"]
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": ""}, clear=False):
            with TestClient(app) as client:
                resp = client.post(
                    ENDPOINT,
                    files=_files(),
                    headers={
                        "Authorization": f"Bearer {master}",
                        "X-Shellteam-User-Id": USER_ID,
                    },
                )
        # Auth passed (got to the downstream "key not configured"), not 401.
        assert resp.status_code == 502
        assert "Feature keys" in resp.json()["detail"]  # points at Settings, not .env+restart

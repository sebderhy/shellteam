"""Tests for AI tools token auth — all endpoints share _verify_token."""

import json
import os

import httpx
import respx

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




TTS_ENDPOINT = "/internal/ai/tts"
ELEVENLABS_TTS_URL_RE = r"https://api\.elevenlabs\.io/v1/text-to-speech/.*"


def _owner_headers():
    return {
        "Authorization": f"Bearer {os.environ['SHELLTEAM_AI_TOKEN']}",
        "X-Shellteam-User-Id": USER_ID,
    }


class TestTextToSpeech:
    """Spoken replies: the owner's ElevenLabs key, spent on the owner's say-so."""

    def test_no_key_points_at_settings_instead_of_failing_blankly(self):
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": ""}, clear=False):
            with TestClient(app) as client:
                resp = client.post(TTS_ENDPOINT, json={"text": "hello"}, headers=_owner_headers())
        assert resp.status_code == 502
        assert "Feature keys" in resp.json()["detail"]

    def test_empty_text_is_rejected_before_any_spend(self):
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "el-key"}, clear=False):
            with TestClient(app) as client:
                resp = client.post(TTS_ENDPOINT, json={"text": "   "}, headers=_owner_headers())
        assert resp.status_code == 400

    def test_an_oversized_body_is_refused_not_quietly_truncated(self):
        """The cockpit trims for listenability; this is the spend guard behind
        it, and it must say no rather than silently synthesise a novel."""
        from api.services import tts

        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "el-key"}, clear=False):
            with TestClient(app) as client:
                resp = client.post(
                    TTS_ENDPOINT,
                    json={"text": "a" * (tts.MAX_CHARS + 1)},
                    headers=_owner_headers(),
                )
        assert resp.status_code == 400
        assert str(tts.MAX_CHARS) in resp.json()["detail"]

    @respx.mock
    def test_returns_mp3_bytes_from_the_configured_voice(self):
        route = respx.post(url__regex=ELEVENLABS_TTS_URL_RE).mock(
            return_value=httpx.Response(200, content=b"ID3-fake-mp3")
        )
        env = {"ELEVENLABS_API_KEY": "el-key", "SHELLTEAM_TTS_VOICE": "", "SHELLTEAM_TTS_MODEL": ""}
        with patch.dict(os.environ, env, clear=False):
            with TestClient(app) as client:
                resp = client.post(TTS_ENDPOINT, json={"text": "All green."}, headers=_owner_headers())

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/mpeg"
        assert resp.content == b"ID3-fake-mp3"
        sent = route.calls.last.request
        assert sent.headers["xi-api-key"] == "el-key"
        assert tts_defaults()[0] in str(sent.url)
        assert json.loads(sent.content)["model_id"] == tts_defaults()[1]

    @respx.mock
    def test_voice_and_model_are_overridable_without_a_code_change(self):
        route = respx.post(url__regex=ELEVENLABS_TTS_URL_RE).mock(
            return_value=httpx.Response(200, content=b"mp3")
        )
        env = {
            "ELEVENLABS_API_KEY": "el-key",
            "SHELLTEAM_TTS_VOICE": "voice-xyz",
            "SHELLTEAM_TTS_MODEL": "eleven_v3",
        }
        with patch.dict(os.environ, env, clear=False):
            with TestClient(app) as client:
                resp = client.post(TTS_ENDPOINT, json={"text": "Hi."}, headers=_owner_headers())

        assert resp.status_code == 200
        sent = route.calls.last.request
        assert "voice-xyz" in str(sent.url)
        assert json.loads(sent.content)["model_id"] == "eleven_v3"

    @respx.mock
    def test_upstream_failure_surfaces_as_502_not_a_silent_empty_player(self):
        respx.post(url__regex=ELEVENLABS_TTS_URL_RE).mock(
            return_value=httpx.Response(401, text="unauthorized")
        )
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "el-key"}, clear=False):
            with TestClient(app) as client:
                resp = client.post(TTS_ENDPOINT, json={"text": "Hi."}, headers=_owner_headers())
        assert resp.status_code == 502
        assert "401" in resp.json()["detail"]

    def test_status_advertises_tts_from_the_same_key_as_stt(self):
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "el-key"}, clear=False):
            with TestClient(app) as client:
                resp = client.get("/internal/ai/status", headers=_owner_headers())
        assert resp.json()["tts"] is True
        assert resp.json()["stt"] is True

    def test_status_reports_no_tts_without_a_key(self):
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": ""}, clear=False):
            with TestClient(app) as client:
                resp = client.get("/internal/ai/status", headers=_owner_headers())
        assert resp.json()["tts"] is False


def tts_defaults():
    from api.services import tts

    return tts.DEFAULT_VOICE, tts.DEFAULT_MODEL

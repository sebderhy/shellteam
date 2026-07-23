"""Speech-to-text via ElevenLabs Scribe v2.

Two ways to reach it, checked in order:

1. **Own key** (`ELEVENLABS_API_KEY`) — direct call. Always wins when set.
2. **Managed relay** (`SHELLTEAM_RELAY_URL` + `SHELLTEAM_RELAY_TOKEN`) — for
   managed (ShellTeam Cloud) boxes: the box holds only a revocable, quota-capped
   relay token and the provider key never touches its disk. The relay exposes
   the same contract (`POST {url}/stt` multipart → `{"text": …}`).

Neither configured → a loud, actionable error. No silent fallback.
"""

import logging
import os

import httpx

log = logging.getLogger(__name__)


async def transcribe(audio_bytes: bytes, filename: str = "audio.mp3", content_type: str = "audio/mpeg") -> str:
    """Transcribe audio bytes via ElevenLabs Scribe v2. Returns transcribed text."""
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if key:
        return await _transcribe_direct(key, audio_bytes, filename, content_type)

    relay_url = os.environ.get("SHELLTEAM_RELAY_URL", "").rstrip("/")
    relay_token = os.environ.get("SHELLTEAM_RELAY_TOKEN", "")
    if relay_url and relay_token:
        return await _transcribe_via_relay(relay_url, relay_token, audio_bytes, filename, content_type)

    raise RuntimeError("Voice transcription needs an ElevenLabs API key — add it in Settings → Feature keys (no restart needed)")


async def _transcribe_direct(key: str, audio_bytes: bytes, filename: str, content_type: str) -> str:
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers={"xi-api-key": key},
            files={"file": (filename, audio_bytes, content_type)},
            data={"model_id": "scribe_v2"},
        )

    if resp.status_code != 200:
        log.warning("ElevenLabs STT failed: %s %s", resp.status_code, resp.text[:200])
        raise RuntimeError(f"Speech-to-text failed (HTTP {resp.status_code})")

    return resp.json().get("text", "")


async def _transcribe_via_relay(relay_url: str, relay_token: str, audio_bytes: bytes,
                                filename: str, content_type: str) -> str:
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{relay_url}/stt",
            headers={"Authorization": f"Bearer {relay_token}"},
            files={"file": (filename, audio_bytes, content_type)},
        )

    if resp.status_code != 200:
        log.warning("STT relay failed: %s %s", resp.status_code, resp.text[:200])
        raise RuntimeError(f"Speech-to-text failed (relay HTTP {resp.status_code})")

    log.info("STT via managed relay ok (%d bytes)", len(audio_bytes))
    return resp.json().get("text", "")

"""Text-to-speech via ElevenLabs — the voice half of the cockpit's audio replies.

The mirror image of [stt.py](stt.py): the same owner key (`ELEVENLABS_API_KEY`),
the same "add it in Settings" failure, one direction of travel apart.

Managed (relay) boxes are deliberately NOT covered: the relay contract stt.py
speaks exposes `/stt` only, so calling a `/tts` that may not exist there would
fail at the worst possible moment — mid-reply, on someone else's box. On a relay
box voice output stays off and says why.
"""

import logging
import os

import httpx

log = logging.getLogger(__name__)

# "River" — calm, neutral, informative. A cockpit reply is information, not
# performance, so the default voice is the one you can listen to for an hour.
DEFAULT_VOICE = "SAz9YHcvj6GT2YYXdXww"
# Flash is the low-latency model AND half the credit cost per character. A
# spoken reply lands in the middle of a conversation, so latency wins over the
# extra expressiveness of eleven_v3.
DEFAULT_MODEL = "eleven_flash_v2_5"

# Spend guard, not a UX limit: the cockpit already trims a reply to something
# listenable before it gets here (lib/speakable.mjs). Anything this long means a
# caller lost the plot, and a quiet 60k-character synthesis would eat a fifth of
# a month's quota without anyone noticing.
MAX_CHARS = 5000


def voice_id() -> str:
    return os.environ.get("SHELLTEAM_TTS_VOICE", "").strip() or DEFAULT_VOICE


def model_id() -> str:
    return os.environ.get("SHELLTEAM_TTS_MODEL", "").strip() or DEFAULT_MODEL


async def synthesize(text: str) -> bytes:
    """Speak `text` with the owner's ElevenLabs key. Returns MP3 bytes."""
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        raise RuntimeError(
            "Spoken replies need an ElevenLabs API key — add it in Settings → Feature keys (no restart needed)"
        )
    if not text.strip():
        raise ValueError("Nothing to speak")
    if len(text) > MAX_CHARS:
        raise ValueError(f"Text is {len(text)} characters; the spoken-reply limit is {MAX_CHARS}")

    voice, model = voice_id(), model_id()
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
            headers={"xi-api-key": key},
            params={"output_format": "mp3_44100_128"},
            json={"text": text, "model_id": model},
        )

    if resp.status_code != 200:
        log.warning("ElevenLabs TTS failed: %s %s", resp.status_code, resp.text[:200])
        raise RuntimeError(f"Speech synthesis failed (HTTP {resp.status_code})")

    log.info(
        "TTS ok: %d chars -> %d bytes (voice=%s model=%s)",
        len(text), len(resp.content), voice, model,
    )
    return resp.content

"""STT source selection: own key > managed relay > loud error.

The relay path is what makes managed (ShellTeam Cloud) boxes work with zero
configured keys; the precedence rule is what lets a customer switch to their
own key just by setting it.
"""

import httpx
import pytest
import respx

from api.services import stt

AUDIO = b"fake-webm-bytes"


def _clear(monkeypatch):
    for var in ("ELEVENLABS_API_KEY", "SHELLTEAM_RELAY_URL", "SHELLTEAM_RELAY_TOKEN"):
        monkeypatch.delenv(var, raising=False)


@respx.mock
async def test_own_key_goes_direct(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "xi-own-key")
    route = respx.post("https://api.elevenlabs.io/v1/speech-to-text").mock(
        return_value=httpx.Response(200, json={"text": "hello"})
    )
    assert await stt.transcribe(AUDIO) == "hello"
    assert route.call_count == 1
    assert route.calls[0].request.headers["xi-api-key"] == "xi-own-key"


@respx.mock
async def test_relay_used_when_no_key(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("SHELLTEAM_RELAY_URL", "https://relay.example.com/relay")
    monkeypatch.setenv("SHELLTEAM_RELAY_TOKEN", "strelay_abc")
    route = respx.post("https://relay.example.com/relay/stt").mock(
        return_value=httpx.Response(200, json={"text": "via relay"})
    )
    assert await stt.transcribe(AUDIO) == "via relay"
    assert route.calls[0].request.headers["authorization"] == "Bearer strelay_abc"


@respx.mock
async def test_own_key_wins_over_relay(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "xi-own-key")
    monkeypatch.setenv("SHELLTEAM_RELAY_URL", "https://relay.example.com/relay")
    monkeypatch.setenv("SHELLTEAM_RELAY_TOKEN", "strelay_abc")
    direct = respx.post("https://api.elevenlabs.io/v1/speech-to-text").mock(
        return_value=httpx.Response(200, json={"text": "direct"})
    )
    relay = respx.post("https://relay.example.com/relay/stt").mock(
        return_value=httpx.Response(200, json={"text": "relay"})
    )
    assert await stt.transcribe(AUDIO) == "direct"
    assert direct.called and not relay.called


async def test_neither_configured_raises_actionable_error(monkeypatch):
    _clear(monkeypatch)
    with pytest.raises(RuntimeError, match="ElevenLabs API key"):
        await stt.transcribe(AUDIO)


async def test_relay_token_without_url_still_raises(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("SHELLTEAM_RELAY_TOKEN", "strelay_abc")
    with pytest.raises(RuntimeError, match="ElevenLabs API key"):
        await stt.transcribe(AUDIO)


@respx.mock
async def test_relay_error_surfaces_loudly(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("SHELLTEAM_RELAY_URL", "https://relay.example.com/relay")
    monkeypatch.setenv("SHELLTEAM_RELAY_TOKEN", "strelay_abc")
    respx.post("https://relay.example.com/relay/stt").mock(
        return_value=httpx.Response(429, json={"detail": "quota"})
    )
    with pytest.raises(RuntimeError, match="relay HTTP 429"):
        await stt.transcribe(AUDIO)

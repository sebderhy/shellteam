"""Proxy endpoints for AI tools (STT + the Fireworks proxy for OpenCode).

Keys stay on the host — in-box tools authenticate with per-user HMAC tokens.
"""

import json
import logging
import os

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from api.services.internal_auth import verify_token
from api.services.ratelimit import RateLimiter
from api.services import feature_keys, stt

log = logging.getLogger(__name__)
router = APIRouter(prefix="/internal/ai", tags=["ai-tools"])

# --- Auth + rate limit ---

_bearer = HTTPBearer()
_ai_limit = RateLimiter(rate=50, period=86400, key="user")  # 50 req/day per user


async def _verify_token(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> None:
    user_id = request.headers.get("X-Shellteam-User-Id", "").strip()
    if not user_id or not verify_token(creds.credentials, user_id):
        raise HTTPException(status_code=401, detail="Invalid token")
    # Set user_id for per-user rate limiting
    request.state.rate_limit_user_id = user_id


def _require_env_key(var: str) -> str:
    """Return the provider key from the environment or fail with a clear 503."""
    key = os.environ.get(var, "")
    if not key:
        raise HTTPException(status_code=503, detail=f"{var} not configured")
    return key


# --- Availability status (cockpit polls this instead of stale process env) ---


@router.get("/status", dependencies=[Depends(_verify_token)])
async def ai_status() -> dict:
    """Which key-gated AI capabilities this box has RIGHT NOW.

    Read from os.environ at request time so a key saved via the dashboard
    (Settings → Feature keys) flips availability without any restart. No rate
    limit beyond auth — the cockpit polls this to keep its status live. The
    key→capability mapping lives ONLY in feature_keys.FEATURE_KEYS.
    """
    return feature_keys.capability_status()


# --- Speech-to-text (cockpit voice input) ---


@router.post("/stt", dependencies=[Depends(_verify_token), Depends(_ai_limit)])
async def speech_to_text(file: UploadFile = File(...)):
    """Transcribe audio via ElevenLabs Scribe v2. Returns JSON {text, language_code}."""
    audio_bytes = await file.read()
    try:
        text = await stt.transcribe(
            audio_bytes,
            filename=file.filename or "audio.mp3",
            content_type=file.content_type or "audio/mpeg",
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"text": text, "language_code": ""}


# --- Fireworks proxy (for OpenCode + Kimi K2.6) ---
#
# OpenCode runs on the box and never sees FIREWORKS_API_KEY.
# It points `@ai-sdk/openai-compatible` at these endpoints with a per-user HMAC
# bearer; we swap in the real Fireworks key server-side. This means every user
# gets a working coding agent without bringing their own credentials.

FIREWORKS_UPSTREAM = "https://api.fireworks.ai/inference/v1"
# The set of upstream model ids we forward is the catalog's OpenCode models
# (config/models.json → api/services/model_catalog.py). Add a Fireworks model
# there + restart the API to allowlist it — no code change here.
from api.services.model_catalog import fireworks_allowlist

# Explicit budgets for every Fireworks upstream call — never an unbounded
# client. `read` is the inter-chunk budget: streaming turns legitimately stay
# open for minutes, but 300s with zero bytes from upstream means it is dead —
# a stalled upstream must not hold sockets/tasks forever.
FIREWORKS_TIMEOUT = httpx.Timeout(connect=10, read=120, write=30, pool=10)
FIREWORKS_STREAM_TIMEOUT = httpx.Timeout(connect=10, read=300, write=30, pool=10)

# Per-owner daily turn cap: a guardrail against a runaway local agent spending
# through the owner's Fireworks key.
_fireworks_limit = RateLimiter(rate=200, period=86400, key="user")


def _fireworks_key() -> str:
    return _require_env_key("FIREWORKS_API_KEY")


def _log_fireworks_usage(user_id: str, model: str, usage: dict | None) -> None:
    """Emit a single INFO line per turn so we can attribute spend per user.

    Hook for future $/day enforcement — aggregate these records offline or via Redis counter.
    """
    if not usage:
        log.warning("fireworks: no usage reported user_id=%s model=%s", user_id, model)
        return
    prompt = usage.get("prompt_tokens") or 0
    completion = usage.get("completion_tokens") or 0
    total = usage.get("total_tokens") or (prompt + completion)
    log.info(
        "fireworks user_id=%s model=%s prompt_tokens=%d completion_tokens=%d total_tokens=%d",
        user_id, model, prompt, completion, total,
    )


@router.post("/fireworks/v1/chat/completions", dependencies=[Depends(_verify_token), Depends(_fireworks_limit)])
async def fireworks_chat_completions(request: Request):
    """Proxy POST to Fireworks /v1/chat/completions, substituting our API key.

    Forwards streaming (SSE) and non-streaming responses unchanged, but enforces
    a model allowlist and attributes token usage to the calling user.
    """
    user_id = request.headers.get("X-Shellteam-User-Id", "").strip()

    body_bytes = await request.body()
    try:
        body = json.loads(body_bytes)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    model = body.get("model", "")
    if model not in fireworks_allowlist():
        log.warning("fireworks: rejected non-allowlisted model user_id=%s model=%s", user_id, model)
        raise HTTPException(status_code=400, detail=f"Model '{model}' is not allowed")

    # Force include_usage so we always get accounting on streaming turns.
    is_stream = bool(body.get("stream"))
    if is_stream:
        body.setdefault("stream_options", {})["include_usage"] = True

    upstream_headers = {
        "Authorization": f"Bearer {_fireworks_key()}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if is_stream else "application/json",
    }

    if not is_stream:
        async with httpx.AsyncClient(timeout=FIREWORKS_TIMEOUT) as client:
            resp = await client.post(
                f"{FIREWORKS_UPSTREAM}/chat/completions",
                json=body,
                headers=upstream_headers,
            )
        if resp.status_code != 200:
            log.warning(
                "fireworks: upstream error user_id=%s status=%d body=%s",
                user_id, resp.status_code, resp.text[:300],
            )
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type", "application/json"),
            )
        data = resp.json()
        _log_fireworks_usage(user_id, model, data.get("usage"))
        return data

    # Streaming: passthrough SSE chunks while tail-parsing the last usage chunk.
    client = httpx.AsyncClient(timeout=FIREWORKS_STREAM_TIMEOUT)

    async def relay():
        last_data_chunk: str | None = None
        try:
            async with client.stream(
                "POST",
                f"{FIREWORKS_UPSTREAM}/chat/completions",
                json=body,
                headers=upstream_headers,
            ) as upstream:
                if upstream.status_code != 200:
                    err = await upstream.aread()
                    log.warning(
                        "fireworks: upstream stream error user_id=%s status=%d body=%s",
                        user_id, upstream.status_code, err[:300],
                    )
                    yield err
                    return
                async for line in upstream.aiter_lines():
                    if line.startswith("data: "):
                        payload = line[6:].strip()
                        if payload and payload != "[DONE]":
                            last_data_chunk = payload
                    yield (line + "\n").encode()
        finally:
            await client.aclose()
            if last_data_chunk:
                try:
                    parsed = json.loads(last_data_chunk)
                    _log_fireworks_usage(user_id, model, parsed.get("usage"))
                except json.JSONDecodeError:
                    pass

    return StreamingResponse(relay(), media_type="text/event-stream")


@router.get("/fireworks/v1/models", dependencies=[Depends(_verify_token)])
async def fireworks_models():
    """Return the allowlisted Fireworks models (not a full upstream list)."""
    return {
        "object": "list",
        "data": [{"id": m, "object": "model", "owned_by": "fireworks"} for m in sorted(fireworks_allowlist())],
    }

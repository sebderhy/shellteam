"""In-product feedback endpoint — owner submits a bug report or feature request
(text + screenshots + voice) and it's forwarded to the ShellTeam maintainer relay.

The box transcribes the voice note locally with the owner's own ElevenLabs key,
then hands off to ``api.services.feedback.forward`` which talks to the relay (no
maintainer secret ever lives in the box).
"""

import json
import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile

from api.config import APP_DOMAIN, OWNER_USERNAME, RUNTIME
from api.services import feedback, stt
from api.services.auth import (
    get_token_from_request,
    token_is_owner,
)
from api.services.ratelimit import note_auth_failure

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/feedback", tags=["feedback"])

MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB per screenshot
MAX_SCREENSHOTS = 5


async def feedback_principal(request: Request) -> dict:
    """Who is sending feedback — the owner (master token) OR an authenticated
    employee guest. Both are legitimate senders; the label is carried into the
    relay so the maintainer can tell an employee's report apart from the owner's.

    We check the owner token WITHOUT the brute-force throttle so a guest (who
    never carries the master token) is not penalised for its absence.
    """
    if token_is_owner(get_token_from_request(request)):
        return {"label": "owner", "guest": None, "folder": None}
    note_auth_failure(request)
    raise HTTPException(status_code=401, detail="Invalid or expired token")


def _parse_json(raw: str, fallback):
    try:
        return json.loads(raw) if raw else fallback
    except json.JSONDecodeError:
        return fallback


@router.post("")
async def submit_feedback(
    kind: str = Form("bug"),
    description: str = Form(""),
    frontend_logs: str = Form("[]"),
    browser_info: str = Form("{}"),
    page_url: str = Form(""),
    screenshots: list[UploadFile] = File(default=[]),
    voice_recording: UploadFile | None = File(None),
    principal: dict = Depends(feedback_principal),
):
    """Submit feedback. Returns the relay's ``{ok, issue_url?}``."""
    if not feedback.RELAY_URL:
        raise HTTPException(status_code=503, detail="Feedback is disabled (FEEDBACK_RELAY_URL is unset)")
    if kind not in ("bug", "feature"):
        raise HTTPException(status_code=422, detail="kind must be 'bug' or 'feature'")

    # Read + validate screenshots (image-only, capped count and size).
    shots: list[tuple[str, bytes, str]] = []
    for shot in screenshots:
        if not shot.filename:
            continue
        if len(shots) >= MAX_SCREENSHOTS:
            raise HTTPException(status_code=413, detail=f"At most {MAX_SCREENSHOTS} screenshots")
        ctype = shot.content_type or "application/octet-stream"
        if not ctype.startswith("image/"):
            raise HTTPException(status_code=415, detail="Screenshots must be images")
        content = await shot.read()
        if len(content) > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail="Screenshot over 10 MB")
        shots.append((shot.filename, content, ctype))

    # Transcribe the voice note locally with the owner's ElevenLabs key.
    transcript = ""
    if voice_recording and voice_recording.filename:
        audio = await voice_recording.read()
        try:
            transcript = await stt.transcribe(
                audio,
                filename=voice_recording.filename or "voice.webm",
                content_type=voice_recording.content_type or "audio/webm",
            )
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=f"Transcription failed: {e}")

    final_description = description.strip()
    if not final_description and not transcript:
        raise HTTPException(status_code=422, detail="Provide a description or a voice recording")

    meta = {
        "app_domain": APP_DOMAIN,
        "owner_username": OWNER_USERNAME,
        "runtime": RUNTIME,
        "page_url": page_url,
        "browser_info": _parse_json(browser_info, {}),
        "frontend_logs": _parse_json(frontend_logs, []),
        "submitted_by": principal["label"],
    }
    if principal["guest"]:
        meta["guest_folder"] = principal["folder"]

    try:
        result = await feedback.forward(
            kind=kind,
            description=final_description,
            transcript=transcript,
            meta=meta,
            screenshots=shots,
        )
    except (RuntimeError, OSError) as e:
        # Surface a real error to the modal — no silent drop.
        log.warning("Feedback forward failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Could not reach the feedback service: {e}")

    log.info(
        "Feedback submitted by %s: kind=%s issue=%s",
        principal["label"], kind, result.get("issue_url"),
    )
    return result

"""Owner-notification primitive (M0 §0.4) — the channel OSS never had.

Everything downstream (guest-connected pings, ship summaries, escalations, and
later the dreaming brief) needs ONE way to reach the owner off-box. This module
is that single choke-point. Channel is auto-detected from the environment, in
priority order:

  1. Telegram  — ``NOTIFY_TELEGRAM_BOT_TOKEN`` + ``NOTIFY_TELEGRAM_CHAT_ID``
                 (rich, 5-min setup: message @BotFather, then get your chat id).
  2. ntfy.sh   — ``NOTIFY_NTFY_TOPIC`` (zero-setup fallback: pick a hard-to-guess
                 topic, install the ntfy app, subscribe to it).
  3. none      — log-only. Loud WARNING so a missing channel is never silent.

No secrets leave the box except to the configured channel's own API. Errors are
surfaced (logged at ERROR) but never raised to the caller — a failed notification
must not brick a guest session or a deploy; the caller logged its intent already.
"""

import logging
import os

import httpx

log = logging.getLogger(__name__)

NTFY_BASE = os.environ.get("NOTIFY_NTFY_SERVER", "https://ntfy.sh")


def notify_channel() -> str:
    """Which channel is configured: 'telegram', 'ntfy', or 'none'."""
    if os.environ.get("NOTIFY_TELEGRAM_BOT_TOKEN") and os.environ.get("NOTIFY_TELEGRAM_CHAT_ID"):
        return "telegram"
    if os.environ.get("NOTIFY_NTFY_TOPIC"):
        return "ntfy"
    return "none"


async def send_notification(title: str, body: str, url: str | None = None) -> dict:
    """Send an owner notification. Returns ``{"channel": ..., "ok": bool}``.

    Never raises: a delivery failure is logged and reported in the return value,
    so callers (guest bridge, deploy orchestrator) can proceed regardless.
    """
    channel = notify_channel()
    # This is THE always-notify choke-point (a ship/escalation must never be
    # bricked by a delivery bug). Guard every channel send so nothing — not even
    # an unexpected encoding error — can raise out of here.
    try:
        if channel == "telegram":
            return await _send_telegram(title, body, url)
        if channel == "ntfy":
            return await _send_ntfy(title, body, url)
    except Exception as exc:  # never let a notification crash the caller
        log.error("notify: %s send raised unexpectedly: %r", channel, exc)
        return {"channel": channel, "ok": False}
    log.warning(
        "notify: no channel configured (set NOTIFY_TELEGRAM_BOT_TOKEN+"
        "NOTIFY_TELEGRAM_CHAT_ID or NOTIFY_NTFY_TOPIC) — dropping: %s | %s",
        title, body,
    )
    return {"channel": "none", "ok": False}


async def _send_telegram(title: str, body: str, url: str | None) -> dict:
    token = os.environ["NOTIFY_TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["NOTIFY_TELEGRAM_CHAT_ID"]
    text = f"*{title}*\n{body}"
    if url:
        text += f"\n{url}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown",
                      "disable_web_page_preview": True},
            )
        if resp.status_code == 200:
            log.info("notify: sent via Telegram (%s)", title)
            return {"channel": "telegram", "ok": True}
        log.error("notify: Telegram send failed (%s): %s", resp.status_code, resp.text[:300])
        return {"channel": "telegram", "ok": False}
    except httpx.HTTPError as exc:
        log.error("notify: Telegram send errored: %s", exc)
        return {"channel": "telegram", "ok": False}


async def _send_ntfy(title: str, body: str, url: str | None) -> dict:
    topic = os.environ["NOTIFY_NTFY_TOPIC"]
    # Publish via ntfy's JSON body (NOT the header API): HTTP headers are latin-1
    # only, so a UTF-8 title (e.g. a 🚢 emoji) raises UnicodeEncodeError when set
    # as the `Title` header. The JSON body is UTF-8-clean and preserves emoji.
    payload: dict = {"topic": topic, "title": title, "message": body}
    if url:
        payload["actions"] = [{"action": "view", "label": "Open", "url": url}]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(NTFY_BASE, json=payload)
        if resp.status_code < 300:
            log.info("notify: sent via ntfy (%s)", title)
            return {"channel": "ntfy", "ok": True}
        log.error("notify: ntfy send failed (%s): %s", resp.status_code, resp.text[:300])
        return {"channel": "ntfy", "ok": False}
    except httpx.HTTPError as exc:
        log.error("notify: ntfy send errored: %s", exc)
        return {"channel": "ntfy", "ok": False}

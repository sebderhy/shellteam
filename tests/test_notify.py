"""Tests for the owner-notification primitive (api.services.notify).

The contract that matters: channel auto-detection is correct, and delivery
NEVER raises — a failed notification returns ``{"ok": False}`` so it can't brick
a guest session or a deploy.
"""

import importlib
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


@pytest.fixture(autouse=True)
def _restore_singletons():
    """`importlib.reload` of notify/internal_auth mutates shared singletons; restore
    them from the conftest-pinned env after each test so secrets don't leak forward."""
    yield
    import api.services.notify, api.services.internal_auth
    for m in (api.services.notify, api.services.internal_auth):
        importlib.reload(m)


def _reload_notify(monkeypatch, **env):
    # Clear all notify vars first so tests are order-independent.
    for k in ("NOTIFY_TELEGRAM_BOT_TOKEN", "NOTIFY_TELEGRAM_CHAT_ID", "NOTIFY_NTFY_TOPIC"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import api.services.notify as notify
    importlib.reload(notify)
    return notify


class TestChannelDetection:
    def test_none_by_default(self, monkeypatch):
        n = _reload_notify(monkeypatch)
        assert n.notify_channel() == "none"

    def test_suite_env_has_no_real_notify_channel(self):
        """Regression: conftest must scrub NOTIFY_* so the suite can never hit a
        real Telegram/ntfy endpoint. Before this, `dreaming.run_dream` tests sent
        5 real 'Dream report' pings to the owner's phone (2026-07-13) because the
        exported `.env` creds leaked straight through `os.environ`. This asserts
        the ambient channel — no monkeypatch — is neutralized."""
        import os

        from api.services import notify

        assert not os.environ.get("NOTIFY_TELEGRAM_BOT_TOKEN")
        assert not os.environ.get("NOTIFY_TELEGRAM_CHAT_ID")
        assert not os.environ.get("NOTIFY_NTFY_TOPIC")
        assert notify.notify_channel() == "none"

    def test_telegram_needs_both_vars(self, monkeypatch):
        n = _reload_notify(monkeypatch, NOTIFY_TELEGRAM_BOT_TOKEN="t")
        assert n.notify_channel() == "none"  # chat id missing
        n = _reload_notify(monkeypatch, NOTIFY_TELEGRAM_BOT_TOKEN="t", NOTIFY_TELEGRAM_CHAT_ID="c")
        assert n.notify_channel() == "telegram"

    def test_ntfy_detected(self, monkeypatch):
        n = _reload_notify(monkeypatch, NOTIFY_NTFY_TOPIC="my-topic")
        assert n.notify_channel() == "ntfy"

    def test_telegram_wins_over_ntfy(self, monkeypatch):
        n = _reload_notify(
            monkeypatch,
            NOTIFY_TELEGRAM_BOT_TOKEN="t", NOTIFY_TELEGRAM_CHAT_ID="c",
            NOTIFY_NTFY_TOPIC="my-topic",
        )
        assert n.notify_channel() == "telegram"


@pytest.mark.asyncio
class TestSend:
    async def test_no_channel_drops_gracefully(self, monkeypatch):
        n = _reload_notify(monkeypatch)
        res = await n.send_notification("hi", "there")
        assert res == {"channel": "none", "ok": False}

    async def test_telegram_success(self, monkeypatch):
        n = _reload_notify(monkeypatch, NOTIFY_TELEGRAM_BOT_TOKEN="t", NOTIFY_TELEGRAM_CHAT_ID="c")
        resp = MagicMock(status_code=200)
        with patch("httpx.AsyncClient.post", AsyncMock(return_value=resp)):
            res = await n.send_notification("Title", "Body", "https://x")
        assert res == {"channel": "telegram", "ok": True}

    async def test_telegram_http_error_is_caught(self, monkeypatch):
        n = _reload_notify(monkeypatch, NOTIFY_TELEGRAM_BOT_TOKEN="t", NOTIFY_TELEGRAM_CHAT_ID="c")
        with patch("httpx.AsyncClient.post", AsyncMock(side_effect=httpx.ConnectError("boom"))):
            res = await n.send_notification("Title", "Body")
        assert res == {"channel": "telegram", "ok": False}  # never raises

    async def test_telegram_non_200_is_failure(self, monkeypatch):
        n = _reload_notify(monkeypatch, NOTIFY_TELEGRAM_BOT_TOKEN="t", NOTIFY_TELEGRAM_CHAT_ID="c")
        resp = MagicMock(status_code=403, text="forbidden")
        with patch("httpx.AsyncClient.post", AsyncMock(return_value=resp)):
            res = await n.send_notification("Title", "Body")
        assert res == {"channel": "telegram", "ok": False}

    async def test_ntfy_success(self, monkeypatch):
        n = _reload_notify(monkeypatch, NOTIFY_NTFY_TOPIC="topic")
        resp = MagicMock(status_code=200)
        with patch("httpx.AsyncClient.post", AsyncMock(return_value=resp)):
            res = await n.send_notification("Title", "Body", "https://x")
        assert res == {"channel": "ntfy", "ok": True}

    async def test_ntfy_http_error_is_caught(self, monkeypatch):
        n = _reload_notify(monkeypatch, NOTIFY_NTFY_TOPIC="topic")
        with patch("httpx.AsyncClient.post", AsyncMock(side_effect=httpx.ConnectError("boom"))):
            res = await n.send_notification("Title", "Body")
        assert res == {"channel": "ntfy", "ok": False}

    async def test_ntfy_emoji_title_uses_json_body_not_header(self, monkeypatch):
        """Regression: a UTF-8 title (🚢) must NOT go in an HTTP header (latin-1
        only → UnicodeEncodeError). It must ride the UTF-8 JSON body instead."""
        n = _reload_notify(monkeypatch, NOTIFY_NTFY_TOPIC="topic")
        post = AsyncMock(return_value=MagicMock(status_code=200))
        with patch("httpx.AsyncClient.post", post):
            res = await n.send_notification("🚢 acme-project ship shipped", "Body", "https://x")
        assert res == {"channel": "ntfy", "ok": True}
        kwargs = post.call_args.kwargs
        assert kwargs["json"]["title"] == "🚢 acme-project ship shipped"
        assert "Title" not in kwargs.get("headers", {})

    async def test_send_notification_never_raises_on_channel_bug(self, monkeypatch):
        """The always-notify choke-point must swallow ANY channel error, not just
        httpx errors — an escalation must never be bricked by a delivery bug."""
        n = _reload_notify(monkeypatch, NOTIFY_NTFY_TOPIC="topic")
        with patch("httpx.AsyncClient.post", AsyncMock(side_effect=UnicodeEncodeError("ascii", "x", 0, 1, "boom"))):
            res = await n.send_notification("🚢 title", "Body")
        assert res == {"channel": "ntfy", "ok": False}


class TestNotifyEndpoint:
    """POST /internal/notify — auth gate + delivery, via the app."""

    @staticmethod
    def _client():
        from fastapi.testclient import TestClient
        from api.main import app
        return TestClient(app)

    def test_rejects_no_token(self):
        with self._client() as client:
            resp = client.post("/internal/notify", json={"title": "t", "body": "b"})
        assert resp.status_code == 401

    def test_rejects_bad_token(self):
        with self._client() as client:
            resp = client.post(
                "/internal/notify", json={"title": "t", "body": "b"},
                headers={"Authorization": "Bearer wrong"},
            )
        assert resp.status_code == 401

    def test_master_token_accepted(self, monkeypatch):
        # conftest pins SHELLTEAM_AI_TOKEN=test-internal-ai-secret (the master).
        from unittest.mock import patch, AsyncMock
        with patch("api.routers.internal.send_notification",
                   AsyncMock(return_value={"channel": "none", "ok": False})) as m:
            with self._client() as client:
                resp = client.post(
                    "/internal/notify", json={"title": "t", "body": "b"},
                    headers={"Authorization": "Bearer test-internal-ai-secret"},
                )
        assert resp.status_code == 200
        m.assert_awaited_once()

    def test_scoped_notify_token_accepted(self):
        from unittest.mock import patch, AsyncMock
        from api.services.internal_auth import notify_token
        with patch("api.routers.internal.send_notification",
                   AsyncMock(return_value={"channel": "ntfy", "ok": True})):
            with self._client() as client:
                resp = client.post(
                    "/internal/notify", json={"title": "t", "body": "b"},
                    headers={"Authorization": f"Bearer {notify_token()}"},
                )
        assert resp.status_code == 200
        assert resp.json() == {"channel": "ntfy", "ok": True}

    def test_empty_body_rejected(self):
        from api.services.internal_auth import notify_token
        with self._client() as client:
            resp = client.post(
                "/internal/notify", json={"title": "", "body": ""},
                headers={"Authorization": f"Bearer {notify_token()}"},
            )
        assert resp.status_code == 422

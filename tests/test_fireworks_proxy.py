"""Tests for the Fireworks proxy at /internal/ai/fireworks/v1/*.

Security guarantees under test:
  - HMAC bearer auth required (reused _verify_token)
  - Model allowlist enforced
  - FIREWORKS_API_KEY never leaks to response / is swapped server-side
  - Usage attributed to the calling user
"""

import json
import os


from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient

from api.main import app
from api.routers.ai_tools import FIREWORKS_STREAM_TIMEOUT
from api.services.internal_auth import make_token


USER_ID = "fw-user-123"
ALLOWED_MODEL = "accounts/fireworks/models/kimi-k2p6"
CHAT_PATH = "/internal/ai/fireworks/v1/chat/completions"
MODELS_PATH = "/internal/ai/fireworks/v1/models"


def _auth_headers(user_id: str = USER_ID) -> dict:
    return {
        "Authorization": f"Bearer {make_token(user_id)}",
        "X-Shellteam-User-Id": user_id,
    }


class TestFireworksAuth:
    def test_missing_token_returns_401(self):
        with TestClient(app) as c:
            resp = c.post(CHAT_PATH, json={"model": ALLOWED_MODEL, "messages": []})
        assert resp.status_code == 401

    def test_wrong_user_id_returns_401(self):
        token = make_token("alice")
        with TestClient(app) as c:
            resp = c.post(
                CHAT_PATH,
                json={"model": ALLOWED_MODEL, "messages": []},
                headers={"Authorization": f"Bearer {token}", "X-Shellteam-User-Id": "bob"},
            )
        assert resp.status_code == 401

    def test_models_endpoint_requires_auth(self):
        with TestClient(app) as c:
            resp = c.get(MODELS_PATH)
        assert resp.status_code == 401

    def test_valid_token_passes_auth(self):
        """Explicit happy-path auth check — a correct HMAC bearer + matching user_id
        reaches the handler (200 on /models endpoint which doesn't need upstream)."""
        with TestClient(app) as c:
            resp = c.get(MODELS_PATH, headers=_auth_headers())
        assert resp.status_code == 200


class TestFireworksAllowlist:
    def test_disallowed_model_returns_400(self):
        with patch.dict(os.environ, {"FIREWORKS_API_KEY": "fake-key"}):
            with TestClient(app) as c:
                resp = c.post(
                    CHAT_PATH,
                    json={"model": "accounts/fireworks/models/some-other", "messages": []},
                    headers=_auth_headers(),
                )
        assert resp.status_code == 400
        assert "not allowed" in resp.json()["detail"].lower()

    def test_models_endpoint_returns_allowlist(self):
        """The endpoint returns exactly the catalog-derived allowlist (config/models.json)."""
        from api.services.model_catalog import fireworks_allowlist
        with TestClient(app) as c:
            resp = c.get(MODELS_PATH, headers=_auth_headers())
        assert resp.status_code == 200
        data = resp.json()
        ids = {m["id"] for m in data["data"]}
        assert ALLOWED_MODEL in ids
        assert ids == fireworks_allowlist()
        # GLM 5.2 (the OpenCode default) must be forwardable.
        assert "accounts/fireworks/models/glm-5p2" in ids


class TestFireworksProxy:
    def test_stream_timeout_is_bounded(self):
        assert FIREWORKS_STREAM_TIMEOUT.connect == 10.0
        assert FIREWORKS_STREAM_TIMEOUT.read == 300.0
        assert FIREWORKS_STREAM_TIMEOUT.write == 30.0
        assert FIREWORKS_STREAM_TIMEOUT.pool == 10.0

    def test_non_stream_swaps_key_and_logs_usage(self, caplog):
        """Happy path: upstream key injected, usage logged with user_id."""
        upstream_response = MagicMock()
        upstream_response.status_code = 200
        upstream_response.json.return_value = {
            "id": "cmpl-1",
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        upstream_response.headers = {"content-type": "application/json"}
        upstream_response.content = b'{"ok":true}'

        captured_headers = {}
        captured_body = {}

        async def fake_post(self, url, json=None, headers=None):  # noqa: A002
            captured_headers.update(headers or {})
            captured_body.update(json or {})
            return upstream_response

        with (
            patch.dict(os.environ, {"FIREWORKS_API_KEY": "secret-host-key"}),
            patch("httpx.AsyncClient.post", fake_post),
            caplog.at_level("INFO", logger="api.routers.ai_tools"),
        ):
            with TestClient(app) as c:
                resp = c.post(
                    CHAT_PATH,
                    json={"model": ALLOWED_MODEL, "messages": [{"role": "user", "content": "hi"}]},
                    headers=_auth_headers(),
                )

        assert resp.status_code == 200
        # Key swap — our real key goes upstream, client auth isn't forwarded
        assert captured_headers.get("Authorization") == "Bearer secret-host-key"
        # Request body preserved
        assert captured_body["model"] == ALLOWED_MODEL
        # Usage log attributes tokens to the caller
        log_line = next(
            (r.getMessage() for r in caplog.records if "fireworks user_id=" in r.getMessage()),
            "",
        )
        assert USER_ID in log_line
        assert "prompt_tokens=10" in log_line
        assert "completion_tokens=5" in log_line

    def test_stream_mode_forces_include_usage(self):
        """Streaming requests get stream_options.include_usage auto-set so accounting works."""
        captured_body = {}

        class FakeStreamCtx:
            status_code = 200
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
            async def aiter_lines(self):
                yield 'data: {"choices":[{"delta":{"content":"hi"}}]}'
                yield 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}'
                yield "data: [DONE]"
            async def aread(self):
                return b""

        def fake_stream(self, method, url, json=None, headers=None):
            captured_body.update(json or {})
            return FakeStreamCtx()

        with (
            patch.dict(os.environ, {"FIREWORKS_API_KEY": "secret-host-key"}),
            patch("httpx.AsyncClient.stream", fake_stream),
            patch("httpx.AsyncClient.aclose", AsyncMock()),
        ):
            with TestClient(app) as c:
                resp = c.post(
                    CHAT_PATH,
                    json={"model": ALLOWED_MODEL, "messages": [], "stream": True},
                    headers=_auth_headers(),
                )
                # Consume the stream body so relay() runs to completion
                body = resp.content

        assert resp.status_code == 200
        assert captured_body.get("stream_options", {}).get("include_usage") is True
        assert b"hi" in body
        assert b"[DONE]" in body

    def test_stream_client_has_bounded_timeout(self):
        """The streaming client must never be unbounded (timeout=None): a stalled
        upstream would hold sockets/tasks forever. Spy on AsyncClient construction
        during a streaming request and assert the explicit stream budget is used."""
        import httpx
        from api.routers import ai_tools

        captured_timeouts = []
        real_init = httpx.AsyncClient.__init__

        def spy_init(self, *args, **kwargs):
            captured_timeouts.append(kwargs.get("timeout"))
            return real_init(self, *args, **kwargs)

        class FakeStreamCtx:
            status_code = 200
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
            async def aiter_lines(self):
                yield "data: [DONE]"
            async def aread(self):
                return b""

        with (
            patch.dict(os.environ, {"FIREWORKS_API_KEY": "secret-host-key"}),
            patch("httpx.AsyncClient.__init__", spy_init),
            patch("httpx.AsyncClient.stream", lambda *a, **kw: FakeStreamCtx()),
            patch("httpx.AsyncClient.aclose", AsyncMock()),
        ):
            with TestClient(app) as c:
                resp = c.post(
                    CHAT_PATH,
                    json={"model": ALLOWED_MODEL, "messages": [], "stream": True},
                    headers=_auth_headers(),
                )
                resp.content  # consume so relay() runs

        assert resp.status_code == 200
        assert ai_tools.FIREWORKS_STREAM_TIMEOUT in captured_timeouts
        assert None not in captured_timeouts

    def test_timeout_budgets_are_explicit(self):
        """Pin the deliberate budgets: read=300 is the streaming inter-chunk gap
        (5 min of silence = dead upstream); the non-streaming read stays at 120."""
        import httpx
        from api.routers import ai_tools

        assert ai_tools.FIREWORKS_STREAM_TIMEOUT == httpx.Timeout(
            connect=10, read=300, write=30, pool=10
        )
        assert ai_tools.FIREWORKS_TIMEOUT == httpx.Timeout(
            connect=10, read=120, write=30, pool=10
        )

    def test_missing_key_returns_503(self):
        with (
            patch.dict(os.environ, {"FIREWORKS_API_KEY": ""}),
            TestClient(app) as c,
        ):
            resp = c.post(
                CHAT_PATH,
                json={"model": ALLOWED_MODEL, "messages": []},
                headers=_auth_headers(),
            )
        assert resp.status_code == 503
        assert "FIREWORKS_API_KEY" in resp.json()["detail"]

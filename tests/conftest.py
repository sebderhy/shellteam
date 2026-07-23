"""Shared fixtures for ShellTeam tests."""

import os
import tempfile

# Set env vars BEFORE importing any app modules. DATA_DIR is pinned here so
# every app module sees the same value regardless of import order — without
# it, `api.main.load_dotenv()` runs partway through import resolution and
# modules imported before vs after end up with different DATA_DIR values.
# It points at a throwaway temp dir so the suite is hermetic and never needs
# a writable /data/users on the host (e.g. a fresh contributor checkout).
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="shellteam-test-data-")

# Pin EVERY env var that app modules read at import time — hard-set (never
# setdefault) so an ambient exported `.env` (any dev/prod shell) can't leak in.
# Before this, running the suite in a shell with `.env` exported produced ~77
# spurious failures ("the 73 reds"): the real OWNER_TOKEN beat fake-jwt-token,
# FILE_PORT=8081 broke `_is_public_path`, OWNER_USERNAME=seb broke assertions.
os.environ["APP_DOMAIN"] = "localhost"
os.environ["VPS_IP"] = ""
os.environ["FILE_PORT"] = "80"
os.environ["API_PORT"] = "8000"
os.environ["AI_CHAT_PORT"] = "3456"
os.environ["RUNTIME"] = "native"  # the OSS default; docker-backend tests import containers directly
os.environ["MODULES"] = ""  # pure core — tests opt into modules explicitly (purity gate)

# Single-user (OSS) owner identity. Pinning OWNER_TOKEN here means the suite
# exercises the real token gate (auth ON), and pinning the id/email/username to
# the legacy fake values keeps existing endpoint assertions valid.
os.environ["OWNER_ID"] = "user-uuid-1234"
os.environ["OWNER_EMAIL"] = "test@example.com"
os.environ["OWNER_USERNAME"] = "alice"
os.environ["OWNER_TOKEN"] = "fake-jwt-token"

# The /internal/* HMAC secret (internal_auth._SECRET, read at import). Pin it so
# the ~20 tests hitting /internal/ai, /internal/ports, /internal/refresh, and the
# MA/fireworks proxies exercise the real HMAC gate WITHOUT depending on a real
# .env being present — the same hermeticity rule as the vars above. Without this
# the suite is green only in a shell where `.env` is exported/loaded (dev boxes),
# and red in clean CI. `make_token`/`verify` in api.services.internal_auth both
# derive from this value, so a fixed test secret keeps them mutually consistent.
os.environ["SHELLTEAM_AI_TOKEN"] = "test-internal-ai-secret"

# Hard-set to "" (present-but-falsy, so load_dotenv can't refill it — see the
# notify-vars note below): with an ambient/`.env` COMPOSIO_API_KEY the
# integrations tests would pass the module-availability gate and any unmocked
# code path would hit the REAL Composio backend with the owner's real key.
# Tests that exercise the configured path set their own fake key.
os.environ["COMPOSIO_API_KEY"] = ""

# Scrub the owner-notification channel so the suite can NEVER reach a real
# Telegram/ntfy endpoint. `notify.send_notification` reads these straight from
# os.environ, and `dreaming.run_dream(preview=False)` calls it unconditionally —
# so on a box where `.env` is exported (every dev/prod shell), the dream-notify
# tests fired REAL messages to the owner's phone (5 spurious "Dream report"
# pings, 2026-07-13). Popping the vars makes `notify_channel()` == "none": sends
# log a warning and drop, never touching the network. test_notify.py manages
# these itself via monkeypatch, so scrubbing here is compatible.
#
# Hard-SET to "" (not pop): `api.main.load_dotenv()` runs mid-import and, with
# override=False, refills any key that is *absent* from os.environ straight from
# `.env` — so popping would be silently undone. An empty string is "present"
# (load_dotenv leaves it) yet falsy, so `notify_channel()` reads it as "none".
for _k in ("NOTIFY_TELEGRAM_BOT_TOKEN", "NOTIFY_TELEGRAM_CHAT_ID", "NOTIFY_NTFY_TOPIC"):
    os.environ[_k] = ""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient

# Modules that import verify_token (single-user owner-token verifier) or
# get_user_profile. get_current_user no longer calls verify_token, so it is not
# patched there anymore.
_VERIFY_TOKEN_PATHS = [
    "api.services.auth.verify_token",
    "api.routers.proxy.verify_token",
    "api.routers.terminal.verify_token",
]
_GET_PROFILE_PATHS = [
    "api.services.auth.get_user_profile",
    "api.dependencies.get_user_profile",
    "api.routers.auth.get_user_profile",
]


@pytest.fixture
def fake_jwt_payload():
    """A realistic legacy JWT payload."""
    return {
        "sub": "user-uuid-1234",
        "email": "test@example.com",
        "aud": "authenticated",
        "role": "authenticated",
        "iss": "https://fake.example.com/auth/v1",
    }


@pytest.fixture
def fake_profile():
    """A user profile as returned from the legacy user store. Must include `tier` so the
    tier gate in `get_current_user` lets the fake user through.
    """
    return {
        "id": "user-uuid-1234",
        "username": "alice",
        "tier": "plus",
        "created_at": "2026-01-01T00:00:00Z",
    }


@pytest.fixture
def auth_header():
    """Authorization header with a fake token."""
    return {"Authorization": "Bearer fake-jwt-token"}


@pytest.fixture
def mock_verify_token(fake_jwt_payload):
    """Mock verify_token everywhere it's imported."""
    mock = MagicMock(return_value=fake_jwt_payload)
    patches = [patch(p, mock) for p in _VERIFY_TOKEN_PATHS]
    for p in patches:
        p.start()
    yield mock
    for p in patches:
        p.stop()


@pytest.fixture
def mock_get_user_profile(fake_profile):
    """Mock get_user_profile everywhere it's imported."""
    mock = AsyncMock(return_value=fake_profile)
    patches = [patch(p, mock) for p in _GET_PROFILE_PATHS]
    for p in patches:
        p.start()
    yield mock
    for p in patches:
        p.stop()


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    """Reset all rate limiter buckets between tests to prevent leakage."""
    yield
    from api.routers.auth import _username_limit
    from api.routers.computers import _start_limit
    from api.routers.ai_tools import _ai_limit, _fireworks_limit
    from api.main import _global_limit
    from api.services.ratelimit import auth_failure_limiter

    for rl in (_username_limit, _start_limit, _ai_limit, _fireworks_limit, _global_limit, auth_failure_limiter):
        rl.reset()


@pytest.fixture
def app():
    """Create the FastAPI app for testing."""
    from api.main import app

    return app


@pytest.fixture
def client(app, mock_verify_token, mock_get_user_profile):
    """TestClient with auth mocked out.

    base_url is set to the app domain so middleware gated on `is_main_host()`
    (CSP headers, etc.) applies during tests — TestClient's default
    `testserver` host otherwise bypasses that gate.
    """
    with TestClient(app, base_url="http://localhost") as c:
        yield c

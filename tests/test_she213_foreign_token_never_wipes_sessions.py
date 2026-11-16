"""SHE-213: a process holding a different OWNER_TOKEN (an in-box script, an
agent's shell with no token) must never revoke the owner's sessions.

On 2026-11-16 an agent ran a read-only ``list_sessions()`` from a shell without
OWNER_TOKEN. The store's epoch didn't match that process's (empty) token, so it
rewrote the store empty, signing the owner out of every device, and sent a
false "master token changed" alert. A rotation is now applied only by the API
at startup (``reconcile_rotation``), which holds the token from .env.
"""

import pytest

from api.services import auth, sessions
from api.services import security_watch as sw
from tests._owner_session import reset_sessions_store


@pytest.fixture
def alerts(monkeypatch):
    sent = []
    monkeypatch.setattr(sw, "_alert", lambda title, body: sent.append(title))
    reset_sessions_store()
    yield sent
    reset_sessions_store()  # a test may leave the store under another token


def _as_foreign_process(monkeypatch, token):
    """What a stray script sees: same store file, another token, cold cache."""
    monkeypatch.setattr(auth, "OWNER_TOKEN", token)
    sessions._cache.update(mtime=None, data=None)


@pytest.mark.parametrize("foreign_token", ["", "a-stale-token-from-an-old-shell"])
def test_reading_with_another_token_leaves_the_store_untouched(alerts, monkeypatch, foreign_token):
    real = auth.OWNER_TOKEN
    minted = sessions.mint("login", ip="203.0.113.7")
    alerts.clear()
    before = sessions.store_path().read_bytes()

    _as_foreign_process(monkeypatch, foreign_token)
    assert sessions.list_sessions() == []  # not this process's sessions to see
    assert sessions.lookup(minted.token) is None
    assert sessions.lookup_id(minted.id) is None

    assert sessions.store_path().read_bytes() == before
    assert alerts == []
    _as_foreign_process(monkeypatch, real)
    assert sessions.lookup(minted.token) is not None


def test_a_foreign_process_cannot_write_over_the_store(alerts, monkeypatch):
    sessions.mint("login")
    before = sessions.store_path().read_bytes()
    _as_foreign_process(monkeypatch, "a-stale-token-from-an-old-shell")
    with pytest.raises(RuntimeError, match="different OWNER_TOKEN"):
        sessions.mint("login")
    with pytest.raises(RuntimeError, match="different OWNER_TOKEN"):
        sessions.revoke_all()
    assert sessions.store_path().read_bytes() == before


def test_a_real_rotation_is_applied_once_at_api_startup(alerts, monkeypatch):
    minted = sessions.mint("login")
    alerts.clear()
    _as_foreign_process(monkeypatch, "the-new-rotated-owner-token")
    assert sessions.reconcile_rotation() == 1
    assert alerts == ["ShellTeam: master token changed"]
    assert sessions.lookup(minted.token) is None
    assert sessions.reconcile_rotation() == 0  # once
    assert alerts == ["ShellTeam: master token changed"]
    assert sessions.mint("login").token  # the new token can sign in again


def test_startup_reconciles_a_rotation():
    import inspect

    from api import main

    assert "sessions.reconcile_rotation()" in inspect.getsource(main.lifespan)

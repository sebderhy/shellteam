"""SHE-147: the master token stays out of logs and agent environments, and a
stolen session can't turn itself into a longer-lived one by enrolling."""

import logging
import os

import pytest
from fastapi.testclient import TestClient

from api.main import _RedactSecretQueries, app
from api.services import auth, sessions

MASTER = "fake-jwt-token"
LOCAL = {"host": "localhost"}


@pytest.fixture(autouse=True)
def _fresh_store():
    sessions.revoke_all()
    yield
    sessions.revoke_all()


def _enroll_from(token: str) -> dict:
    """Mint a link from the session `token`, redeem it, return the new session."""
    with TestClient(app) as c:
        c.cookies.set(auth.MASTER_COOKIE, token)
        r = c.post("/api/auth/enroll", headers=LOCAL)
        assert r.status_code == 200, r.text
        code = r.json()["url"].split("code=")[1]
    with TestClient(app) as phone:
        r = phone.post("/enroll", data={"code": code}, headers=LOCAL, follow_redirects=False)
        assert r.status_code == 303, r.text
        return sessions.lookup(phone.cookies.get(auth.MASTER_COOKIE))


def test_an_enrolled_device_inherits_the_sessions_age_and_dies_with_it():
    stolen = sessions.mint("migrated")
    child = _enroll_from(stolen.token)
    assert child["expires"] <= stolen.expires    # no lifetime extension
    sessions.revoke(stolen.id)
    assert sessions.lookup_id(child["id"]) is None  # revoking the stolen one ends it


def test_access_log_never_prints_a_token_query():
    rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                            ("203.0.113.7", "GET", "/?token=SECRETMASTER&x=1", "1.1", 303), None)
    _RedactSecretQueries().filter(rec)
    line = rec.getMessage()
    assert "SECRETMASTER" not in line and "token=[redacted]&x=1" in line


def test_agents_never_inherit_the_master(monkeypatch):
    from api.config import child_env
    from api.services import secrets_vault

    monkeypatch.setenv("OWNER_TOKEN", "MASTER_VALUE_123456")
    assert "OWNER_TOKEN" not in child_env()
    assert "OWNER_TOKEN" not in secrets_vault.command_env([], {"secrets": {}, "uses": []})
    assert os.environ["OWNER_TOKEN"] == "MASTER_VALUE_123456"  # the API keeps it


def test_access_log_redacts_any_credential_named_parameter():
    """SHE-152: `gsig=` printed in full because the pattern needed a word boundary."""
    rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                            ("203.0.113.7", "GET", "/guest?guest=a&gsig=SIG1&exp=9&api_key=K2&access_token=T3",
                             "1.1", 401), None)
    _RedactSecretQueries().filter(rec)
    line = rec.getMessage()
    assert not any(s in line for s in ("SIG1", "K2", "T3")), line
    assert "guest=a&gsig=[redacted]&exp=9" in line

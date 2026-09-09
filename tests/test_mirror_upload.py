"""Tests for the Environment Mirror box side (api/routers/mirror.py).

The upload endpoint is the wizard's TLS target: it must accept exactly two
credentials (the master token and a live purpose-bound mirror credential),
bound-check the body, and only ever store a gzip tarball with owner-only
permissions.
"""

import gzip
import re
import time

import pytest

from api.routers import mirror
from api.services.auth import mirror_upload_cred, sign_mirror_upload

GZIP_BODY = gzip.compress(b"not a real tarball but a real gzip stream")


def _cred_from_command(command: str) -> str:
    """Pull the minted credential out of the copy-paste command."""
    return re.search(r"mirror-v1\.\d+\.[0-9a-f]+", command).group(0)


@pytest.fixture
def inbox(tmp_path, monkeypatch):
    box = tmp_path / "mirror-inbox"
    monkeypatch.setattr(mirror, "INBOX", box)
    return box


@pytest.fixture
def no_kickoff(monkeypatch):
    """Isolate tests from the cockpit: record kickoff calls instead of HTTP."""
    calls = []

    async def fake_kickoff(path: str) -> bool:
        calls.append(path)
        return True

    monkeypatch.setattr(mirror, "_kickoff_migration", fake_kickoff)
    return calls


class TestUploadAuth:
    def test_rejects_missing_credential(self, client, inbox, no_kickoff):
        resp = client.post("/api/mirror/upload", content=GZIP_BODY)
        assert resp.status_code == 401
        assert not inbox.exists()

    def test_rejects_garbage_bearer(self, client, inbox, no_kickoff):
        resp = client.post("/api/mirror/upload", content=GZIP_BODY,
                           headers={"Authorization": "Bearer nope"})
        assert resp.status_code == 401

    def test_accepts_master_token(self, client, auth_header, inbox, no_kickoff):
        resp = client.post("/api/mirror/upload", content=GZIP_BODY, headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["migration_started"] is True

    def test_accepts_live_mirror_cred(self, client, inbox, no_kickoff):
        cred = mirror_upload_cred(int(time.time()) + 3600)
        resp = client.post("/api/mirror/upload", content=GZIP_BODY,
                           headers={"Authorization": f"Bearer {cred}"})
        assert resp.status_code == 200

    def test_rejects_expired_mirror_cred(self, client, inbox, no_kickoff):
        cred = mirror_upload_cred(int(time.time()) - 10)
        resp = client.post("/api/mirror/upload", content=GZIP_BODY,
                           headers={"Authorization": f"Bearer {cred}"})
        assert resp.status_code == 401

    def test_rejects_tampered_expiry(self, client, inbox, no_kickoff):
        # Signature for one expiry must not validate another (no forgeable TTL).
        exp = int(time.time()) + 3600
        cred = f"mirror-v1.{exp + 9999}.{sign_mirror_upload(exp)}"
        resp = client.post("/api/mirror/upload", content=GZIP_BODY,
                           headers={"Authorization": f"Bearer {cred}"})
        assert resp.status_code == 401


class TestUploadBody:
    def test_stores_tarball_owner_only(self, client, auth_header, inbox, no_kickoff):
        resp = client.post("/api/mirror/upload", content=GZIP_BODY, headers=auth_header)
        assert resp.status_code == 200
        files = list(inbox.glob("shellteam-mirror-*.tar.gz"))
        assert len(files) == 1
        assert files[0].read_bytes() == GZIP_BODY
        assert oct(files[0].stat().st_mode & 0o777) == "0o600"
        assert no_kickoff == [str(files[0])]

    def test_rejects_non_gzip_body(self, client, auth_header, inbox, no_kickoff):
        resp = client.post("/api/mirror/upload", content=b"plain text", headers=auth_header)
        assert resp.status_code == 400
        assert not list(inbox.glob("*")), "a refused body must not linger on disk"

    def test_rejects_empty_body(self, client, auth_header, inbox, no_kickoff):
        resp = client.post("/api/mirror/upload", content=b"", headers=auth_header)
        assert resp.status_code == 400

    def test_enforces_size_cap(self, client, auth_header, inbox, no_kickoff, monkeypatch):
        monkeypatch.setattr(mirror, "MAX_UPLOAD_MB", 0)
        resp = client.post("/api/mirror/upload", content=GZIP_BODY, headers=auth_header)
        assert resp.status_code == 413
        assert not list(inbox.glob("*"))

    def test_kickoff_failure_still_stores_upload(self, client, auth_header, inbox, monkeypatch):
        async def failing_kickoff(path: str) -> bool:
            return False

        monkeypatch.setattr(mirror, "_kickoff_migration", failing_kickoff)
        resp = client.post("/api/mirror/upload", content=GZIP_BODY, headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["migration_started"] is False
        assert len(list(inbox.glob("*.tar.gz"))) == 1


class TestImportCommand:
    def test_requires_owner(self, client):
        resp = client.get("/api/mirror/command")
        assert resp.status_code == 401

    def test_mints_command_with_live_cred(self, client, auth_header):
        resp = client.get("/api/mirror/command", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert "mirror-import.sh" in data["command"]
        assert "mirror-v1." in data["command"]
        # The wizard must be fetched from THIS box (version-exact, no third
        # party in the path of code that reads the laptop) — never GitHub.
        assert "/api/mirror/mirror-import.sh" in data["command"]
        assert "githubusercontent" not in data["command"]
        # The baked credential must actually be accepted by the upload endpoint.
        cred = _cred_from_command(data["command"])
        from api.services.auth import verify_mirror_cred
        assert verify_mirror_cred(cred)

    def test_credential_rides_in_the_environment_not_argv(self, client, auth_header):
        """argv is world-readable in /proc/<pid>/cmdline, so a positional
        credential is legible to every other user on a shared laptop for the
        whole run. It must be an environment assignment instead."""
        command = client.get("/api/mirror/command", headers=auth_header).json()["command"]
        cred = _cred_from_command(command)
        assert command.startswith(f'SHELLTEAM_MIRROR_CRED="{cred}"')
        # …and must not ALSO appear as a positional argument after the script.
        after_script = command.split(")", 1)[1]
        assert cred not in after_script

    def test_refuses_untrusted_origin(self, client, auth_header):
        resp = client.get("/api/mirror/command",
                          headers={**auth_header, "Origin": "https://evil.example"})
        assert resp.status_code == 403


class TestWizardScriptServing:
    """The box serves the laptop-side scripts itself — the minted command and
    the import script's inventory fetch both point here, so what runs on the
    laptop is exactly the version this box runs."""

    def test_serves_both_scripts_verbatim_without_auth(self, client):
        for name in ("mirror-import.sh", "mirror-inventory.sh"):
            resp = client.get(f"/api/mirror/{name}")
            assert resp.status_code == 200
            on_disk = (mirror.SCRIPTS_DIR / name).read_text()
            assert resp.text == on_disk
            assert resp.text.startswith("#!/usr/bin/env bash")

    def test_serves_nothing_else(self, client):
        for name in ("self-update.sh", "..%2F.env", "mirror-import.sh.bak"):
            # 400 = starlette refuses the encoded traversal before routing.
            assert client.get(f"/api/mirror/{name}").status_code in (400, 404, 422)


class TestUploadHardening:
    """Regressions from the pre-merge security review of the import wizard."""

    def test_non_ascii_credential_is_a_clean_401_not_a_500(self, client, inbox, no_kickoff):
        """Starlette decodes header bytes as latin-1, so any byte >= 0x80 reaches
        the HMAC compare. Comparing two `str` raises TypeError there, which
        surfaced as an unhandled 500 AND skipped note_auth_failure(), so the
        brute-force backoff never counted those attempts."""
        exp = int(time.time()) + 3600
        # Raw bytes: an HTTP client is free to put any byte in a header, and the
        # ASGI server hands it over latin-1-decoded. (httpx refuses to encode a
        # non-ASCII str, so the str form cannot reach the app at all.)
        resp = client.post(
            "/api/mirror/upload",
            content=GZIP_BODY,
            headers={b"Authorization": f"Bearer mirror-v1.{exp}.\xe9".encode("latin-1")},
        )
        assert resp.status_code == 401
        assert not inbox.exists()

    def test_inbox_is_a_dot_directory(self):
        """The tarball can hold agent logins and chat history, and the file
        server serves ~/<path> to the weaker read-only files credential —
        dotfiles are the only paths it hard-denies. A non-dot inbox would put
        credentials at a guessable URL that are unreachable in their native
        ~/.claude location."""
        assert mirror.INBOX.name.startswith(".")

    def test_disconnect_mid_upload_leaves_no_partial_tarball(
        self, client, auth_header, inbox, no_kickoff
    ):
        """A client that dies mid-stream must not leave a truncated tarball of
        the user's credentials in the inbox: nothing prunes it, and it never
        reaches the gzip check that would have deleted it."""

        def dying_stream():
            yield GZIP_BODY[:8]
            raise ConnectionError("client went away")

        with pytest.raises(Exception):
            client.post("/api/mirror/upload", content=dying_stream(), headers=auth_header)
        assert not list(inbox.glob("*")), "a partial upload was left behind"

    def test_kickoff_presents_the_internal_secret_and_no_origin(self, monkeypatch):
        """The cockpit refuses /internal/mirror/kickoff without the custom
        secret header (that is what stops a webpage from starting an agent), so
        the control plane must actually send it."""
        import asyncio

        seen = {}

        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"slot": 1}

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, url, json=None, headers=None):
                seen["url"] = url
                seen["headers"] = headers or {}
                return FakeResponse()

        monkeypatch.setenv("SHELLTEAM_AI_TOKEN", "internal-secret")
        monkeypatch.setattr(mirror.httpx, "AsyncClient", lambda **kw: FakeClient())
        assert asyncio.run(mirror._kickoff_migration("/tmp/.mirror-inbox/x.tar.gz")) is True
        assert seen["headers"].get("X-Shellteam-Internal") == "internal-secret"
        assert "Origin" not in seen["headers"]

"""SHE-136 regression pack: a container on the same host took over the box.

The 2026-11-03 chain: a container on the default Docker bridge reached the
Steel agent browser's unauthenticated CDP port, read its cookie jar, found the
cockpit session cookie, and that cookie WAS the master ``OWNER_TOKEN``. With it
the attacker opened ``/api/terminal`` from the internet (a shell as an owner
with passwordless sudo).

Each link of that chain is pinned here:

  1. Steel runs on its own Docker network with inter-container traffic off,
     and every (re)creation re-applies it.
  2. The session cookie is a random, revocable, expiring session token, never
     the master. Rotating OWNER_TOKEN or "log out everywhere" kills every
     session (and the files credential derived from it).
  3. The agent-layer instructions never put the master in a browser.
  4. Opening the terminal needs a fresh login (or a re-entered token), and
     every terminal session is logged with its IP and notified to the owner.
  5. Passwordless sudo is detected and warned about, never granted silently.

conftest pins OWNER_TOKEN=fake-jwt-token, so the real gates are exercised.
"""

import json
import os
import shutil
import subprocess
import textwrap
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.services import auth, sessions

MASTER = "fake-jwt-token"
REPO = Path(__file__).resolve().parent.parent
LOCAL = {"host": "localhost"}


@pytest.fixture(autouse=True)
def _fresh_store():
    sessions.revoke_all()
    yield
    sessions.revoke_all()


def _login(client: TestClient) -> str:
    resp = client.post("/api/auth/login", json={"token": MASTER}, headers=LOCAL)
    assert resp.status_code == 200, resp.text
    return client.cookies.get(auth.MASTER_COOKIE)


# ── 2. The session cookie is a revocable session, never the master ──────────


class TestSessionCookieIsNotTheMaster:
    def test_login_cookie_is_not_owner_token(self):
        with TestClient(app, base_url="http://localhost") as c:
            cookie = _login(c)
        assert cookie and cookie != MASTER
        assert MASTER not in cookie

    def test_files_cookie_is_per_session_not_a_static_master_derivation(self):
        with TestClient(app, base_url="http://localhost") as a, TestClient(
            app, base_url="http://localhost"
        ) as b:
            _login(a)
            _login(b)
            fa, fb = a.cookies.get(auth.FILES_COOKIE), b.cookies.get(auth.FILES_COOKIE)
        assert fa and fb and fa != fb

    def test_session_cookie_authenticates_and_master_cookie_does_not(self):
        with TestClient(app, base_url="http://localhost") as c:
            _login(c)
            assert c.get("/api/auth/session", headers=LOCAL).status_code == 200
        with TestClient(app, base_url="http://localhost") as c:
            c.cookies.set(auth.MASTER_COOKIE, MASTER)
            assert c.get("/api/auth/session", headers=LOCAL).status_code == 401

    def test_master_still_works_as_bearer_for_in_box_tooling(self):
        with TestClient(app, base_url="http://localhost") as c:
            r = c.get("/api/auth/session", headers={**LOCAL, "Authorization": f"Bearer {MASTER}"})
        assert r.status_code == 200

    def test_store_keeps_only_hashes(self):
        minted = sessions.mint("login")
        raw = sessions.store_path().read_text()
        secret = minted.token.rsplit(".", 1)[-1]
        assert secret not in raw and minted.token not in raw
        assert oct(sessions.store_path().stat().st_mode & 0o777) == "0o600"

    def test_session_expires(self, monkeypatch):
        minted = sessions.mint("login")
        assert sessions.lookup(minted.token) is not None
        real = time.time
        monkeypatch.setattr(sessions.time, "time", lambda: real() + sessions.SESSION_TTL + 5)
        assert sessions.lookup(minted.token) is None
        assert sessions.lookup_files_cred(minted.files_cred) is None

    def test_logout_everywhere_revokes_sessions_and_files_creds(self):
        with TestClient(app, base_url="http://localhost") as other:
            _login(other)
            other_files = other.cookies.get(auth.FILES_COOKIE)
            with TestClient(app, base_url="http://localhost") as c:
                _login(c)
                r = c.post("/api/auth/logout-all", headers=LOCAL)
                assert r.status_code == 200 and r.json()["revoked"] >= 2
            assert other.get("/api/auth/session", headers=LOCAL).status_code == 401
        assert auth.token_grants_files_read(other_files) is False

    def test_logout_revokes_only_this_session(self):
        keep = sessions.mint("login")
        with TestClient(app, base_url="http://localhost") as c:
            _login(c)
            assert c.post("/api/auth/logout", headers=LOCAL).status_code == 200
            assert c.get("/api/auth/session", headers=LOCAL).status_code == 401
        assert sessions.lookup(keep.token) is not None

    def test_rotating_owner_token_revokes_every_session(self, monkeypatch):
        minted = sessions.mint("login")
        assert sessions.lookup(minted.token) is not None
        monkeypatch.setattr(auth, "OWNER_TOKEN", "a-brand-new-rotated-owner-token")
        assert sessions.lookup(minted.token) is None
        assert sessions.lookup_files_cred(minted.files_cred) is None

    def test_enrollment_mints_a_session_not_the_master(self):
        with TestClient(app, base_url="http://localhost") as c:
            from urllib.parse import parse_qs, urlparse

            url = c.post(
                "/api/auth/enroll", headers={**LOCAL, "Authorization": f"Bearer {MASTER}"}
            ).json()["url"]
            code = parse_qs(urlparse(url).query)["code"][0]
            r = c.post("/enroll", data={"code": code}, headers=LOCAL, follow_redirects=False)
            assert r.status_code == 303
            cookie = c.cookies.get(auth.MASTER_COOKIE)
        assert cookie and cookie != MASTER and sessions.lookup(cookie) is not None

    def test_url_token_redemption_mints_a_session(self):
        with TestClient(app, base_url="http://localhost") as c:
            r = c.get(f"/?token={MASTER}", headers=LOCAL, follow_redirects=False)
            assert r.status_code == 303
            cookie = c.cookies.get(auth.MASTER_COOKIE)
        assert cookie and cookie != MASTER and sessions.lookup(cookie) is not None

    def test_legacy_master_cookie_is_upgraded_on_dashboard_load(self):
        """A browser still holding a pre-SHE-136 master cookie is migrated to a
        session the next time it loads the dashboard, and the master is gone."""
        with TestClient(app, base_url="http://localhost") as c:
            c.cookies.set(auth.MASTER_COOKIE, MASTER)
            r = c.get("/", headers=LOCAL)
            assert r.status_code == 200
            set_cookie = " ".join(r.headers.get_list("set-cookie"))
        assert f"{auth.MASTER_COOKIE}={MASTER}" not in set_cookie
        assert f"{auth.MASTER_COOKIE}=s1." in set_cookie

    def test_no_code_path_writes_owner_token_into_a_cookie(self):
        """Every response.set_cookie in the API takes a session value, never
        OWNER_TOKEN (the exact line the attacker's cookie came from)."""
        offenders = []
        for py in (REPO / "api").rglob("*.py"):
            for n, line in enumerate(py.read_text().splitlines(), 1):
                if "set_cookie" in line and "OWNER_TOKEN" in line:
                    offenders.append(f"{py.relative_to(REPO)}:{n}")
        assert offenders == []


# ── 4. Terminal: fresh confirmation + IP log + owner notification ────────────


class _Shell:
    closed = False

    async def read(self):
        return b""

    def write(self, data):
        pass

    def resize(self, rows, cols):
        pass

    def close(self):
        self.closed = True


def _terminal_mocks():
    return (
        patch(
            "api.routers.terminal.runtime.get_status",
            new_callable=AsyncMock,
            return_value={"status": "running"},
        ),
        patch(
            "api.routers.terminal.runtime.open_shell",
            new_callable=AsyncMock,
            return_value=_Shell(),
        ),
    )


def _open_terminal(cookie: str):
    st, sh = _terminal_mocks()
    with st, sh, TestClient(app, base_url="http://localhost") as c:
        c.cookies.set(auth.MASTER_COOKIE, cookie)
        with c.websocket_connect("/api/terminal", headers=LOCAL) as ws:
            return ws.receive()


class TestTerminalFreshConfirmation:
    def test_stale_session_is_refused_with_4401(self, monkeypatch):
        minted = sessions.mint("login")
        real = time.time
        monkeypatch.setattr(
            sessions.time, "time", lambda: real() + sessions.TERMINAL_FRESH_SECONDS + 60
        )
        msg = _open_terminal(minted.token)
        assert msg["type"] == "websocket.close" and msg["code"] == 4401
        assert "confirm" in msg.get("reason", "").lower()

    def test_master_cookie_cannot_open_terminal(self):
        msg = _open_terminal(MASTER)
        assert msg["type"] == "websocket.close" and msg["code"] == 4001

    def test_migrated_session_is_not_fresh(self):
        minted = sessions.mint("migrated", fresh=False)
        msg = _open_terminal(minted.token)
        assert msg["code"] == 4401

    def test_fresh_session_opens_logs_ip_and_notifies(self, caplog):
        minted = sessions.mint("login")
        sent = AsyncMock(return_value={"channel": "ntfy", "ok": True})
        with patch("api.routers.terminal.notify.send_notification", sent), patch(
            "api.routers.terminal.notify.notify_channel", return_value="ntfy"
        ), caplog.at_level("INFO"):
            msg = _open_terminal(minted.token)
        assert msg["type"] != "websocket.close" or msg.get("code") not in (4001, 4401)
        assert any("Terminal shell opened" in r.message and "testclient" in r.message for r in caplog.records)
        assert sent.await_count == 1
        title, body = sent.await_args.args[:2]
        assert "testclient" in body and "terminal" in (title + body).lower()

    def test_confirm_reenters_token_and_makes_session_fresh(self, monkeypatch):
        with TestClient(app, base_url="http://localhost") as c:
            _login(c)
            sid = sessions.lookup(c.cookies.get(auth.MASTER_COOKIE))["id"]
            sessions._set_auth_at(sid, 0)  # long ago
            assert c.post("/api/auth/confirm", json={"token": "wrong"}, headers=LOCAL).status_code == 401
            assert sessions.is_fresh(sessions.lookup(c.cookies.get(auth.MASTER_COOKIE))) is False
            r = c.post("/api/auth/confirm", json={"token": MASTER}, headers=LOCAL)
            assert r.status_code == 200
            assert sessions.is_fresh(sessions.lookup(c.cookies.get(auth.MASTER_COOKIE))) is True

    def test_terminal_page_handles_4401_with_a_confirm_prompt(self):
        html = (REPO / "frontend" / "terminal.html").read_text()
        assert "4401" in html and "/api/auth/confirm" in html


# ── 1. Steel on its own isolated Docker network ─────────────────────────────


INSTALL = (REPO / "install.sh").read_text()


def _fn(name: str) -> str:
    """The body of one shell function from install.sh."""
    lines = INSTALL.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"{name}() {{"))
    end = next(i for i in range(start, len(lines)) if lines[i] == "}")
    return "\n".join(lines[start : end + 1])


class TestSteelNetworkIsolation:
    def test_steel_run_uses_the_dedicated_network(self):
        run = _fn("provision_browser")
        assert '--network "$STEEL_NETWORK"' in run
        assert "ensure_browser_network" in run
        assert 'STEEL_NETWORK="shellteam-browser-net"' in INSTALL
        # Publishing stays loopback-only on the host.
        assert '-p "127.0.0.1:$STEEL_PORT:3000"' in run

    def _run_ensure(self, tmp_path, inspect_out: str, inspect_rc: int):
        log = tmp_path / "docker.log"
        fake = tmp_path / "docker"
        fake.write_text(
            textwrap.dedent(
                f"""\
                #!/bin/bash
                echo "$*" >> {log}
                if [ "$1 $2" = "network inspect" ]; then
                    printf '%s' '{inspect_out}'
                    exit {inspect_rc}
                fi
                exit 0
                """
            )
        )
        fake.chmod(0o755)
        script = "\n".join(
            [
                'log() { :; }; warn() { echo "WARN $*" >&2; }',
                f'dk() {{ "{fake}" "$@"; }}',
                'STEEL_NETWORK="shellteam-browser-net"',
                _fn("ensure_browser_network"),
                "ensure_browser_network",
            ]
        )
        r = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
        return r, (log.read_text() if log.exists() else "")

    def test_creates_the_network_with_icc_disabled(self, tmp_path):
        r, calls = self._run_ensure(tmp_path, "", 1)
        assert r.returncode == 0, r.stderr
        assert "network create" in calls
        assert "com.docker.network.bridge.enable_icc=false" in calls

    def test_reuses_an_already_isolated_network(self, tmp_path):
        r, calls = self._run_ensure(tmp_path, "false", 0)
        assert r.returncode == 0, r.stderr
        assert "network create" not in calls and "network rm" not in calls

    def test_recreates_a_network_that_lost_its_isolation(self, tmp_path):
        r, calls = self._run_ensure(tmp_path, "true", 0)
        assert r.returncode == 0, r.stderr
        assert "network rm shellteam-browser-net" in calls
        assert "com.docker.network.bridge.enable_icc=false" in calls

    def test_uninstall_removes_the_network(self):
        assert "shellteam-browser-net" in (REPO / "uninstall.sh").read_text()


def _docker_ok() -> bool:
    if not shutil.which("docker") or os.environ.get("SHELLTEAM_LIVE_DOCKER_TESTS") != "1":
        return False
    r = subprocess.run(
        ["docker", "inspect", "shellteam-steel"], capture_output=True, text=True
    )
    return r.returncode == 0


@pytest.mark.skipif(not _docker_ok(), reason="live check: set SHELLTEAM_LIVE_DOCKER_TESTS=1 on a box running shellteam-steel")
def test_live_default_bridge_container_cannot_reach_steel():
    """From a throwaway container on the default bridge, Steel's CDP (9223) and
    API (3000) must not answer: on every network Steel is attached to."""
    nets = json.loads(
        subprocess.run(
            ["docker", "inspect", "-f", "{{json .NetworkSettings.Networks}}", "shellteam-steel"],
            capture_output=True, text=True, check=True,
        ).stdout
    )
    assert "bridge" not in nets, "Steel is attached to the default bridge"
    targets = [n["IPAddress"] for n in nets.values() if n.get("IPAddress")]
    probe = " ; ".join(
        f"(nc -z -w 3 {ip} {port} && echo OPEN {ip}:{port}) || true"
        for ip in targets
        for port in (9223, 3000)
    )
    out = subprocess.run(
        ["docker", "run", "--rm", "--network", "bridge", "alpine:latest", "sh", "-c", probe],
        capture_output=True, text=True, timeout=120,
    )
    assert "OPEN" not in out.stdout, out.stdout


# ── 3. The agent browser never carries the master ───────────────────────────


class TestAgentBrowserNeverGetsTheMaster:
    def test_layer_text_never_puts_the_master_in_a_browser(self, tmp_path):
        from api.services import agent_layer

        agent_layer.build_agent_layer(tmp_path, "alice", modules=frozenset({"persona", "browser"}))
        layer = agent_layer.layer_dir(tmp_path)
        texts = [p.read_text(errors="ignore") for p in layer.rglob("*") if p.is_file()]
        assert texts, "the layer rendered nothing"
        for t in texts:
            assert "OWNER_TOKEN" not in t
            assert "?token=" not in t
            assert "shellteam_token" not in t

    def test_browser_section_forbids_signing_the_agent_browser_in(self):
        persona = (REPO / "computer" / "claude-config" / "CLAUDE.md").read_text()
        section = persona.split("<!-- BEGIN:browser -->")[1].split("<!-- END:browser -->")[0]
        assert "Never sign this browser in to the dashboard" in section


# ── 5. Passwordless sudo is detected and warned about ───────────────────────


class TestPasswordlessSudoWarning:
    def test_detects_nopasswd_all(self):
        from api.services import security_checks

        out = "User seb may run the following commands on box:\n    (ALL) NOPASSWD: ALL\n"
        assert security_checks.sudo_output_is_passwordless(out) is True
        assert security_checks.sudo_output_is_passwordless("    (ALL : ALL) ALL\n") is False
        assert security_checks.sudo_output_is_passwordless("") is False

    def test_dashboard_endpoint_lists_the_warning(self):
        from api.services import security_checks

        with patch.object(security_checks, "_sudo_listing", return_value="    (ALL) NOPASSWD: ALL\n"), patch.object(
            security_checks, "_steel_networks", return_value=None
        ):
            security_checks.refresh()
            with TestClient(app, base_url="http://localhost") as c:
                r = c.get("/api/security/warnings", headers={**LOCAL, "Authorization": f"Bearer {MASTER}"})
        assert r.status_code == 200
        ids = [w["id"] for w in r.json()["warnings"]]
        assert "passwordless-sudo" in ids

    def test_owner_can_keep_passwordless_sudo_knowingly(self, monkeypatch):
        """PASSWORDLESS_SUDO_OK=1 records the owner's choice: no banner, one
        INFO line, so a box that keeps sudo on purpose isn't red forever."""
        from api.services import security_checks

        monkeypatch.setenv("PASSWORDLESS_SUDO_OK", "1")
        with patch.object(security_checks, "_sudo_listing", return_value="    (ALL) NOPASSWD: ALL\n"), patch.object(
            security_checks, "_steel_networks", return_value=None
        ):
            ids = [w["id"] for w in security_checks.refresh()]
        assert "passwordless-sudo" not in ids

    def test_steel_on_the_default_bridge_is_a_warning(self):
        from api.services import security_checks

        with patch.object(security_checks, "_sudo_listing", return_value=""), patch.object(
            security_checks, "_steel_networks", return_value=["bridge"]
        ):
            ids = [w["id"] for w in security_checks.refresh()]
        assert "steel-not-isolated" in ids

    def test_dashboard_renders_security_warnings(self):
        html = (REPO / "frontend" / "dashboard.html").read_text()
        assert "/api/security/warnings" in html

    def test_installer_never_grants_sudo_by_default_and_warns_when_present(self):
        assert "KEEP_SUDO=0" in INSTALL
        assert "warn_passwordless_sudo" in INSTALL
        body = _fn("warn_passwordless_sudo")
        assert "NOPASSWD" in body and "sudo -n -l" in body
        # Warn only: the installer never edits a pre-existing sudoers.
        import re

        assert not re.search(r"(rm |tee |> ?|sed -i)[^\n]*/etc/sudoers", body)

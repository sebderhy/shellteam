"""SHE-156: "Restart ShellTeam" in Settings, so the owner never needs the
terminal (or the owner token) just to restart the cockpit and control plane."""

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from api.services import processes

REPO = Path(__file__).resolve().parent.parent


def _done(code: int = 0, err: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=code, stdout="", stderr=err)


def test_restart_runs_outside_the_api_in_its_own_unit():
    with patch("api.services.processes.subprocess.run", return_value=_done()) as run:
        processes.restart_services()
    argv = run.call_args.args[0]
    # Its own transient unit: stopping the API kills the API's cgroup, so a
    # direct `systemctl` child died mid-call and logged a false "refused".
    assert argv[:3] == ["systemd-run", "--user", "--no-block"]
    inner = argv[argv.index("systemctl"):]
    assert inner[:3] == ["systemctl", "--user", "restart"]
    assert set(inner[3:]) == {"shellteam-ai-chat", "shellteam-api"}


def test_restart_refused_by_systemd_fails_loudly(caplog):
    with patch("api.services.processes.subprocess.run", return_value=_done(1, "Unit not found")):
        with pytest.raises(RuntimeError, match="Unit not found"):
            processes.restart_services()
    assert any("refused" in r.message for r in caplog.records)


def test_endpoint_answers_202_then_restarts(client, auth_header):
    with patch("api.routers.computers.containers.restart_services") as restart:
        resp = client.post("/api/computers/restart", headers=auth_header)
    assert resp.status_code == 202
    restart.assert_called_once()  # background task, after the response


def test_endpoint_refuses_cross_origin(client, auth_header):
    with patch("api.routers.computers.containers.restart_services") as restart:
        resp = client.post(
            "/api/computers/restart", headers={**auth_header, "Origin": "https://evil.example"}
        )
    assert resp.status_code == 403
    restart.assert_not_called()


def test_pages_offer_the_button_not_a_command_to_copy():
    js = (REPO / "frontend" / "static" / "restart.js").read_text()
    assert "/api/computers/restart" in js and ".restart-btn" in js
    for page in ("dashboard.html", "apps.html"):
        html = (REPO / "frontend" / page).read_text()
        assert "/static/restart.js" in html, page
        assert "restart-btn" in html, page
        assert "systemctl --user restart" not in html, page


# ── SHE-157: the header chip appears only when a restart is pending ──────────


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A real git checkout; returns commit(path) -> reflog time of the move."""
    import time as _time

    def git(*args):
        return subprocess.run(["git", "-C", str(tmp_path), *args], check=True,
                              capture_output=True, text=True).stdout

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")

    def commit(path: str) -> int:
        _time.sleep(1.1)  # reflog times have one-second resolution
        f = tmp_path / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(str(_time.time()))
        git("add", "-A")
        git("commit", "-qm", path)
        top = git("reflog", "show", "--date=unix", "--format=%gd", "-1", "HEAD")
        return int(top[top.index("{") + 1:top.index("}")])

    monkeypatch.setattr(processes, "REPO_DIR", tmp_path)
    return commit


def _started(at: dict):
    return lambda unit: at.get(unit)


def test_no_chip_when_services_started_after_the_last_change(repo, monkeypatch):
    t = repo("api/main.py")
    monkeypatch.setattr(processes, "_unit_started_at", _started({"shellteam-api": t, "shellteam-ai-chat": t}))
    assert processes.pending_restart() == {"needed": False, "services": [], "files": []}


def test_chip_when_code_moved_after_a_service_started(repo, monkeypatch):
    t = repo("api/main.py")
    repo("config/models.json")  # e.g. a release that adds a model
    later = repo("README.md")
    monkeypatch.setattr(processes, "_unit_started_at",
                        _started({"shellteam-ai-chat": t, "shellteam-api": later}))
    out = processes.pending_restart()
    assert out["needed"] is True
    assert out["services"] == ["shellteam-ai-chat"]
    assert out["files"] == ["config/models.json"]  # README.md does not count


def test_docs_and_tests_alone_never_ask_for_a_restart(repo, monkeypatch):
    t = repo("api/main.py")
    for path in ("docs/decisions/x.md", "tests/test_x.py", "computer/ai-chat/test/x.test.mjs",
                 "scripts/qa/x.mjs", "CHANGELOG.md",
                 # Read from disk on every request: a page reload is enough.
                 "frontend/dashboard.html", "frontend/static/restart.js", "computer/ai-chat/public/app.js"):
        repo(path)
    monkeypatch.setattr(processes, "_unit_started_at", _started({"shellteam-api": t, "shellteam-ai-chat": t}))
    assert processes.pending_restart()["needed"] is False


def test_a_service_not_under_systemd_is_skipped_loudly(repo, monkeypatch, caplog):
    t = repo("api/main.py")
    repo("api/x.py")
    monkeypatch.setattr(processes, "_unit_started_at", _started({"shellteam-api": t}))
    out = processes.pending_restart()
    assert out["services"] == ["shellteam-api"]
    assert any("shellteam-ai-chat is not running" in r.message for r in caplog.records)


def test_restart_needed_endpoint(client, auth_header):
    with patch("api.routers.computers.containers.pending_restart",
               return_value={"needed": True, "services": ["shellteam-ai-chat"], "files": ["config/models.json"]}):
        resp = client.get("/api/computers/restart-needed", headers=auth_header)
    assert resp.status_code == 200 and resp.json()["needed"] is True


def test_header_chip_is_wired_to_the_shared_restart():
    html = (REPO / "frontend" / "dashboard.html").read_text()
    assert 'id="restart-chip"' in html and "restart-btn" in html
    assert "/api/computers/restart-needed" in html


def test_a_hidden_chip_is_really_hidden():
    # SHE-167: the chip carries .fb-trigger, whose `display` beats the
    # browser's default for [hidden]. It showed all the time, restart or not.
    html = (REPO / "frontend" / "dashboard.html").read_text()
    assert ".restart-chip[hidden] { display: none; }" in html

"""Auto-update (docs/decisions/20260723-auto-update-timer.md).

Two layers:
  - the Settings endpoint that persists AUTO_UPDATE to .env (off|daily|weekly,
    garbage rejected, owner-authed);
  - the self-update script itself, exercised against a REAL git fixture
    (origin with release tags + a clone playing the installed box): happy-path
    fast-forward, dirty-tree refusal, diverged-checkout refusal, and rollback
    when the post-update install/health step fails.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "self-update.sh"


# --- Settings endpoint -------------------------------------------------------------

class TestAutoUpdateEndpoint:
    @pytest.fixture
    def env_file(self, tmp_path, monkeypatch):
        env = tmp_path / ".env"
        env.write_text("AUTO_UPDATE=off\n")
        monkeypatch.setenv("SHELLTEAM_ENV_FILE", str(env))
        monkeypatch.setenv("SHELLTEAM_STATE_DIR", str(tmp_path / "state"))
        return env

    def test_get_defaults_to_off(self, client, auth_header, env_file, monkeypatch):
        monkeypatch.delenv("AUTO_UPDATE", raising=False)
        resp = client.get("/api/settings/auto-update", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json() == {"mode": "off", "last": None}

    @pytest.mark.parametrize("mode", ["off", "daily", "weekly"])
    def test_set_valid_mode_persists_to_env_file(self, client, auth_header, env_file, mode):
        resp = client.post(
            "/api/settings/auto-update", json={"mode": mode}, headers=auth_header
        )
        assert resp.status_code == 200
        assert resp.json()["mode"] == mode
        assert f"AUTO_UPDATE={mode}" in env_file.read_text()
        assert os.environ["AUTO_UPDATE"] == mode

    def test_garbage_mode_rejected(self, client, auth_header, env_file):
        resp = client.post(
            "/api/settings/auto-update", json={"mode": "hourly"}, headers=auth_header
        )
        assert resp.status_code == 400
        assert "AUTO_UPDATE" in resp.json()["detail"]
        assert "AUTO_UPDATE=off" in env_file.read_text()  # unchanged

    def test_get_surfaces_last_script_outcome(self, client, auth_header, env_file, tmp_path):
        state_dir = tmp_path / "state"
        state_dir.mkdir()
        outcome = {"status": "ok", "detail": "updated to v9.9.9", "epoch": 1}
        (state_dir / "update-state.json").write_text(json.dumps(outcome))
        resp = client.get("/api/settings/auto-update", headers=auth_header)
        assert resp.json()["last"]["detail"] == "updated to v9.9.9"

    def test_requires_auth(self, client, env_file):
        assert client.get("/api/settings/auto-update").status_code in (401, 403)
        assert (
            client.post("/api/settings/auto-update", json={"mode": "daily"}).status_code
            in (401, 403)
        )


# --- The update script, against a real git fixture ---------------------------------

def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True, capture_output=True, text=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"},
    ).stdout.strip()


@pytest.fixture
def box(tmp_path):
    """An 'origin' repo with tags v0.1.0 + v0.2.0, and a clone at v0.1.0."""
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-q", "-b", "main")
    (origin / "VERSION").write_text("0.1.0\n")
    _git(origin, "add", "."); _git(origin, "commit", "-qm", "v0.1.0")
    _git(origin, "tag", "v0.1.0")
    clone = tmp_path / "box"
    _git(tmp_path, "clone", "-q", str(origin), str(clone))
    (origin / "VERSION").write_text("0.2.0\n")
    _git(origin, "add", "."); _git(origin, "commit", "-qm", "v0.2.0")
    _git(origin, "tag", "v0.2.0")
    return clone


def _run_update(clone: Path, tmp_path: Path, *, mode="daily", install_cmd="true"):
    env_file = tmp_path / "box.env"
    env_file.write_text(f"AUTO_UPDATE={mode}\n")
    health = tmp_path / "health"
    health.write_text("ok")
    state_dir = tmp_path / "update-state"
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True, text=True,
        env={
            **os.environ,
            "SHELLTEAM_REPO": str(clone),
            "SHELLTEAM_ENV_FILE": str(env_file),
            "SHELLTEAM_STATE_DIR": str(state_dir),
            "SHELLTEAM_UPDATE_INSTALL": install_cmd,
            "SHELLTEAM_UPDATE_HEALTH_URL": f"file://{health}",
        },
    )
    state_file = state_dir / "update-state.json"
    state = json.loads(state_file.read_text()) if state_file.is_file() else None
    return result, state


class TestSelfUpdateScript:
    def test_fast_forwards_to_latest_tag(self, box, tmp_path):
        result, state = _run_update(box, tmp_path)
        assert result.returncode == 0, result.stderr
        assert (box / "VERSION").read_text() == "0.2.0\n"
        assert _git(box, "describe", "--tags") == "v0.2.0"
        assert _git(box, "symbolic-ref", "--short", "HEAD") == "main"  # still on a branch
        assert state["status"] == "ok" and "v0.2.0" in state["detail"]

    def test_off_mode_does_nothing(self, box, tmp_path):
        result, state = _run_update(box, tmp_path, mode="off")
        assert result.returncode == 0
        assert (box / "VERSION").read_text() == "0.1.0\n"
        assert state["status"] == "off"

    def test_refuses_dirty_working_tree(self, box, tmp_path):
        (box / "local-hack.txt").write_text("uncommitted work")
        result, state = _run_update(box, tmp_path)
        assert result.returncode != 0
        assert (box / "VERSION").read_text() == "0.1.0\n"
        assert (box / "local-hack.txt").exists()  # never clobbered
        assert state["status"] == "error" and "local changes" in state["detail"]

    def test_refuses_diverged_checkout(self, box, tmp_path):
        (box / "fork.txt").write_text("local commit")
        _git(box, "add", "."); _git(box, "commit", "-qm", "local divergence")
        result, state = _run_update(box, tmp_path)
        assert result.returncode != 0
        assert (box / "fork.txt").exists()
        assert state["status"] == "error" and "ancestor" in state["detail"]

    def test_up_to_date_is_a_clean_noop(self, box, tmp_path):
        _run_update(box, tmp_path)  # brings it to v0.2.0
        result, state = _run_update(box, tmp_path)
        assert result.returncode == 0
        assert state["status"] == "ok" and "up to date" in state["detail"]

    def test_failed_install_rolls_back(self, box, tmp_path):
        prev = _git(box, "rev-parse", "HEAD")
        # install "succeeds" the second time (the rollback re-apply) via a
        # stamp file, mirroring a real bad release then good rollback.
        stamp = tmp_path / "first-run-failed"
        install = f'bash -c \'if [ ! -e "{stamp}" ]; then touch "{stamp}"; exit 1; fi\''
        result, state = _run_update(box, tmp_path, install_cmd=install)
        assert result.returncode != 0
        assert _git(box, "rev-parse", "HEAD") == prev  # back where it started
        assert (box / "VERSION").read_text() == "0.1.0\n"
        assert state["status"] == "rolled-back"

    def test_script_syntax(self):
        subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_update_units_exist_and_are_wired():
    """The timer/service templates, installer, uninstaller and footprint doc
    must all know about the update units — a partial wiring would strand unit
    files on uninstall."""
    service = (REPO_ROOT / "deploy/systemd/shellteam-update.service").read_text()
    assert "scripts/self-update.sh" in service
    timer = (REPO_ROOT / "deploy/systemd/shellteam-update.timer").read_text()
    assert "Persistent=true" in timer
    install = (REPO_ROOT / "install.sh").read_text()
    assert install.count("shellteam-update.timer") >= 2  # render + enable
    uninstall = (REPO_ROOT / "uninstall.sh").read_text()
    assert "shellteam-update.timer" in uninstall
    assert "shellteam-update" in (REPO_ROOT / "docs/FOOTPRINT.md").read_text()
    assert "AUTO_UPDATE=off" in (REPO_ROOT / ".env.example").read_text()

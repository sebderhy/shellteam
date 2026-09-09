"""install.sh re-run contracts, exercised against the REAL functions in install.sh.

Two defects found on provisioned boxes (2026-09-09):

1. `SHELLTEAM_AI_TOKEN` was only *replaced* by sed, never appended. A .env
   written by a provisioner (OWNER_TOKEN/OWNER_EMAIL only) has no such line,
   so every provisioned box ran with an empty in-box secret: agents could not
   share ports, publish reports or name apps.
2. The daily self-updater re-runs install.sh as the owner, whose sudo was
   removed after the first install (v0.1.20). `apt-get update` ran
   unconditionally and died on "sudo: a password is required", so no
   post-v0.1.20 box could ever update itself.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALL = (ROOT / "install.sh").read_text(encoding="utf-8")


def _function(name: str) -> str:
    """The real body of a top-level `name() { … }` function from install.sh."""
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", INSTALL, re.MULTILINE | re.DOTALL)
    assert match, f"{name}() not found in install.sh"
    return match.group(0)


def _run(script: str, tmp_path: Path, extra_path: Path | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if extra_path is not None:
        env["PATH"] = f"{extra_path}:{env['PATH']}"
    return subprocess.run(
        ["bash", "-c", script], capture_output=True, text=True, timeout=20, env=env, cwd=tmp_path,
        stdin=subprocess.DEVNULL,
    )


# --- SHELLTEAM_AI_TOKEN ---------------------------------------------------------


def _ensure_ai_token(env_content: str, tmp_path: Path) -> str:
    env_file = tmp_path / ".env"
    env_file.write_text(env_content, encoding="utf-8")
    script = "\n".join(
        [
            "set -euo pipefail",
            f'ENV_FILE="{env_file}"',
            "log() { :; }",
            _function("set_env"),
            _function("ensure_ai_token"),
            "ensure_ai_token",
        ]
    )
    result = _run(script, tmp_path)
    assert result.returncode == 0, result.stderr
    return env_file.read_text(encoding="utf-8")


def test_token_is_appended_when_the_line_is_absent(tmp_path: Path) -> None:
    out = _ensure_ai_token("OWNER_TOKEN=x\nOWNER_EMAIL=owner@example.com\n", tmp_path)
    assert re.search(r"^SHELLTEAM_AI_TOKEN=[0-9a-f]{64}$", out, re.MULTILINE), out
    assert out.startswith("OWNER_TOKEN=x\n")


def test_token_fills_a_blank_line(tmp_path: Path) -> None:
    out = _ensure_ai_token("SHELLTEAM_AI_TOKEN=\nOWNER_TOKEN=x\n", tmp_path)
    assert re.search(r"^SHELLTEAM_AI_TOKEN=[0-9a-f]{64}$", out, re.MULTILINE), out
    assert out.count("SHELLTEAM_AI_TOKEN=") == 1


def test_existing_token_is_kept(tmp_path: Path) -> None:
    out = _ensure_ai_token("SHELLTEAM_AI_TOKEN=keepme\n", tmp_path)
    assert out == "SHELLTEAM_AI_TOKEN=keepme\n"


# --- apt on re-run -------------------------------------------------------------


def _stub_bin(tmp_path: Path, installed: bool) -> Path:
    """Fake dpkg-query (every package installed or none), and a sudo that
    behaves like a password-less-less owner: `sudo -n` fails, anything else
    records the call and fails too."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    status = "install ok installed" if installed else "unknown ok not-installed"
    (bin_dir / "dpkg-query").write_text(f"#!/bin/sh\nprintf '%s' '{status}'\n")
    (bin_dir / "sudo").write_text(
        f"#!/bin/sh\necho \"sudo $*\" >> '{tmp_path}/calls'\nexit 1\n"
    )
    for f in bin_dir.iterdir():
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return bin_dir


def _ensure_packages(tmp_path: Path, installed: bool) -> subprocess.CompletedProcess:
    script = "\n".join(
        [
            "set -euo pipefail",
            "log() { echo \"LOG $*\"; }",
            "die() { echo \"DIE $*\" >&2; exit 7; }",
            f"apt_get() {{ echo \"apt-get $*\" >> '{tmp_path}/calls'; }}",
            "PKGS=(curl git)",
            _function("ensure_system_packages"),
            "ensure_system_packages",
        ]
    )
    return _run(script, tmp_path, extra_path=_stub_bin(tmp_path, installed))


def test_apt_is_skipped_when_every_package_is_present(tmp_path: Path) -> None:
    result = _ensure_packages(tmp_path, installed=True)
    assert result.returncode == 0, result.stderr
    assert "skipping apt" in result.stdout
    assert not (tmp_path / "calls").exists(), (tmp_path / "calls").read_text()


def test_missing_packages_without_sudo_fail_fast_with_guidance(tmp_path: Path) -> None:
    result = _ensure_packages(tmp_path, installed=False)
    assert result.returncode == 7, result.stdout + result.stderr
    assert "Missing system packages (curl git)" in result.stderr
    assert "sudo ./install.sh --create-owner" in result.stderr
    calls = (tmp_path / "calls").read_text()
    assert "apt-get" not in calls, calls


def test_update_unit_reruns_install_without_root() -> None:
    """The self-updater is the caller this protects: it runs as the owner."""
    unit = (ROOT / "deploy/systemd/shellteam-update.service").read_text()
    assert "sudo" not in unit
    updater = (ROOT / "scripts/self-update.sh").read_text()
    assert "$INSTALL_CMD </dev/null" in updater

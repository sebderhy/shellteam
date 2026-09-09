"""Regression: `sudo ./install.sh --create-owner` must never destroy an existing install.

The audited bug (public-release QA 2026-07-19, P1-01): rerunning the documented
root bootstrap against an existing owner ran `rm -rf` on the owner's live
ShellTeam checkout — deleting their .env and rotating both auth secrets. This
test extracts the real `bootstrap_owner` function from install.sh and runs it
twice as root inside a throwaway Ubuntu container: the second run must leave a
marker file and the .env of the "live install" byte-identical.

Needs Docker (skipped when unavailable). `su` is stubbed so the bootstrap does
not re-exec the full installer; everything else (adduser, sudoers, getent,
chown) runs for real as container root.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "install.sh"
IMAGE = "ubuntu:24.04"


def _docker_usable() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(
        ["docker", "info"], capture_output=True, timeout=30
    ).returncode == 0


docker_required = pytest.mark.skipif(
    not _docker_usable(), reason="Docker daemon not available"
)


def _extract_bootstrap_owner() -> str:
    """The verbatim bootstrap_owner() definition from install.sh."""
    src = INSTALL_SH.read_text()
    m = re.search(r"^bootstrap_owner\(\) \{\n.*?^\}$", src, re.M | re.S)
    assert m, "bootstrap_owner() not found in install.sh"
    return m.group(0)


HARNESS = """\
set -euo pipefail
log()  {{ printf '==> %s\\n' "$*"; }}
warn() {{ printf '!!  %s\\n' "$*" >&2; }}
die()  {{ printf 'xx  %s\\n' "$*" >&2; exit 1; }}
# Stub su: the real bootstrap ends by re-exec'ing the full installer as the
# owner — out of scope here; the copy/reuse behavior under test happens before.
mkdir -p /fakebin
printf '#!/bin/sh\\nexit 0\\n' > /fakebin/su && chmod +x /fakebin/su
export PATH="/fakebin:$PATH"
REPO=/src/shellteam
RAW_ARGS=()
{fn}
bootstrap_owner testowner
"""


@pytest.fixture(scope="module")
def container():
    name = "shellteam-test-bootstrap"
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    run = subprocess.run(
        ["docker", "run", "-d", "--name", name, IMAGE, "sleep", "600"],
        capture_output=True, text=True, timeout=300,
    )
    assert run.returncode == 0, f"container start failed: {run.stderr}"
    # A fake "source checkout" the bootstrap copies from — must carry the
    # reuse guard's checkout fingerprint (install.sh + pyproject.toml +
    # frontend/dashboard.html) plus a distinguishable tree.
    setup = (
        "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq adduser && "
        "mkdir -p /etc/sudoers.d && "
        "mkdir -p /src/shellteam/frontend && "
        "echo '#!/bin/bash' > /src/shellteam/install.sh && "
        "chmod +x /src/shellteam/install.sh && "
        "touch /src/shellteam/pyproject.toml /src/shellteam/frontend/dashboard.html && "
        "echo original-source > /src/shellteam/README.md"
    )
    assert _exec(name, setup).returncode == 0
    yield name
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _exec(name: str, script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "exec", name, "bash", "-c", script],
        capture_output=True, text=True, timeout=300,
    )


@docker_required
def test_bootstrap_rerun_preserves_existing_install(container):
    harness = HARNESS.format(fn=_extract_bootstrap_owner())

    first = _exec(container, harness)
    assert first.returncode == 0, f"first bootstrap failed:\n{first.stdout}\n{first.stderr}"
    check = _exec(container, "cat /home/testowner/shellteam/README.md")
    assert check.stdout.strip() == "original-source"

    # Simulate a live install: a generated .env (secrets) + owner work product.
    seed = (
        "echo 'OWNER_TOKEN=precious-secret' > /home/testowner/shellteam/.env && "
        "echo user-data > /home/testowner/shellteam/owner-work.txt"
    )
    assert _exec(container, seed).returncode == 0

    second = _exec(container, harness)
    assert second.returncode == 0, f"rerun failed:\n{second.stdout}\n{second.stderr}"
    assert "reusing it untouched" in second.stdout

    env = _exec(container, "cat /home/testowner/shellteam/.env")
    assert env.stdout.strip() == "OWNER_TOKEN=precious-secret", (
        "rerun of --create-owner replaced the live install's .env (P1-01 regression)"
    )
    marker = _exec(container, "cat /home/testowner/shellteam/owner-work.txt")
    assert marker.stdout.strip() == "user-data", (
        "rerun of --create-owner deleted owner files from the checkout (P1-01 regression)"
    )


@docker_required
def test_bootstrap_refuses_non_shellteam_destination(container):
    harness = HARNESS.format(fn=_extract_bootstrap_owner())
    # A destination that exists but is NOT a ShellTeam checkout must be a hard
    # stop, not an overwrite.
    setup = (
        "rm -rf /home/testowner/shellteam && "
        "mkdir -p /home/testowner/shellteam && "
        "echo unrelated > /home/testowner/shellteam/data.txt"
    )
    assert _exec(container, setup).returncode == 0
    res = _exec(container, harness)
    assert res.returncode != 0
    assert "not a recognizable ShellTeam checkout" in res.stderr
    survivor = _exec(container, "cat /home/testowner/shellteam/data.txt")
    assert survivor.stdout.strip() == "unrelated"


def _extract_dotfile_guard() -> str:
    """PROFILE_FILES + run_preserving_dotfiles() verbatim from install.sh."""
    src = INSTALL_SH.read_text()
    m = re.search(
        r"^PROFILE_FILES=\(.*?^run_preserving_dotfiles\(\) \{\n.*?^\}$",
        src, re.M | re.S,
    )
    assert m, "PROFILE_FILES / run_preserving_dotfiles() not found in install.sh"
    return m.group(0)


def test_run_preserving_dotfiles_restores_installer_edits(tmp_path):
    """Regression (P1-02): third-party installers must not leave dotfile edits.

    Runs the real guard with HOME pointed at a temp dir and a fake "installer"
    that appends to .bashrc and drops a fish conf.d file — both must be undone.
    """
    home = tmp_path / "home"
    home.mkdir()
    (home / ".bashrc").write_text("# owner bashrc\n")

    script = "\n".join([
        "set -euo pipefail",
        "warn() { printf 'WARN: %s\\n' \"$*\" >&2; }",
        _extract_dotfile_guard(),
        # Fake installer: the exact mutations the audit reproduced (uv/agy).
        "run_preserving_dotfiles 'The fake installer' bash -c '"
        "echo \"export PATH=\\$HOME/.local/bin:\\$PATH\" >> \"$HOME/.bashrc\"; "
        "mkdir -p \"$HOME/.config/fish/conf.d\"; "
        "echo tainted > \"$HOME/.config/fish/conf.d/uv.env.fish\"'",
    ])
    res = subprocess.run(
        ["bash", "-c", script], capture_output=True, text=True,
        env={"HOME": str(home), "PATH": "/usr/bin:/bin"}, timeout=60,
    )
    assert res.returncode == 0, res.stderr
    assert (home / ".bashrc").read_text() == "# owner bashrc\n", (
        "installer edit to .bashrc was not restored"
    )
    assert not (home / ".config/fish/conf.d").exists(), (
        "installer-created fish conf.d was not removed"
    )
    assert "modified" in res.stderr and "created" in res.stderr, (
        "restorations must be loud (warn), never silent"
    )

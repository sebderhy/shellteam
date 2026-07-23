"""QA-03: the uninstaller must fail closed when the user bus is unreachable.

Reproduced on a fresh box: invoking uninstall.sh from a noninteractive login
(no XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS) made every `systemctl --user`
call die with "Failed to connect to bus" — all swallowed by `|| true` — after
which the script deleted unit files and state and printed "ShellTeam removed."
while every service kept running.

These tests run the REAL uninstall.sh with a shimmed `systemctl` so the
bus-down and stop-refused scenarios are deterministic, and assert that nothing
is deleted unless the services provably stopped.
"""

import stat
import subprocess
from pathlib import Path

import pytest

UNINSTALL_SH = Path(__file__).resolve().parent.parent / "uninstall.sh"

UNIT_FILES = [
    "shellteam-api.service",
    "shellteam-ai-chat.service",
    "shellteam-nginx.service",
    "shellteam-dream.timer",
    "shellteam-dream.service",
]


def _shim(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text(f"#!/bin/bash\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@pytest.fixture()
def fake_box(tmp_path: Path) -> dict[str, Path]:
    home = tmp_path / "home"
    unit_dir = home / ".config" / "systemd" / "user"
    state = home / ".local" / "state" / "shellteam"
    unit_dir.mkdir(parents=True)
    state.mkdir(parents=True)
    (state / "nginx.conf").write_text("# state sentinel\n")
    for unit in UNIT_FILES:
        (unit_dir / unit).write_text("[Unit]\nDescription=sentinel\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    # Neutral shims for the other tools uninstall.sh touches.
    _shim(bin_dir, "sudo", "exit 0")
    _shim(bin_dir, "docker", "exit 0")
    _shim(bin_dir, "curl", "exit 7")  # nothing listening
    return {"home": home, "unit_dir": unit_dir, "state": state, "bin": bin_dir}


def _run(
    fake_box: dict[str, Path],
    systemctl_body: str,
    *args: str,
    script: Path = UNINSTALL_SH,
) -> subprocess.CompletedProcess:
    _shim(fake_box["bin"], "systemctl", systemctl_body)
    return subprocess.run(
        ["bash", str(script), *args],
        capture_output=True,
        text=True,
        env={
            "HOME": str(fake_box["home"]),
            "PATH": f"{fake_box['bin']}:/usr/bin:/bin",
            "USER": "qauser",
        },
        timeout=60,
    )


def test_no_bus_refuses_and_deletes_nothing(fake_box: dict[str, Path]) -> None:
    result = _run(
        fake_box,
        'echo "Failed to connect to bus: No medium found" >&2; exit 1',
    )
    assert result.returncode != 0, (
        "uninstall.sh claimed success with no user bus — the exact QA-03 "
        f"failure. stdout: {result.stdout}"
    )
    assert "ShellTeam removed" not in result.stdout
    for unit in UNIT_FILES:
        assert (fake_box["unit_dir"] / unit).exists(), (
            f"{unit} was deleted even though the bus was unreachable and no "
            "service could have been stopped."
        )
    assert (fake_box["state"] / "nginx.conf").exists(), (
        "Runtime state was deleted despite the services still running."
    )


def test_stop_refused_active_unit_aborts_before_deleting(
    fake_box: dict[str, Path],
) -> None:
    # Bus is up, but stopping fails and the unit stays active.
    result = _run(
        fake_box,
        'case "$*" in *show-environment*) exit 0 ;; '
        "*is-active*) echo active; exit 0 ;; "
        "*stop*) exit 1 ;; *) exit 0 ;; esac",
    )
    assert result.returncode != 0
    for unit in UNIT_FILES:
        assert (fake_box["unit_dir"] / unit).exists()
    assert (fake_box["state"] / "nginx.conf").exists()


def test_clean_stop_removes_units_and_state(fake_box: dict[str, Path]) -> None:
    result = _run(
        fake_box,
        'case "$*" in *show-environment*) exit 0 ;; '
        "*is-active*) echo inactive; exit 3 ;; "
        "*list-units*) exit 0 ;; *) exit 0 ;; esac",
    )
    assert result.returncode == 0, result.stderr
    assert "ShellTeam removed" in result.stdout
    for unit in UNIT_FILES:
        assert not (fake_box["unit_dir"] / unit).exists(), f"{unit} left behind"
    assert not fake_box["state"].exists(), "runtime state left behind"


def test_purge_survives_bus_death_after_linger_disable(
    fake_box: dict[str, Path],
) -> None:
    """Reproduced on the Hetzner rehearsal: --purge disables linger, systemd
    tears the user bus down, and the final list-units verification then failed
    under set -e — exit 1 after a fully successful removal. A dead user
    manager proves nothing is running; it must count as success."""
    result = _run(
        fake_box,
        'case "$*" in *show-environment*) exit 0 ;; '
        "*is-active*) echo inactive; exit 3 ;; "
        '*list-units*) echo "Failed to connect to bus: Connection refused" >&2; exit 1 ;; '
        "*) exit 0 ;; esac",
        "--purge",
    )
    assert result.returncode == 0, (
        f"--purge exited {result.returncode} after successful removal just "
        f"because the user bus died post-linger-disable. stderr: {result.stderr}"
    )
    assert "ShellTeam removed" in result.stdout
    assert not (fake_box["home"] / ".shellteam").exists()


def test_minimal_env_port_check_falls_back_to_defaults(
    fake_box: dict[str, Path], tmp_path: Path
) -> None:
    """A .env without API_PORT/AI_CHAT_PORT (the Cloud cloud-init shape) must
    not kill the port verification via grep-exit-1 under set -e — the install
    defaults (8000/3456) still get probed."""
    script_dir = tmp_path / "checkout"
    script_dir.mkdir()
    script = script_dir / "uninstall.sh"
    script.write_text(UNINSTALL_SH.read_text())
    (script_dir / ".env").write_text("OWNER_TOKEN=x\nOWNER_EMAIL=o@example.com\n")
    probed = tmp_path / "curl-probes"
    _shim(fake_box["bin"], "curl", f'echo "$*" >> "{probed}"; exit 7')
    result = _run(
        fake_box,
        'case "$*" in *show-environment*) exit 0 ;; '
        "*is-active*) echo inactive; exit 3 ;; "
        "*list-units*) exit 0 ;; *) exit 0 ;; esac",
        script=script,
    )
    assert result.returncode == 0, result.stderr
    assert "ShellTeam removed" in result.stdout
    probes = probed.read_text()
    assert ":8000/" in probes and ":3456/" in probes, (
        f"default ports were not probed on a minimal .env: {probes!r}"
    )


# ── Round-6 audit P1-02: nginx capability reversal ───────────────────────────
# install.sh grants /usr/sbin/nginx cap_net_bind_service (FILE_PORT < 1024) via
# a PATH-independent lookup, but the uninstaller gated its reversal on a bare
# `command -v nginx`. A normal Debian/Ubuntu user PATH has no sbin, so both
# uninstall and --purge reported success while leaving the capability behind.
# These tests run the REAL script with getcap/setcap shims; the capability's
# "state" is a marker file the setcap shim removes.


def _cap_shims(fake_box: dict[str, Path], *, setcap_removes: bool = True) -> Path:
    marker = fake_box["bin"] / "cap-granted"
    marker.write_text("granted\n")
    setcap_log = fake_box["bin"] / "setcap.log"
    # The script invokes `sudo setcap`; the fixture's sudo swallows its command,
    # so re-shim it to exec (every command sudo runs here is itself a shim).
    _shim(fake_box["bin"], "sudo", 'exec "$@"')
    _shim(
        fake_box["bin"],
        "getcap",
        f'[ -f "{marker}" ] && echo "$1 cap_net_bind_service=ep"; exit 0',
    )
    remove = f'rm -f "{marker}"; ' if setcap_removes else ""
    _shim(fake_box["bin"], "setcap", f'echo "$@" >> "{setcap_log}"; {remove}exit 0')
    return setcap_log


def test_capability_reverted_with_nginx_on_path(fake_box: dict[str, Path]) -> None:
    setcap_log = _cap_shims(fake_box)
    _shim(fake_box["bin"], "nginx", "exit 0")
    result = _run(fake_box, "exit 0")
    assert result.returncode == 0, result.stderr
    assert "Reverting nginx cap_net_bind_service" in result.stdout
    assert "-r" in setcap_log.read_text()
    assert "STILL set" not in result.stdout


@pytest.mark.skipif(
    not Path("/usr/sbin/nginx").is_file(),
    reason="needs a real /usr/sbin/nginx (the script probes that absolute path)",
)
def test_capability_reverted_when_path_lacks_sbin(fake_box: dict[str, Path]) -> None:
    """THE round-6 regression: PATH has no nginx (no sbin), yet the reversal
    must still find /usr/sbin/nginx — exactly as install.sh's grant does."""
    setcap_log = _cap_shims(fake_box)
    result = _run(fake_box, "exit 0")  # _run's PATH is <shims>:/usr/bin:/bin
    assert result.returncode == 0, result.stderr
    assert "Reverting nginx cap_net_bind_service" in result.stdout, (
        "the reversal block was skipped because nginx is not on PATH"
    )
    assert "/usr/sbin/nginx" in setcap_log.read_text()
    assert "STILL set" not in result.stdout


def test_capability_reversal_failure_warns_loudly(fake_box: dict[str, Path]) -> None:
    _cap_shims(fake_box, setcap_removes=False)
    _shim(fake_box["bin"], "nginx", "exit 0")
    result = _run(fake_box, "exit 0")
    assert result.returncode == 0, result.stderr
    assert "STILL set" in result.stdout + result.stderr, (
        "a capability that survives its removal must be reported, not ignored"
    )

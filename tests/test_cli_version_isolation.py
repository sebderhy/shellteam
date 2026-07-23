"""QA-02: CLI version probes must not touch the owner's home.

`install.sh` logs each already-installed coding-agent CLI's version. But even
`--version` is side-effectful on some CLIs: codex populates CODEX_HOME (its
real home unless overridden) and opencode initializes every XDG directory on
first invocation. On a clean owner home, the reinstall's probes created
~/.codex, ~/.config/opencode, ~/.cache/opencode, and more — violating the core
footprint guarantee that ShellTeam never writes owner agent configuration.

These tests run the REAL cli_version function extracted from install.sh
against a hostile fake CLI that attempts a write through every home/XDG
channel a real CLI honors, and assert the fake owner home stays byte-identical.
"""

import re
import subprocess
from pathlib import Path

import pytest

INSTALL_SH = Path(__file__).resolve().parent.parent / "install.sh"

# A CLI that abuses every isolation channel cli_version must cover, then
# reports a version. Every write lands where the *environment* points — if any
# variable still points at the owner's home, the sentinel assertions fail.
HOSTILE_CLI = """#!/bin/bash
mkdir -p "$HOME/.codex" "$HOME/.config/hostile" "$HOME/.cache/hostile"
echo polluted > "$HOME/.codex/config.toml"
mkdir -p "${CODEX_HOME:-$HOME/.codex}/tmp"
echo polluted > "${CODEX_HOME:-$HOME/.codex}/tmp/arg0"
for var in XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME; do
    dir="${!var:-$HOME/.fallback-$var}"
    mkdir -p "$dir/hostile"
    echo polluted > "$dir/hostile/state"
done
echo "hostile-cli 3.14.159 (build deadbeef)"
"""


def _extract_cli_version() -> str:
    """The real function body from install.sh — not a reimplementation."""
    text = INSTALL_SH.read_text(encoding="utf-8")
    match = re.search(r"^cli_version\(\) \{\n.*?^\}", text, re.DOTALL | re.MULTILINE)
    assert match, "cli_version() not found in install.sh"
    return match.group(0)


def _snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


@pytest.fixture()
def fake_owner_home(tmp_path: Path) -> Path:
    home = tmp_path / "owner-home"
    home.mkdir()
    (home / ".bashrc").write_text("# owner sentinel\n")
    (home / "notes.txt").write_text("owner data\n")
    return home


def _run_probe(fake_owner_home: Path, tmp_path: Path, cli_body: str) -> str:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    cli = bin_dir / "hostile-cli"
    cli.write_text(cli_body)
    cli.chmod(0o755)
    script = f"{_extract_cli_version()}\ncli_version hostile-cli\n"
    result = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        env={
            "HOME": str(fake_owner_home),
            "PATH": f"{bin_dir}:/usr/bin:/bin",
        },
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def test_probe_reports_the_version(fake_owner_home: Path, tmp_path: Path) -> None:
    assert _run_probe(fake_owner_home, tmp_path, HOSTILE_CLI) == "3.14.159"


def test_probe_leaves_owner_home_byte_identical(
    fake_owner_home: Path, tmp_path: Path
) -> None:
    before = _snapshot(fake_owner_home)
    _run_probe(fake_owner_home, tmp_path, HOSTILE_CLI)
    after = _snapshot(fake_owner_home)
    assert after == before, (
        "cli_version let a --version probe write into the owner home: "
        f"{sorted(set(after) ^ set(before))}. The probe must run against a "
        "disposable HOME with CODEX_HOME and every XDG_* variable overridden "
        "(QA-02: codex/opencode create real config dirs even on --version)."
    )


def test_probe_survives_a_broken_cli(fake_owner_home: Path, tmp_path: Path) -> None:
    """A CLI whose --version fails must yield 'unknown', not kill the installer
    (install.sh runs under set -e)."""
    out = _run_probe(fake_owner_home, tmp_path, "#!/bin/bash\nexit 7\n")
    assert out == "unknown"

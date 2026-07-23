"""Regression: install.sh must survive a minimal .env under `set -euo pipefail`.

The Cloud provisioning path (and any operator following INSTALL.md by hand)
writes a .env containing only OWNER_TOKEN/OWNER_EMAIL — no API_PORT. The old
`API_PORT="$(grep '^API_PORT=' …)"` read made grep exit 1 on that file, which
`set -e` turned into a silent mid-install death: no error, no services, no
Caddy. This test runs the REAL line from install.sh against both .env shapes.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _api_port_read_line() -> str:
    """The actual API_PORT assignment from install.sh, not a copy of it."""
    source = (ROOT / "install.sh").read_text(encoding="utf-8")
    match = re.search(r'^API_PORT="\$\(.*$', source, re.MULTILINE)
    assert match, "API_PORT read line not found in install.sh"
    return match.group(0)


def _read_api_port(env_content: str, tmp_path: Path) -> str:
    env_file = tmp_path / ".env"
    env_file.write_text(env_content, encoding="utf-8")
    script = "\n".join(
        [
            "set -euo pipefail",
            f'ENV_FILE="{env_file}"',
            _api_port_read_line(),
            'printf "%s" "$API_PORT"',
        ]
    )
    result = subprocess.run(
        ["bash", "-c", script], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, (
        f"install.sh API_PORT read died under set -e (exit {result.returncode}): "
        f"{result.stderr}"
    )
    return result.stdout


def test_minimal_env_without_api_port_defaults_to_8000(tmp_path: Path) -> None:
    minimal = "OWNER_TOKEN=x\nOWNER_EMAIL=owner@example.com\n"
    assert _read_api_port(minimal, tmp_path) == "8000"


def test_env_with_api_port_uses_it(tmp_path: Path) -> None:
    assert _read_api_port("API_PORT=8123\n", tmp_path) == "8123"


def test_env_with_commented_api_port_defaults(tmp_path: Path) -> None:
    assert _read_api_port("# API_PORT=9999\n", tmp_path) == "8000"


def test_api_unit_defaults_api_port_for_minimal_env() -> None:
    """The unit's ${API_PORT} expands to '' on a minimal .env (uvicorn then
    crash-loops on --port ''). An Environment= default keeps it valid, and
    EnvironmentFile= still overrides it when .env sets the port explicitly."""
    unit = (ROOT / "deploy" / "systemd" / "shellteam-api.service").read_text(
        encoding="utf-8"
    )
    assert "${API_PORT}" in unit
    default = re.search(r"^Environment=API_PORT=\d+$", unit, re.MULTILINE)
    assert default, (
        "shellteam-api.service references ${API_PORT} without an Environment= "
        "default — a .env without API_PORT crash-loops uvicorn on --port ''"
    )

"""SHE-196: an isolated copy of the API must not share the live sign-in list.

A QA copy started with its own home (SHELLTEAM_HOME) and its own token kept
the live box's DATA_DIR, so its first sign-in looked like a token change:
every real session was revoked and a false "master token changed" alert went
out. DATA_DIR now follows SHELLTEAM_HOME unless DATA_DIR is set explicitly.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PROBE = "import json; from api import config; print(json.dumps([str(config.HOME_DIR), str(config.DATA_DIR)]))"


def _config(env: dict) -> list[str]:
    clean = {k: v for k, v in os.environ.items() if k not in ("DATA_DIR", "SHELLTEAM_HOME")}
    out = subprocess.run([sys.executable, "-c", PROBE], cwd=REPO, env={**clean, **env},
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_an_isolated_home_has_its_own_state(tmp_path):
    home, data = _config({"SHELLTEAM_HOME": str(tmp_path)})
    assert home == str(tmp_path)
    assert data == str(tmp_path / ".local/state/shellteam/data")


def test_the_live_box_keeps_its_state_where_it_was():
    home, data = _config({})
    assert data == str(Path(home) / ".local/state/shellteam/data") == str(
        Path.home() / ".local/state/shellteam/data")


def test_an_explicit_data_dir_still_wins(tmp_path):
    _, data = _config({"SHELLTEAM_HOME": str(tmp_path / "h"), "DATA_DIR": str(tmp_path / "d")})
    assert data == str(tmp_path / "d")

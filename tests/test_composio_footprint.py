"""Round-6 audit P2-03: pure core must not initialize the Composio SDK.

Merely importing ``composio`` creates ``~/.composio/`` as a side effect, and
``api.services.composio`` is reached from the always-imported integrations
router — so a no-module, no-key box grew an undisclosed dotdir that ``--purge``
left behind (docs/FOOTPRINT.md calls itself a complete manifest). The SDK
import must stay behind the API-key gate.

Clean-room: a subprocess with HOME pointed at a temp dir, the same reproduction
the audit used.
"""

import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_importing_the_service_creates_no_composio_dir(tmp_path):
    env = {**os.environ, "HOME": str(tmp_path)}
    env.pop("COMPOSIO_API_KEY", None)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import api.services.composio, api.routers.integrations",
        ],
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / ".composio").exists(), (
        "importing the integration modules must leave zero footprint on a "
        "box with no Composio key"
    )

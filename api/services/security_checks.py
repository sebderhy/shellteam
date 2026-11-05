"""Box security self-checks, shown in the dashboard and logged (SHE-136).

The 2026-11-03 takeover chained two host-level conditions ShellTeam does not
control from Python but can detect and shout about:

  - passwordless sudo for the owner: any shell as the owner (an agent, a web
    terminal) is root. The installer never grants it to an existing account
    and never edits sudoers it did not write, so the only remedy here is a
    loud, persistent warning;
  - the Steel browser container attached to a network other than its own
    isolated one (e.g. recreated by hand on the default bridge), which exposes
    its unauthenticated CDP port to every other container.

Each check shells out once (``sudo -n -l``, ``docker inspect``) and the result
is cached for ``CACHE_SECONDS``; ``sudo -n`` never prompts.
"""

import json
import logging
import re
import shutil
import subprocess
import time

log = logging.getLogger(__name__)

STEEL_CONTAINER = "shellteam-steel"
STEEL_NETWORK = "shellteam-browser-net"
CACHE_SECONDS = 600
_NOPASSWD_ALL = re.compile(r"NOPASSWD:\s*ALL(?![A-Za-z])")
_cache: dict = {"at": 0.0, "warnings": None}


def sudo_output_is_passwordless(listing: str) -> bool:
    """True when a ``sudo -l`` listing grants ALL commands without a password."""
    return bool(_NOPASSWD_ALL.search(listing or ""))


def _run(argv: list[str]) -> subprocess.CompletedProcess | None:
    if not shutil.which(argv[0]):
        return None
    return subprocess.run(argv, capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)


def _sudo_listing() -> str:
    r = _run(["sudo", "-n", "-l"])
    return r.stdout if r is not None and r.returncode == 0 else ""


def _steel_networks() -> list[str] | None:
    """Networks the Steel container is attached to; None when there is no Steel
    container (browser module off, or no Docker access)."""
    r = _run(["docker", "inspect", "-f", "{{json .NetworkSettings.Networks}}", STEEL_CONTAINER])
    if r is None or r.returncode != 0:
        return None
    return sorted(json.loads(r.stdout or "{}").keys())


def _network_icc(name: str) -> str:
    r = _run(
        ["docker", "network", "inspect", "-f",
         '{{index .Options "com.docker.network.bridge.enable_icc"}}', name]
    )
    return r.stdout.strip() if r is not None and r.returncode == 0 else ""


def _compute() -> list[dict]:
    warnings: list[dict] = []
    if sudo_output_is_passwordless(_sudo_listing()):
        warnings.append({
            "id": "passwordless-sudo",
            "severity": "high",
            "message": (
                "This account has passwordless sudo, so every agent and every terminal "
                "session on this box runs as root. ShellTeam does not need it after the "
                "install: remove the NOPASSWD rule (often /etc/sudoers.d/90-cloud-init-users, "
                "edit with sudo visudo -f <file>), or keep it knowingly."
            ),
        })
    nets = _steel_networks()
    if nets is not None:
        isolated = nets == [STEEL_NETWORK] and _network_icc(STEEL_NETWORK) == "false"
        if not isolated:
            warnings.append({
                "id": "steel-not-isolated",
                "severity": "high",
                "message": (
                    f"The agent browser container ({STEEL_CONTAINER}) is attached to "
                    f"{', '.join(nets) or 'no network'} instead of its isolated network "
                    f"{STEEL_NETWORK}: other containers on this host can reach its "
                    "debugging port and read its cookies. Re-run ./install.sh to recreate it."
                ),
            })
    return warnings


def refresh() -> list[dict]:
    """Run every check now, log each finding, and cache the result."""
    found = _compute()
    for w in found:
        log.warning("Security check %s: %s", w["id"], w["message"])
    if not found:
        log.info("Security checks: no warnings")
    _cache.update(at=time.time(), warnings=found)
    return found


def current() -> list[dict]:
    """The cached findings, refreshed when older than CACHE_SECONDS."""
    if _cache["warnings"] is None or time.time() - _cache["at"] > CACHE_SECONDS:
        return refresh()
    return _cache["warnings"]

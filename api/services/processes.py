"""Native (non-Docker) runtime backend for the OSS single-user edition.

In the native edition there is no per-user container: the cockpit (ai-chat),
file server (nginx), and the coding-agent CLIs all run as host processes on
localhost, started at boot by the process supervisor (systemd). This module
therefore does NOT spawn anything per request — it materializes agent config,
reports whether the local service stack is up, and resolves every lookup to
``127.0.0.1``.

It mirrors the public surface of ``containers.py`` (the Docker/Cloud backend)
so the routers can be backend-agnostic via ``api.services.runtime``.
"""

import asyncio
import fcntl
import logging
import os
import pty
import socket
import struct
import termios
import subprocess
from pathlib import Path

from api.config import HOME_DIR, OWNER_ID, OWNER_USERNAME
from api.services.agent_config import _setup_knowledge_layer
from api.services.agent_layer import build_agent_layer, canonical_mcp_servers

log = logging.getLogger(__name__)

LOCALHOST = "127.0.0.1"
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}

# The cockpit (ai-chat) is the liveness signal for "is the computer up?".
COCKPIT_PORT = int(os.environ.get("AI_CHAT_PORT", "3456"))

# systemd units the native install manages; start/stop are best-effort.
SERVICE_UNITS = [u.strip() for u in os.environ.get(
    "SHELLTEAM_UNITS", "shellteam-ai-chat shellteam-nginx"
).split() if u.strip()]


def user_home_dir(user_id: str = "") -> Path:
    """Single owner home — user_id is ignored (no per-user partitioning)."""
    return HOME_DIR


def _ensure_data_dir(user_id: str = "") -> Path:
    HOME_DIR.mkdir(parents=True, exist_ok=True)
    return HOME_DIR


def _port_open(port: int, host: str = LOCALHOST, timeout: float = 0.5) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _stack_up() -> bool:
    return _port_open(COCKPIT_PORT)


def _systemctl(action: str) -> None:
    """Best-effort systemctl over the managed units. Never raises."""
    for unit in SERVICE_UNITS:
        try:
            subprocess.run(
                ["systemctl", "--user", action, unit],
                check=False, capture_output=True, timeout=10,
            )
        except (FileNotFoundError, subprocess.SubprocessError) as exc:
            log.warning("systemctl %s %s failed: %s", action, unit, exc)


def _materialize_config(username: str, email: str = "") -> None:
    """Refresh ShellTeam's *additive* agent layer — never the owner's dotfiles.

    The OSS box does NOT inject into the owner's coding-agent dotfiles (that was
    the Cloud behaviour that clobbered user config; see
    ``docs/design/vps-footprint.md``). Instead it builds an additive launch-layer
    under ``~/.shellteam/`` that the cockpit and managed terminal load at spawn time:

    - **Claude** — `--plugin-dir` + `--append-system-prompt-file`
    - **Codex** — `-c` overrides plus a ShellTeam-owned skills HOME overlay
    - **Antigravity** — a ShellTeam workspace plugin added with `--add-dir`
    - **OpenCode** — `OPENCODE_CONFIG` env (merges with the user's config)

    None of these write the user's `~/.claude`, `~/.codex`, `~/.gemini`, or
    `~/.config/opencode`.
    """
    home = _ensure_data_dir()
    uname = username or OWNER_USERNAME
    mcp = canonical_mcp_servers(home, OWNER_ID)
    build_agent_layer(home, uname, OWNER_ID, email, mcp_servers=mcp)
    _setup_knowledge_layer(home, uname)


async def get_status(user_id: str = "") -> dict:
    if _stack_up():
        return {
            "status": "running",
            "container_id": "native",
            "ip": LOCALHOST,
            "username": OWNER_USERNAME,
        }
    return {"status": "stopped", "container_id": None, "ip": None, "username": OWNER_USERNAME}


async def start_computer(user_id: str = "", username: str = "", email: str = "") -> dict:
    """Sync agent config and ensure the local service stack is running.

    Unlike the Docker backend this does not create anything per request — the
    services are owned by systemd. We (re)materialize config (so MCP/provider
    updates land) and nudge the units up, then report status.
    """
    _materialize_config(username or OWNER_USERNAME, email)
    if not _stack_up():
        _systemctl("start")
    up = _stack_up()
    return {
        "status": "running" if up else "starting",
        "container_id": "native",
        "ip": LOCALHOST if up else None,
    }


async def stop_computer(user_id: str = "") -> dict:
    _systemctl("stop")
    return {"status": "stopped"}


async def recreate_container(user_id: str = "", username: str = "", email: str = "") -> dict:
    _systemctl("restart")
    return await start_computer(user_id, username, email)


async def get_container_ip(user_id: str = "") -> str | None:
    return LOCALHOST if _stack_up() else None


async def resolve_username(username: str) -> str | None:
    return LOCALHOST if _stack_up() else None


async def resolve_username_owner(username: str) -> tuple[str | None, str | None]:
    """Return (ip, owner_id). owner_id is always the single owner so the proxy
    can serve / auto-start; ip is None when the stack is down."""
    ip = LOCALHOST if _stack_up() else None
    return ip, OWNER_ID


async def verify_container_ip(user_id: str, source_ip: str) -> bool:
    return source_ip in _LOOPBACK


# --- Native terminal (PTY) ------------------------------------------------------


class PtyShell:
    """A login shell forked on a PTY, exposed as an async session.

    Reads are event-driven (``loop.add_reader`` on the master fd) — no threads,
    no polling. ``read()`` yields b"" exactly once, when the shell exits.
    """

    def __init__(self, fd: int, pid: int):
        self._fd = fd
        self._pid = pid
        self._chunks: asyncio.Queue[bytes] = asyncio.Queue()
        self._closed = False
        asyncio.get_running_loop().add_reader(fd, self._on_readable)

    def _on_readable(self) -> None:
        try:
            data = os.read(self._fd, 65536)
        except OSError:  # EIO — the child side of the PTY is gone
            data = b""
        if not data:
            asyncio.get_running_loop().remove_reader(self._fd)
        self._chunks.put_nowait(data)

    async def read(self) -> bytes:
        """Next chunk of shell output; b"" once the shell has exited."""
        if self._closed:
            return b""
        return await self._chunks.get()

    def write(self, data: bytes) -> None:
        os.write(self._fd, data)

    def resize(self, rows: int, cols: int) -> None:
        if self._closed:
            return
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self._fd, termios.TIOCSWINSZ, winsize)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        asyncio.get_running_loop().remove_reader(self._fd)
        os.close(self._fd)
        try:
            os.waitpid(self._pid, os.WNOHANG)
        except OSError:  # already reaped
            pass


async def open_shell(user_id: str = "") -> PtyShell:
    """Fork a login shell on a PTY in the owner's home."""
    pid, fd = pty.fork()
    if pid == 0:  # child
        os.environ["TERM"] = "xterm-256color"
        try:
            os.chdir(str(HOME_DIR))
        except OSError:
            pass
        shell = os.environ.get("SHELL", "/bin/bash")
        os.execvp(shell, [shell, "-l"])
        os._exit(1)  # unreachable
    return PtyShell(fd, pid)

"""Per-port public visibility for user containers.

Users can mark specific ports as "public" so external services (webhooks,
ChatGPT, etc.) can reach them without cookie auth.  State is kept in memory
for O(1) lookups on every proxy request and persisted to disk so it survives
API restarts.

Pattern: module-level dict + functions (same as activity.py).
"""

import json
import logging
import os
import time
from pathlib import Path

from api.config import DATA_DIR

log = logging.getLogger(__name__)

MAX_PUBLIC_PORTS = int(os.environ.get("MAX_PUBLIC_PORTS", "5"))
_FILENAME = "public_ports.json"
_ACTIVITY_FILENAME = "port_activity.json"

# Ports below this are system/reserved and cannot be made public
_MIN_PUBLIC_PORT = 1024

# {user_id: set[int]}
_public_ports: dict[str, set[int]] = {}
# {user_id: {port_str: {"last_hit_at": float | None, "hit_count": int}}}
_port_activity: dict[str, dict[str, dict[str, float | int | None]]] = {}


def is_port_public(user_id: str, port: int) -> bool:
    return port in _public_ports.get(user_id, set())


def get_public_ports(user_id: str) -> set[int]:
    return set(_public_ports.get(user_id, set()))


def get_port_activity(user_id: str) -> dict[int, dict[str, float | int | None]]:
    raw = _port_activity.get(user_id, {})
    return {
        int(port): {
            "last_hit_at": data.get("last_hit_at"),
            "hit_count": int(data.get("hit_count", 0)),
        }
        for port, data in raw.items()
    }


def record_port_hit(user_id: str, port: int, timestamp: float | None = None) -> None:
    now = timestamp if timestamp is not None else time.time()
    activity = _port_activity.setdefault(user_id, {})
    key = str(port)
    entry = activity.setdefault(key, {"last_hit_at": None, "hit_count": 0})
    entry["last_hit_at"] = now
    entry["hit_count"] = int(entry.get("hit_count", 0)) + 1
    _persist_activity(user_id)


def get_stale_public_ports(user_id: str, older_than_seconds: float) -> list[int]:
    current = sorted(get_public_ports(user_id))
    activity = get_port_activity(user_id)
    stale: list[int] = []
    for port in current:
        last_hit_at = activity.get(port, {}).get("last_hit_at")
        if not last_hit_at or last_hit_at < older_than_seconds:
            stale.append(port)
    return stale


def cleanup_stale_public_ports(user_id: str, older_than_seconds: float) -> list[int]:
    closed: list[int] = []
    for port in get_stale_public_ports(user_id, older_than_seconds):
        set_port_visibility(user_id, port, False)
        closed.append(port)
    return closed


def set_port_visibility(user_id: str, port: int, public: bool) -> set[int]:
    """Toggle a port's public visibility. Returns updated set of public ports.

    Raises ValueError if adding would exceed MAX_PUBLIC_PORTS,
    or if the port is reserved/invalid.
    """
    if port < 1 or port > 65535:
        raise ValueError(f"Invalid port number: {port}")
    if public and port < _MIN_PUBLIC_PORT:
        raise ValueError(
            f"Port {port} is a reserved system port (must be >= {_MIN_PUBLIC_PORT})"
        )
    current = _public_ports.get(user_id, set())

    if public:
        if port not in current and len(current) >= MAX_PUBLIC_PORTS:
            raise ValueError(
                f"Maximum of {MAX_PUBLIC_PORTS} public ports reached"
            )
        current = current | {port}
    else:
        current = current - {port}

    if current:
        _public_ports[user_id] = current
    else:
        _public_ports.pop(user_id, None)

    _persist(user_id, current)
    if not public:
        raw = _port_activity.get(user_id, {})
        if str(port) in raw:
            raw.pop(str(port), None)
            if raw:
                _port_activity[user_id] = raw
            else:
                _port_activity.pop(user_id, None)
            _persist_activity(user_id)
    return set(current)


def _persist(user_id: str, ports: set[int]) -> None:
    path = DATA_DIR / user_id / _FILENAME
    if not ports:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sorted(ports)))


def _persist_activity(user_id: str) -> None:
    path = DATA_DIR / user_id / _ACTIVITY_FILENAME
    activity = _port_activity.get(user_id, {})
    if not activity:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(activity, indent=2))


def seed_from_disk() -> int:
    """Load all public_ports.json files from disk. Returns count loaded."""
    count = 0
    if not DATA_DIR.exists():
        return count
    for user_dir in DATA_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        path = user_dir / _FILENAME
        if not path.exists():
            continue
        try:
            ports = set(json.loads(path.read_text()))
            if ports:
                _public_ports[user_dir.name] = ports
                count += 1
        except (json.JSONDecodeError, TypeError):
            log.warning("Invalid %s for user %s", _FILENAME, user_dir.name)
        activity_path = user_dir / _ACTIVITY_FILENAME
        if activity_path.exists():
            try:
                activity = json.loads(activity_path.read_text())
                if isinstance(activity, dict):
                    _port_activity[user_dir.name] = activity
            except (json.JSONDecodeError, TypeError):
                log.warning("Invalid %s for user %s", _ACTIVITY_FILENAME, user_dir.name)
    log.info("Loaded public ports for %d users", count)
    return count

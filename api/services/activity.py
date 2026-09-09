"""Track request and persistent-connection activity."""

import logging
import time


log = logging.getLogger(__name__)

# {user_id: unix_timestamp}
_last_activity: dict[str, float] = {}

# {user_id: count} — open WebSocket / terminal connections
_open_connections: dict[str, int] = {}


def touch(user_id: str) -> None:
    """Record activity for a user's container."""
    _last_activity[user_id] = time.time()


def connection_opened(user_id: str) -> None:
    """Track a new persistent connection (WebSocket, terminal)."""
    _open_connections[user_id] = _open_connections.get(user_id, 0) + 1
    touch(user_id)


def connection_closed(user_id: str) -> None:
    """Track a closed persistent connection."""
    count = _open_connections.get(user_id, 0)
    if count <= 0:
        # Mismatched close (e.g. crash before open was tracked) — don't go negative
        _open_connections.pop(user_id, None)
        log.debug("connection_closed for %s with no open connections", user_id)
    elif count == 1:
        _open_connections.pop(user_id, None)
    else:
        _open_connections[user_id] = count - 1
    touch(user_id)



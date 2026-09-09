"""Named app routes: a stable, pretty hostname for an app running on the box.

``<name>.<APP_DOMAIN>`` resolves to a registered port and is then served by the
subdomain proxy exactly like ``<owner>-<port>.<APP_DOMAIN>`` (same auth gate,
same public / share-link semantics — visibility belongs to the PORT, a name only
points at it). The name outlives the port: change where the app listens and
the URL, the installed PWA and its localStorage all survive.

State is kept in memory for O(1) lookups on every proxy request and persisted
next to the public-ports state (``DATA_DIR/<user>/app_routes.json``), same
pattern as ``ports.py``.

Decision: docs/decisions/20260909-named-app-routes.md.
"""

import json
import logging
import re

from api.config import APP_DOMAIN, DATA_DIR, FILE_PORT, OWNER_USERNAME, reserved_service_ports
from api.services import ports

log = logging.getLogger(__name__)

_FILENAME = "app_routes.json"
MAX_APP_ROUTES = 20
_MIN_APP_PORT = 1024

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}[a-z0-9]$")  # must also match SUBDOMAIN_RE (leading letter)
# Labels ShellTeam serves or may serve at `<label>.<APP_DOMAIN>`; a route may
# never shadow them. The owner's own label is the file host; `<label>-<port>`
# is the port-preview pattern (matched by shape below, not listed here).
RESERVED_NAMES = frozenset(
    {
        "www", "api", "app", "mail", "admin", "static", "files", "public",
        "reports", "cockpit", "guest", "share",
    }
)
_PORT_SHAPE_RE = re.compile(r"-\d+$")

# {user_id: {name: port}}
_routes: dict[str, dict[str, int]] = {}


def validate_name(name: str) -> str:
    """Return the normalised name or raise ValueError explaining why not."""
    name = name.strip().lower()
    if not NAME_RE.match(name):
        raise ValueError(
            "Name must be 2 to 32 characters, start with a letter, and use only "
            "lowercase letters, digits and hyphens (no trailing hyphen)"
        )
    if name in RESERVED_NAMES or name == OWNER_USERNAME:
        raise ValueError(f"'{name}' is reserved")
    if _PORT_SHAPE_RE.search(name):
        raise ValueError(
            f"'{name}' looks like a port preview host (<label>-<port>); pick another name"
        )
    return name


def validate_port(port: int) -> int:
    if port < _MIN_APP_PORT or port > 65535:
        raise ValueError(f"Port must be between {_MIN_APP_PORT} and 65535")
    if port == FILE_PORT or port in reserved_service_ports():
        raise ValueError(f"Port {port} belongs to a ShellTeam service and cannot be named")
    return port


def get_routes(user_id: str) -> dict[str, int]:
    return dict(_routes.get(user_id, {}))


def describe(user_id: str) -> list[dict]:
    """Rows for the APIs and the Settings card: name, port, url, visibility.
    Visibility is the PORT's (public toggle) — a name only points at it."""
    return [
        {
            "name": name,
            "port": port,
            "url": f"https://{name}.{APP_DOMAIN}",
            "public": ports.is_port_public(user_id, port),
        }
        for name, port in sorted(get_routes(user_id).items())
    ]


def port_for_name(user_id: str, name: str) -> int | None:
    return _routes.get(user_id, {}).get(name)


def set_route(user_id: str, name: str, port: int) -> dict[str, int]:
    """Create or repoint a route. Returns the user's routes after the change."""
    name = validate_name(name)
    port = validate_port(port)
    current = _routes.get(user_id, {})
    if name not in current and len(current) >= MAX_APP_ROUTES:
        raise ValueError(f"Maximum of {MAX_APP_ROUTES} named routes reached")
    previous = current.get(name)
    current = {**current, name: port}
    _routes[user_id] = current
    _persist(user_id, current)
    if previous is None:
        log.info("Named route %s -> :%d created", name, port)
    elif previous != port:
        log.info("Named route %s repointed :%d -> :%d", name, previous, port)
    return dict(current)


def remove_route(user_id: str, name: str) -> bool:
    """Remove a route. Returns False when there was nothing to remove."""
    current = _routes.get(user_id, {})
    if name not in current:
        return False
    current = {k: v for k, v in current.items() if k != name}
    if current:
        _routes[user_id] = current
    else:
        _routes.pop(user_id, None)
    _persist(user_id, current)
    log.info("Named route %s removed", name)
    return True


def _persist(user_id: str, routes: dict[str, int]) -> None:
    path = DATA_DIR / user_id / _FILENAME
    if not routes:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(sorted(routes.items())), indent=2))


def seed_from_disk() -> int:
    """Load every app_routes.json under DATA_DIR. Returns the number of users loaded.

    Entries that fail today's validation (a name that became reserved, a port
    that became a service port) are dropped and the file rewritten, so a stale
    grant can never route traffic into a ShellTeam service."""
    count = 0
    if not DATA_DIR.exists():
        return count
    for user_dir in DATA_DIR.iterdir():
        path = user_dir / _FILENAME
        if not user_dir.is_dir() or not path.exists():
            continue
        try:
            raw = json.loads(path.read_text())
        except (json.JSONDecodeError, TypeError):
            log.warning("Invalid %s for user %s", _FILENAME, user_dir.name)
            continue
        routes: dict[str, int] = {}
        for name, port in (raw.items() if isinstance(raw, dict) else []):
            try:
                routes[validate_name(str(name))] = validate_port(int(port))
            except (ValueError, TypeError) as e:
                log.warning("Dropping named route %r -> %r for %s: %s", name, port, user_dir.name, e)
        if len(routes) != len(raw):
            _persist(user_dir.name, routes)
        if routes:
            _routes[user_dir.name] = routes
            count += 1
    log.info("Loaded named app routes for %d users", count)
    return count

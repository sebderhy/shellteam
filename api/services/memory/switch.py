"""The move into the knowledge tree, done once per box, on its first night.

A box that still has the old knowledge files (``~/.shellteam/knowledge``)
moves them into facts before its first night reads anything; a new box has
none and starts empty. ``live.json`` under the memory root records the day:
the 30-day clock for "state" facts starts there, and the old files are kept
untouched for 30 days after it.
"""

from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from pathlib import Path

from api.services.memory import migrate
from api.services.memory.store import memory_root

log = logging.getLogger("shellteam.memory")

KEEP_OLD_DAYS = 30


def live_path(home: Path) -> Path:
    return memory_root(home) / "live.json"


def live_since(home: Path) -> date | None:
    """The day memory moved into the tree, or None before its first night."""
    path = live_path(home)
    return date.fromisoformat(json.loads(path.read_text())["since"]) if path.exists() else None


def move_in(home: Path, today: date | None = None) -> dict:
    """Move whatever the old files hold into facts, then mark the box as
    moved. Returns the move's summary ({} when there was nothing to move)."""
    today = today or date.today()
    if live_since(home):
        raise RuntimeError("Memory has already moved into the knowledge tree")
    summary = migrate.move(home, today=today) if migrate.read_old(home) else {}
    path = live_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "since": today.isoformat(),
        "old_files_kept_until": (today + timedelta(days=KEEP_OLD_DAYS)).isoformat(),
    }, indent=1))
    log.info("Memory moved into the knowledge tree (%d old line(s) read; old files kept until %s)",
             summary.get("old_lines", 0), today + timedelta(days=KEEP_OLD_DAYS))
    return summary

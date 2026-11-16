"""What a chat was told (K16): the exact launch text a cockpit chat started with.

The cockpit keeps each distinct launch text of a folder once
(``told/<hash>.md``) and one line per change in ``told/launches.jsonl``
(``agent-layer.mjs: recordLaunchText``). A chat's text is the one in force
for its folder when it sent its first message.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

from api.services.memory import reading, views
from api.services.memory.store import memory_root

OUTSIDE = "/"        # the key of chats outside home, or in a hidden folder of it


def launch_key(home: Path, cwd: str | Path) -> str:
    """Whose launch text a chat started in ``cwd`` gets: "" for ~, "/" for
    outside home, else the nearest folder with a card, or the top folder of a
    project with none yet. Mirrors ``composeTree`` in agent-layer.mjs."""
    cwd, home_s = os.path.normpath(str(cwd)), os.path.normpath(str(home))
    if cwd == home_s:
        return ""
    if not cwd.startswith(home_s + "/"):
        return OUTSIDE
    parts = [p for p in cwd[len(home_s) + 1:].split("/") if p]
    if parts[0].startswith("."):
        return OUTSIDE
    root = views.views_dir(memory_root(home))
    for depth in range(len(parts), 0, -1):
        if (root.joinpath(*parts[:depth]) / "card.md").exists():
            return "/".join(parts[:depth])
    return parts[0]


def where(key: str) -> str:
    return "~" if key == "" else "outside your home folder" if key == OUTSIDE else f"~/{key}"


def launches(home: Path) -> list[dict]:
    path = memory_root(home) / "told" / "launches.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def text_of(home: Path, sha: str) -> str:
    return (memory_root(home) / "told" / f"{sha}.md").read_text()


def chat_start(home: Path, tab: dict) -> float:
    """When a cockpit chat sent its first message: its transcript's first
    line when the agent's transcript is found, else when the tab was made."""
    session = str(tab.get("sessionId") or "")
    family = tab.get("sessionFamily") or "claude"
    found: list[Path] = []
    if session and family == "claude":
        found = list((home / ".claude" / "projects").glob(f"*/{session}.jsonl"))
    elif session and family == "codex":
        found = list((home / ".codex" / "sessions").rglob(f"rollout-*{session}.jsonl"))
    elif session and family == "pi":
        found = list(reading.pi_sessions_root(home).glob(f"*/*_{session}.jsonl"))
    for path in found:
        with path.open() as f:
            for raw in f:
                try:
                    ts = reading._epoch(json.loads(raw).get("timestamp"))
                except json.JSONDecodeError:
                    continue
                if ts:
                    return ts
    return (tab.get("createdAt") or 0) / 1000


def cockpit_chats(home: Path) -> list[dict]:
    path = home / ".claude-chat-tabs.json"
    if not path.exists():
        return []
    return [t for t in json.loads(path.read_text()) if t.get("id") not in (None, 0)]


def told(home: Path, *, chat: int | None = None, folder: str | None = None) -> dict:
    """The launch text of one cockpit chat, or the last one given in a folder."""
    if chat is not None:
        tab = next((t for t in cockpit_chats(home) if t.get("id") == chat), None)
        if tab is None:
            raise KeyError(f"no cockpit chat {chat}")
        cwd, started, title = tab.get("cwd") or str(home), chat_start(home, tab), tab.get("title") or ""
    else:
        cwd, started, title = str(home / folder) if folder else str(home), None, ""
    key = launch_key(home, cwd)
    mine = [l for l in launches(home) if l["key"] == key]
    # A chat's first spawn can come a moment after its first line is written.
    given = [l for l in mine if started is None or l["at"] <= started + 30]
    out = {"key": key, "where": where(key), "chat": title, "started": started, "recorded": None,
           "text": None, "exact": True, "note": ""}
    if given:
        out.update(recorded=given[-1]["at"], text=text_of(home, given[-1]["sha"]))
    elif mine:
        # Older than the records: the first text kept, labelled as such.
        first = datetime.fromtimestamp(mine[0]["at"])
        out.update(recorded=mine[0]["at"], text=text_of(home, mine[0]["sha"]), exact=False,
                   note=f"This chat started before launch texts were kept for {where(key)}. Below is "
                        f"the first one kept, from {first:%-d %b %Y, %H:%M}: this chat may have "
                        "started with an earlier version.")
    else:
        out["note"] = f"No chat has started in {where(key)} since launch texts are kept."
    return out

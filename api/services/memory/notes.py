"""Today's notes (K14): what an agent files for the folder it stands in.

Agents do not edit memory. When one learns something the next chats in its
folder should know today, it files a note (``shellteam-memory note``). Chats
started later at the same level see the notes under "today, not yet filed";
no other level sees them. The nightly job reads the notes like a
conversation, places what is worth keeping, and clears them.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import secrets
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from api.services.memory import reading
from api.services.memory.store import TOP, Store, level_of, load_settings, memory_root, unsafe_reason

log = logging.getLogger("shellteam.memory")

MAX_NOTE_CHARS = 400


def level_here(home: Path, cwd: str | Path) -> str:
    """The level an agent started in ``cwd`` stands at: the nearest folder
    with a card, else its top folder under home. The owner ("") for home
    itself, outside it, under a hidden folder of home, and in a scratch
    folder. A sub-folder of a project without a card of its own is the
    project."""
    try:
        parts = Path(os.path.normpath(cwd)).relative_to(os.path.normpath(home)).parts
    except ValueError:
        return TOP
    if not parts or parts[0].startswith(".") or parts[0] in reading.SCRATCH_FOLDERS:
        return TOP
    levels = Store(memory_root(home)).levels() | {parts[0]}
    visible = []
    for p in parts:
        if p.startswith("."):
            break
        visible.append(p)
    return level_of("/".join(visible), levels)


def notes_path(root: Path) -> Path:
    return root / "notes.jsonl"


def today_path(root: Path, level: str) -> Path:
    """The printed notes of a level, read by the cockpit at launch."""
    return root / "today" / f"{level or '_top'}.md"


@contextmanager
def _locked(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / "notes.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def load(root: Path) -> list[dict]:
    path = notes_path(root)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _save(root: Path, notes: list[dict]) -> None:
    tmp = notes_path(root).with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(n) + "\n" for n in notes))
    tmp.replace(notes_path(root))


def add(home: Path, cwd: str | Path, text: str, agent: str = "") -> dict:
    """File a note at the level ``cwd`` stands at. Raises ValueError for a
    note that may not reach a launch text (an order to agents, a secret)."""
    text = " ".join(text.split())
    if not text:
        raise ValueError("The note is empty.")
    if len(text) > MAX_NOTE_CHARS:
        raise ValueError(f"A note is one or two sentences ({MAX_NOTE_CHARS} characters at most); "
                         f"this one has {len(text)}.")
    if reason := unsafe_reason(text):
        raise ValueError(f"This note cannot be filed: {reason}.")
    root = memory_root(home)
    note = {"id": f"n-{secrets.token_hex(4)}", "level": level_here(home, cwd), "text": text,
            "at": time.time(), "cwd": str(cwd), "agent": agent}
    with _locked(root):
        notes = load(root) + [note]
        _save(root, notes)
        print_today(root, note["level"], notes)
    log.info("Memory: note %s filed at %r", note["id"], note["level"] or "the owner")
    return note


def print_today(root: Path, level: str, notes: list[dict]) -> None:
    """Print a level's notes, newest first, within the "today" limit. Older
    notes that do not fit are counted on one line, never cut silently."""
    path = today_path(root, level)
    mine = sorted((n for n in notes if n["level"] == level), key=lambda n: n["at"], reverse=True)
    if not mine:
        path.unlink(missing_ok=True)
        return
    limit = load_settings(root)["limits"]["today"]
    where = "~" if level == TOP else f"~/{level}"
    title = f"TODAY, NOT YET FILED  (notes agents left in {where}; tonight's run files them)"
    lines, size = [], len(title)
    for n in mine:
        line = f"- [{datetime.fromtimestamp(n['at']):%H:%M}] {n['text']}"
        if lines and size + len(line) + 1 > limit:
            break
        lines.append(line)
        size += len(line) + 1
    if len(lines) < len(mine):
        lines.append(f"- {len(mine) - len(lines)} older note(s) wait for tonight's run.")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join([title, *lines]) + "\n")


def as_conversations(home: Path, before: float) -> list[reading.Conversation]:
    """The notes filed before ``before``, one conversation per level, for the
    nightly job to read like any other. A message's ``end`` is its note id."""
    by_level: dict[str, reading.Conversation] = {}
    for n in sorted(load(memory_root(home)), key=lambda n: n["at"]):
        if n["at"] >= before:
            continue
        conv = by_level.get(n["level"])
        if conv is None:
            conv = by_level[n["level"]] = reading.Conversation(
                f"note:{n['level']}", "note", f"notes-{n['level'] or 'owner'}",
                str(home / n["level"]) if n["level"] else str(home), n["level"].split("/")[0])
        conv.messages.append(reading.Message("agent", n["text"], n["at"], n["id"]))
    return list(by_level.values())


def clear(home: Path, ids: set[str]) -> None:
    """Remove the notes the nightly job has read, and print again the levels
    they were on. Notes filed during the night stay."""
    if not ids:
        return
    root = memory_root(home)
    with _locked(root):
        notes = load(root)
        levels = {n["level"] for n in notes if n["id"] in ids}
        kept = [n for n in notes if n["id"] not in ids]
        _save(root, kept)
        for level in levels:
            print_today(root, level, kept)
    log.info("Memory: %d note(s) read by the night and cleared", len(ids))

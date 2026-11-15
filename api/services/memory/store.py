"""The fact list: one dated sentence per fact, nothing ever deleted.

``facts.jsonl`` under the memory root is the source of truth. A fact that is
out of date is marked (replaced, retired, removed by the owner, blocked), not
removed, so every line an agent was ever given can be traced and undone.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path

log = logging.getLogger("shellteam.memory")

KINDS = ("rule", "correction", "decision", "state", "reference", "person")
STATUSES = ("active", "replaced", "retired", "removed", "blocked")
PARTS = ("what", "now", "rules")     # where a fact prints on a card
TOP = ""                             # the folder of facts about the owner
MAX_FACT_CHARS = 240
SUBAREAS = "subareas.json"           # the sub-folders that have a card of their own (K18)

DEFAULT_SETTINGS = {
    # Characters, everything printed in the view counted. Starting values: the
    # exam decides the defaults (README, "Sizes are settings").
    "limits": {
        "top_card": 10_000,
        "top_essentials": 3_000,
        "project_card": 8_000,
        "project_essentials": 2_000,
        "subarea_card": 4_000,
        "today": 1_500,
    },
    # A card this full (share of its limit) that changed tonight is checked
    # for a group of facts about one sub-folder, which then gets its own card
    # (K18). Printing keeps a card inside its limit, so "full" is the trigger.
    "split_when_full": 0.9,
    "state_days": 30,     # a "state" fact leaves the card when unconfirmed this long
    "recent_days": 60,    # a line's date shows the day when confirmed this recently
    # Characters of conversation one night reads. What is over stays behind
    # its bookmark for the next night and is reported, never dropped.
    "night_chars": 1_000_000,
    # "off": cockpit chats start each agent with its own built-in memory off
    # (Claude Code's notes, Codex's memories), so there is one memory (K15).
    # Read at launch by agent-layer.mjs.
    "agents_own_memory": "on",
}


def memory_root(home: Path) -> Path:
    """Where memory lives. ``SHELLTEAM_MEMORY_ROOT`` points one process at
    another tree (the exam's size arms); everything else uses the default."""
    override = os.environ.get("SHELLTEAM_MEMORY_ROOT")
    return Path(override) if override else home / ".shellteam" / "memory"


def load_settings(root: Path) -> dict:
    """The defaults with the owner's ``settings.json`` on top. An unknown key
    is a typo that would otherwise silently do nothing, so it raises."""
    settings = json.loads(json.dumps(DEFAULT_SETTINGS))
    path = root / "settings.json"
    if not path.exists():
        return settings
    custom = json.loads(path.read_text())
    for key, value in custom.items():
        if key not in settings:
            raise ValueError(f"Unknown memory setting {key!r} in {path}")
        if key == "limits":
            unknown = set(value) - set(settings["limits"])
            if unknown:
                raise ValueError(f"Unknown memory limit(s) {sorted(unknown)} in {path}")
            settings["limits"].update(value)
        else:
            settings[key] = value
    if settings["agents_own_memory"] not in ("on", "off"):
        raise ValueError(f"agents_own_memory must be \"on\" or \"off\" in {path}")
    return settings


@dataclass
class Fact:
    id: str
    text: str
    kind: str
    folder: str                 # home-relative folder it is about; "" = the owner
    topic: str                  # the record page it lives on
    first_seen: str             # YYYY-MM-DD
    last_confirmed: str
    sources: list[dict] = field(default_factory=list)
    status: str = "active"
    replaced_by: str | None = None
    on_card: bool = False
    essential: bool = False     # also on the level's essentials (implies on_card)
    pinned: bool = False        # fixed on its view by the owner
    part: str = ""              # card part; "" = decided by kind

    def card_part(self) -> str:
        if self.part:
            return self.part
        return "now" if self.kind == "state" else "rules"

    @property
    def active(self) -> bool:
        return self.status == "active"


def level_of(folder: str, levels: set[str]) -> str:
    """The nearest level (a folder that has a card) at or above ``folder``."""
    parts = folder.split("/") if folder else []
    for depth in range(len(parts), 0, -1):
        candidate = "/".join(parts[:depth])
        if candidate in levels:
            return candidate
    return TOP


# Text that must never reach a launch text: it reads as an order to the agent,
# or it is a credential. Checked when a fact is written and again when printed.
_INSTRUCTION_RE = re.compile(
    r"<\s*/?\s*system|system-reminder|ignore (?:all |any )?(?:previous|prior|above)"
    r"|disregard (?:all |any )?(?:previous|prior|above)|you are now|new instructions:"
    r"|do not tell the (?:user|owner)",
    re.I,
)
_SECRET_RE = re.compile(
    r"sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY"
    r"|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"
    r"|(?:password|passwd|secret|token|api[_ -]?key)\s*(?:is|=|:)\s*\S{8,}",
    re.I,
)


def unsafe_reason(text: str) -> str:
    """Why this sentence may not be shown to an agent, or "" when it may."""
    if _INSTRUCTION_RE.search(text):
        return "reads as an instruction to the agent"
    if _SECRET_RE.search(text):
        return "looks like a secret"
    if "\n" in text.strip():
        return "more than one line"
    return ""


class Store:
    """The facts of one memory root, loaded whole and saved whole, and the
    sub-areas the nightly job has given a card of their own (K18)."""

    def __init__(self, root: Path):
        self.root = root
        self.facts: dict[str, Fact] = {}
        path = self.path
        if path.exists():
            for line in path.read_text().splitlines():
                if line.strip():
                    fact = Fact(**json.loads(line))
                    self.facts[fact.id] = fact
        subareas = self.root / SUBAREAS
        self.subareas: set[str] = set(json.loads(subareas.read_text())) if subareas.exists() else set()

    @property
    def path(self) -> Path:
        return self.root / "facts.jsonl"

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text("".join(json.dumps(asdict(f)) + "\n" for f in self.facts.values()))
        tmp.replace(self.path)
        subareas = self.root / SUBAREAS
        if self.subareas or subareas.exists():
            subareas.write_text(json.dumps(sorted(self.subareas), indent=1) + "\n")

    def new_id(self) -> str:
        while True:
            fid = f"f-{secrets.token_hex(3)}"
            if fid not in self.facts:
                return fid

    def add(self, *, text: str, kind: str, folder: str, topic: str, source: dict,
            seen: str | None = None, **marks) -> Fact:
        """A new fact. A sentence that is unsafe to show an agent is stored
        blocked: hidden from agents, still visible to the owner."""
        if kind not in KINDS:
            raise ValueError(f"Unknown fact kind {kind!r}")
        text = " ".join(text.split())
        if not text:
            raise ValueError("A fact needs a sentence")
        seen = seen or date.today().isoformat()
        fact = Fact(id=self.new_id(), text=text, kind=kind, folder=folder.strip("/"),
                    topic=topic.strip().lower() or "general", first_seen=seen,
                    last_confirmed=seen, sources=[source], **marks)
        reason = unsafe_reason(text)
        if reason:
            fact.status, fact.on_card, fact.essential = "blocked", False, False
            log.warning("Memory: fact %s stored blocked (%s)", fact.id, reason)
        self.facts[fact.id] = fact
        return fact

    def active(self) -> list[Fact]:
        return [f for f in self.facts.values() if f.active]

    def levels(self) -> set[str]:
        """Folders that have a card: the top, each top-level folder with at
        least one active fact, and each sub-area that holds one."""
        active = self.active()
        return {TOP} | {f.folder.split("/")[0] for f in active if f.folder} | {
            s for s in self.subareas
            if any(f.folder == s or f.folder.startswith(s + "/") for f in active)}

    def at_level(self, level: str) -> list[Fact]:
        levels = self.levels()
        return [f for f in self.active() if level_of(f.folder, levels) == level]

"""Printing: cards, essentials and record pages, from the fact list.

Limits are enforced here, when a view is printed, so a launch never has to
cut. Every printed line is one fact with the date it was last confirmed;
pointers (the levels below, the record topics, the level above) are printed
lines, not facts. A printed file the owner changed by hand is read back before
anything is printed over it.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from api.services.memory.store import TOP, Fact, Store, load_settings, unsafe_reason

log = logging.getLogger("shellteam.memory")

TOP_DIR = "_top"
MANIFEST = ".printed.json"
POINTER_CHARS = 110
SAME_LINE = 0.6     # how alike an added and a removed line must be to count as an edit

# Card headings. The first three hold facts; the others hold printed pointers.
PART_TITLES = {
    "project": {"what": "What this is", "now": "Now", "rules": "Rules and traps"},
    "top": {"what": "Who they are", "essentials": "How to work with them", "now": "Now",
            "rules": "Also"},
}
POINTER_TITLES = ("Projects", "Below", "Record", "Above")


# The command every agent uses to look further and to leave a note (K13, K14).
MEMORY_COMMAND = str(Path(__file__).resolve().parents[3] / "bin" / "shellteam-memory")
FOOTER = (
    "To look further than these notes: `{command} search <words>` (this folder's facts, the "
    "levels above, then past conversations of every agent; add --all for other projects). "
    "Record pages listed above can also be opened directly.\n"
    "When you learn something the next chats in this folder should know (a decision, a "
    "correction, a rule), leave a note: `{command} note \"<one or two sentences>\"`. "
    "The nightly job files it. Do not edit memory files.\n")


def views_dir(root: Path) -> Path:
    return root / "views"


def level_dir(root: Path, level: str) -> Path:
    return views_dir(root) / (level or TOP_DIR)


def topic_slug(topic: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-") or "general"


def record_path(root: Path, level: str, topic: str) -> Path:
    return level_dir(root, level) / "record" / f"{topic_slug(topic)}.md"


def shown_path(root: Path, path: Path) -> str:
    """How a record page is named in a card. Home-relative, so the same card
    is right on the owner's box and inside an employee's (K20); a memory root
    set by hand (the exam) is shown as it is."""
    if os.environ.get("SHELLTEAM_MEMORY_ROOT"):
        return str(path)
    return f"~/.shellteam/memory/{path.relative_to(root)}"


def show_date(iso: str, today: date, recent_days: int) -> str:
    """Day and month within the last ``recent_days``; otherwise the month,
    with the year when it is not the current one (K12)."""
    d = date.fromisoformat(iso)
    if (today - d).days <= recent_days:
        return f"{d.day} {d:%b}"
    return f"{d:%b}" if d.year == today.year else f"{d:%b %Y}"


def fact_line(fact: Fact, today: date, recent_days: int) -> str:
    return f"- {fact.text}  [{show_date(fact.last_confirmed, today, recent_days)}]"


_DATE_TAIL = re.compile(r"\s*\[[^\]]{1,12}\]\s*$")


def _line_text(line: str) -> str:
    return _DATE_TAIL.sub("", line[2:]).strip()


@dataclass
class LevelPrint:
    card_chars: int = 0
    card_limit: int = 0
    essentials_chars: int = 0
    essentials_limit: int = 0
    over_by_pins: list[str] = field(default_factory=list)     # views over their limit
    taken_off_to_fit: list[str] = field(default_factory=list)
    expired: list[str] = field(default_factory=list)


@dataclass
class PrintReport:
    levels: dict[str, LevelPrint] = field(default_factory=dict)
    owner_edits: list[dict] = field(default_factory=list)


# --- owner hand edits ----------------------------------------------------------------


def _manifest(root: Path) -> dict:
    path = views_dir(root) / MANIFEST
    return json.loads(path.read_text()) if path.exists() else {}


def _sha(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()


def take_in_hand_edits(store: Store, today: date | None = None) -> list[dict]:
    """Read back every printed file the owner changed since it was printed.

    A changed line becomes a pinned owner fact that replaces the old one; a
    deleted line marks its fact removed by the owner (it is never added back);
    a new line becomes a pinned owner fact at that level. Returns what was
    taken in, for the report.
    """
    today = today or date.today()
    taken: list[dict] = []
    for rel, printed in _manifest(store.root).items():
        path = views_dir(store.root) / rel
        if not path.exists():
            log.warning("Memory: printed file %s is gone; it will be printed again", rel)
            continue
        text = path.read_text()
        if _sha(text) == printed["sha"]:
            continue
        taken += _take_in_file(store, rel, printed, text, today)
    if taken:
        log.info("Memory: took in %d owner edit(s) from printed files", len(taken))
    return taken


def _take_in_file(store: Store, rel: str, printed: dict, text: str, today: date) -> list[dict]:
    titles = {t: part for kind in PART_TITLES.values() for part, t in kind.items()}
    now_lines: dict[str, str] = {}   # line -> part it sits under ("" = pointer section)
    part = "rules" if printed["view"] == "record" else ""
    for raw in text.splitlines():
        line = raw.rstrip()
        if line in titles:
            part = titles[line]
        elif line.split("  ")[0] in POINTER_TITLES:
            part = ""
        elif line.startswith("- "):
            now_lines[line] = part
    gone = {line: fid for line, fid in printed["lines"].items() if line not in now_lines}
    added = [line for line in now_lines
             if line not in printed["lines"] and line not in printed["pointers"]]
    taken: list[dict] = []

    def owner_fact(line: str, like: Fact | None) -> Fact | None:
        part = now_lines[line]
        if not part and like is None:
            log.warning("Memory: line added under a pointer heading in %s is not a fact: %r", rel, line)
            taken.append({"what": "ignored", "file": rel, "text": _line_text(line),
                          "why": "added under a pointer heading"})
            return None
        on_view = printed["view"] != "record"
        return store.add(
            text=_line_text(line),
            kind=like.kind if like else ("state" if part == "now" else "rule"),
            folder=like.folder if like else printed["level"],
            topic=like.topic if like else printed.get("topic", "general"),
            source={"type": "owner", "ref": rel, "date": today.isoformat()},
            seen=today.isoformat(), pinned=True,
            on_card=like.on_card if like else on_view,
            essential=like.essential if like else (printed["view"] == "essentials" or part == "essentials"),
            part=like.part if like else (part if part in ("what", "now", "rules") else ""),
        )

    for line, fid in gone.items():
        old = store.facts[fid]
        if not old.active:
            continue
        match = difflib.get_close_matches(line, added, n=1, cutoff=SAME_LINE)
        if match:
            added.remove(match[0])
            new = owner_fact(match[0], old)
            old.status, old.replaced_by = "replaced", new.id
            taken.append({"what": "edited", "file": rel, "old": fid, "new": new.id, "text": new.text})
        else:
            old.status, old.on_card, old.essential = "removed", False, False
            taken.append({"what": "removed", "file": rel, "old": fid, "text": old.text})
    for line in added:
        new = owner_fact(line, None)
        if new:
            taken.append({"what": "added", "file": rel, "new": new.id, "text": new.text})
    return taken


# --- printing ------------------------------------------------------------------------


def _clip(text: str) -> str:
    return text if len(text) <= POINTER_CHARS else text[:POINTER_CHARS - 1].rstrip() + "…"


def _newest(facts: list[Fact]) -> list[Fact]:
    return sorted(facts, key=lambda f: (f.pinned, f.last_confirmed, f.id), reverse=True)


def _with_size(title: str, body: list[str], limit: int) -> str:
    """The view's text with its own size in the heading: ``n of limit``."""
    size = 0
    for _ in range(3):   # the number's width can change the count once
        text = "\n".join([f"{title}  {size:,} of {limit:,}", *body]) + "\n"
        if len(text) == size:
            break
        size = len(text)
    return text


def _pointer(store: Store, level: str) -> str:
    """One line about a level below: what it is and its top "now" line."""
    card = [f for f in store.at_level(level) if f.on_card]
    what = next((f.text for f in _newest(card) if f.card_part() == "what"), "")
    now = next((f.text for f in _newest(card) if f.card_part() == "now"), "")
    bits = [f"~/{level}"] + ([_clip(what)] if what else []) + ([f"now: {_clip(now)}"] if now else [])
    return "- " + "  ".join(bits[:2]) + ("; " + bits[2] if len(bits) > 2 else "")


def card_limit(limits: dict, level: str) -> int:
    return limits["top_card" if level == TOP else "subarea_card" if "/" in level else "project_card"]


def has_essentials(levels: set[str], level: str) -> bool:
    """The top always; a project or sub-area once a level below it has a card."""
    return level == TOP or any(l.startswith(level + "/") for l in levels)


def levels_below(levels: set[str], level: str) -> list[str]:
    """The levels directly below ``level``: the projects under the owner, the
    sub-areas whose nearest level above is ``level``."""
    def parent(l: str) -> str:
        parts = l.split("/")
        return next(("/".join(parts[:d]) for d in range(len(parts) - 1, 0, -1)
                     if "/".join(parts[:d]) in levels), TOP)
    return sorted(l for l in levels if l != TOP and parent(l) == level)


def _card_text(store: Store, level: str, on_card: list[Fact], record: dict[str, list[Fact]],
               limit: int, today: date, recent_days: int) -> str:
    def lines(part: str) -> list[str]:
        return [fact_line(f, today, recent_days) for f in _newest(on_card)
                if (("essentials" if f.essential else f.card_part()) if level == TOP
                    else f.card_part()) == part]

    body: list[str] = []
    titles = PART_TITLES["top" if level == TOP else "project"]
    for part, title in titles.items():
        part_lines = lines(part)
        if part_lines:
            body += [title, *part_lines]
    levels = store.levels()
    below = levels_below(levels, level)
    if level == TOP:
        body += ["Projects  (start a chat in the folder for the full picture)",
                 *([_pointer(store, l) for l in below] or ["- (none yet)"])]
    else:
        body += ["Below", *([_pointer(store, l) for l in below] or ["- (nothing below this level)"])]
    if record:
        body += ["Record  (open a page for the detail)"] + [
            f"- {topic} ({len(facts)}): {shown_path(store.root, record_path(store.root, level, topic))}"
            for topic, facts in sorted(record.items())]
    if level != TOP:
        above = [l for l in levels if l != TOP and level.startswith(l + "/")]
        body += ["Above", *[f"- The full card of ~/{l} is not loaded here: only its essentials, above."
                            for l in sorted(above)],
                 "- Everything else about the owner and the other projects is not "
                 "loaded here; a chat started in the home folder has the wide view."]
    title = ("THE OWNER" if level == TOP else
             f"SUB-AREA: {level.split('/')[-1]}   ~/{level}" if "/" in level else
             f"PROJECT: {level}   ~/{level}")
    return _with_size(title, body, limit)


def _essentials_text(facts: list[Fact], limit: int, today: date, recent_days: int,
                     level: str) -> str:
    title = "ABOUT THE OWNER (essentials)" if level == TOP else f"ABOUT ~/{level} (essentials)"
    return _with_size(title, [fact_line(f, today, recent_days) for f in _newest(facts)], limit)


def _fit(render, facts: list[Fact], limit: int, drop, fixed=lambda f: f.pinned
         ) -> tuple[str, list[str]]:
    """Print ``facts`` within ``limit``: while the text is over, the oldest
    line that is not ``fixed`` leaves the view (``drop`` unmarks it)."""
    taken_off: list[str] = []
    while True:
        text = render(facts)
        loose = [f for f in facts if not fixed(f)]
        if len(text) <= limit or not loose:
            return text, taken_off
        oldest = min(loose, key=lambda f: (f.last_confirmed, f.id))
        drop(oldest)
        facts.remove(oldest)
        taken_off.append(oldest.id)


def print_views(store: Store, today: date | None = None, *, clock_start: date | None = None
                ) -> PrintReport:
    """Print every level's views from the fact list and save the store.

    ``clock_start``: "state" facts expire from the card when unconfirmed for
    ``state_days``, counted from this date at the earliest (the day memory
    went live), so the one-time move does not expire everything at once.
    """
    today = today or date.today()
    settings = load_settings(store.root)
    limits, recent = settings["limits"], settings["recent_days"]
    report = PrintReport(owner_edits=take_in_hand_edits(store, today))
    manifest: dict[str, dict] = {}
    root = views_dir(store.root)

    def write(path: Path, text: str, level: str, view: str, facts: list[Fact], **extra) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        by_line = {fact_line(f, today, recent): f.id for f in facts}
        manifest[str(path.relative_to(root))] = {
            "sha": _sha(text), "level": level, "view": view,
            "lines": {l: by_line[l] for l in text.splitlines() if l in by_line},
            "pointers": [l for l in text.splitlines() if l.startswith("- ") and l not in by_line],
            **extra}

    for fact in store.active():          # checked again at print (design, section 9)
        if reason := unsafe_reason(fact.text):
            fact.status, fact.on_card, fact.essential = "blocked", False, False
            log.warning("Memory: fact %s blocked at print (%s)", fact.id, reason)

    levels = store.levels()
    for level in sorted(levels):
        lp = report.levels[level] = LevelPrint()
        facts = store.at_level(level)
        if clock_start:
            cutoff = (today - timedelta(days=settings["state_days"])).isoformat()
            for f in facts:
                if (f.on_card and f.kind == "state" and not f.pinned
                        and max(f.last_confirmed, clock_start.isoformat()) < cutoff):
                    f.on_card = f.essential = False
                    lp.expired.append(f.id)

        has_below = has_essentials(levels, level)
        directory = level_dir(store.root, level)
        if has_below:
            lp.essentials_limit = limits["top_essentials" if level == TOP else "project_essentials"]
            essentials = [f for f in facts if f.essential]
            text, off = _fit(
                lambda fs: _essentials_text(fs, lp.essentials_limit, today, recent, level),
                essentials, lp.essentials_limit, lambda f: setattr(f, "essential", False))
            lp.essentials_chars = len(text)
            lp.taken_off_to_fit += off
            if len(text) > lp.essentials_limit:
                lp.over_by_pins.append("essentials")
            write(directory / "essentials.md", text, level, "essentials", essentials)
        else:
            for f in facts:
                f.essential = False

        lp.card_limit = card_limit(limits, level)

        def record_of() -> dict[str, list[Fact]]:
            pages: dict[str, list[Fact]] = {}
            for f in facts:
                if not f.on_card:
                    pages.setdefault(f.topic, []).append(f)
            return pages

        def off_card(f: Fact) -> None:
            f.on_card = f.essential = False

        on_card = [f for f in facts if f.on_card]
        text, off = _fit(
            lambda fs: _card_text(store, level, fs, record_of(), lp.card_limit, today, recent),
            on_card, lp.card_limit, off_card,
            # The essentials are the card's core and have a limit of their
            # own: the card makes room by dropping other lines.
            fixed=lambda f: f.pinned or f.essential)
        lp.card_chars = len(text)
        lp.taken_off_to_fit += off
        if len(text) > lp.card_limit:
            lp.over_by_pins.append("card")
        write(directory / "card.md", text, level, "card", on_card)

        for topic, page in record_of().items():
            body = "\n".join(fact_line(f, today, recent) for f in _newest(page))
            where = "the owner" if level == TOP else f"~/{level}"
            write(record_path(store.root, level, topic),
                  f"Record of {where}: {topic}  ({len(page)} facts, newest first)\n{body}\n",
                  level, "record", page, topic=topic)

    header = (
        f"Memory. Reference notes compiled on {today.day} {today:%b %Y}. The owner's message "
        "and the actual code win over anything written here. Each line shows when it was "
        f"last confirmed (day and month within the last {recent} days, otherwise the month).\n")
    root.mkdir(parents=True, exist_ok=True)
    (root / "header.md").write_text(header)
    (root / "footer.md").write_text(FOOTER.format(command=MEMORY_COMMAND))
    for stale in root.rglob("*.md"):     # a level or topic that no longer has facts
        rel = str(stale.relative_to(root))
        if rel not in ("header.md", "footer.md") and rel not in manifest:
            stale.unlink()
    (root / MANIFEST).write_text(json.dumps(manifest, indent=1))
    store.save()
    for level, lp in report.levels.items():
        if lp.over_by_pins:
            log.warning("Memory: %s of %r over its limit: only pinned lines, essentials and pointers are left",
                        " and ".join(lp.over_by_pins), level or "the owner")
    log.info("Memory: printed %d level(s), %d file(s)", len(levels), len(manifest))
    return report

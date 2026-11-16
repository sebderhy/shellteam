"""Looking further (K13): one search every agent can run.

The launch text is short on purpose; this is how an agent reaches the rest.
Order: the facts of the level it stands at, then the levels above, then past
conversations of this project, from every agent. Other projects only when it
asks for everything, or when it stands in ~, whose view is wide by design.
Each result shows its level and date.

Plain words, no embeddings (a non-goal): a result must contain most of the
words asked for, whatever their endings. Conversations are read where they
are, with the nightly job's own parsers, so tool output, sub-agents and the
job's own runs are never found.

Facts that are no longer current (replaced, retired) are history, and a
question about the past needs them: they show apart, after the current ones.
When this project has few matching facts, the best of the other projects
show under their own heading (the same product can live in several folders).
"""

from __future__ import annotations

import functools
import json
import logging
import math
import os
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

from api.services.memory import reading
from api.services.memory.notes import level_here
from api.services.memory.store import TOP, Store, level_of, memory_root
from api.services.memory.views import show_date

log = logging.getLogger("shellteam.memory")

MAX_FACTS = 15
MAX_PAST = 5
MAX_ELSEWHERE = 5
# Fewer current facts than this here, and other projects' best are shown.
ENOUGH_HERE = 3
# History, not truth. Removed (by the owner) and blocked facts are never shown.
PAST = ("replaced", "retired")
_ENDINGS = ("ing", "ed", "es", "s", "e")
MAX_CONVERSATIONS = 8
HITS_PER_CONVERSATION = 2
SNIPPET_CHARS = 320
# Conversations the recall exam's questions came from: an agent sitting the
# exam must not find the answer key (comma-separated session ids).
EXCLUDE_ENV = "SHELLTEAM_MEMORY_SEARCH_EXCLUDE"
_STOP = set("""a an and are as at be but by can did do does for from had has have how i in is it
its me my no not of on or our she so that the their them then there they this to was we were what
when where which who why will with you your he his her him""".split())


@dataclass
class Hit:
    level: str
    when: float           # epoch seconds
    text: str
    where: str            # "fact <id>" or "<agent> conversation <id>"
    score: int


def _stem(word: str) -> str:
    """The word without its ending, so "sandboxes", "servers" and "approves"
    find "sandbox", "server" and "approved". A stem keeps four letters or
    more: "speed" stays "speed"."""
    for end in _ENDINGS:
        if word.endswith(end) and len(word) - len(end) >= 4:
            word = word[: -len(end)]
    return word


def words_of(query: str) -> list[str]:
    words = [w for w in re.findall(r"[a-z0-9][a-z0-9._-]*", query.lower()) if w not in _STOP]
    return list(dict.fromkeys(_stem(w) for w in words))


def _needed(words: list[str]) -> int:
    """How many of the words a result must contain: all of one or two, most
    of more."""
    return len(words) if len(words) <= 2 else math.ceil(len(words) * 0.6)


def _score(text: str, words: list[str]) -> int:
    low = text.lower()
    return sum(1 for w in words if w in low)


def _levels_up(level: str) -> list[str]:
    """``level`` and every level above it, nearest first, the owner last."""
    parts = level.split("/") if level else []
    return ["/".join(parts[:d]) for d in range(len(parts), 0, -1)] + [TOP]


def _fact_hits(store: Store, words: list[str], statuses: tuple[str, ...]) -> list[Hit]:
    """Matching facts of these statuses, every level."""
    known = store.levels()
    hits = []
    for f in store.facts.values():
        if f.status not in statuses:
            continue
        score = _score(f"{f.text} {f.topic}", words)
        if score >= _needed(words):
            when = datetime.fromisoformat(f.last_confirmed).timestamp()
            status = "" if f.status == "active" else f"{f.status}, "
            hits.append(Hit(level_of(f.folder, known), when, f.text,
                            f"fact {f.id}, {status}{f.kind}, {f.topic}", score))
    return hits


def _snippet(text: str, words: list[str]) -> str:
    text = " ".join(text.split())
    low = text.lower()
    at = min((low.find(w) for w in words if w in low), default=0)
    start = max(0, at - SNIPPET_CHARS // 3)
    piece = text[start:start + SNIPPET_CHARS]
    return ("…" if start else "") + piece + ("…" if start + SNIPPET_CHARS < len(text) else "")


CHUNK_BYTES = 32 * 1024 * 1024


def _lines_with(path: Path, needle: bytes):
    """JSON lines of ``path`` that contain ``needle`` (lower case), found
    with a byte search over large chunks: no line is parsed unless it holds
    the word. A transcript can be hundreds of megabytes."""
    with path.open("rb") as f:
        rest = b""
        while chunk := f.read(CHUNK_BYTES):
            data = rest + chunk
            cut = data.rfind(b"\n") + 1
            data, rest = (data[:cut], data[cut:]) if cut else (b"", data)
            yield from _matching(data, needle)
        yield from _matching(rest, needle)


def _matching(data: bytes, needle: bytes):
    low = data.lower()
    pos = low.find(needle)
    while pos != -1:
        start = data.rfind(b"\n", 0, pos) + 1
        end = data.find(b"\n", pos)
        end = len(data) if end == -1 else end
        try:
            yield json.loads(data[start:end])
        except json.JSONDecodeError:
            pass
        pos = low.find(needle, end)


def _claude_dir_name(path: Path) -> str:
    """How Claude Code names a folder's transcript directory."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


@functools.lru_cache(maxsize=4096)
def _level(home: Path, cwd: str) -> str | None:
    return reading.level_for(cwd, home) if cwd else None


def _wanted(home: Path, cwd: str, project: str | None) -> bool:
    level = _level(home, cwd)
    return level is not None and (project is None or level == project)


def _conversation_hits(home: Path, words: list[str], project: str | None,
                       exclude: set[str]) -> list[Hit]:
    """Matching messages of past conversations. ``project`` is the top folder
    ("" for the owner's own chats in ~ and scratch folders), or None for
    every conversation on the box."""
    needle = max(words, key=len).encode()
    hits: list[Hit] = []

    def add(source: str, session: str, level: str, said: tuple[str, str, float] | None) -> None:
        if said and _score(said[1], words) >= _needed(words):
            who = "the owner" if said[0] == "owner" else "the agent"
            hits.append(Hit(level, said[2], f"{who}: {_snippet(said[1], words)}",
                            f"{source} conversation {session}", _score(said[1], words)))

    claude = home / ".claude" / "projects"
    # A project's transcripts sit in directories named after its folders: the
    # rest are not opened. (Names are ambiguous, "a-b" for both ~/a-b and
    # ~/a/b, so each line's own folder still decides.)
    prefix = _claude_dir_name(home / project) if project else None
    for path in sorted(claude.glob("*/*.jsonl")) if claude.is_dir() else []:
        name = path.parent.name
        if path.stem in exclude or (prefix and name != prefix and not name.startswith(prefix + "-")):
            continue
        for line in _lines_with(path, needle):
            cwd = line.get("cwd") or ""
            if _wanted(home, cwd, project):
                add("Claude Code", path.stem, _level(home, cwd), reading.claude_said(line))

    codex = home / ".codex" / "sessions"
    for path in sorted(codex.rglob("rollout-*.jsonl")) if codex.is_dir() else []:
        meta = reading.codex_meta(path)
        session = meta.get("id") or meta.get("session_id") or path.stem
        cwd = meta.get("cwd") or ""
        if session in exclude or reading.is_codex_subagent(meta) or not _wanted(home, cwd, project):
            continue
        for line in _lines_with(path, needle):
            add("Codex", session, reading.level_for(cwd, home), reading.codex_said(line))

    pi = reading.pi_sessions_root(home)
    for path in sorted(pi.glob("*/*.jsonl")) if pi.is_dir() else []:
        meta = reading.pi_meta(path)
        session = meta.get("id") or path.stem
        cwd = meta.get("cwd") or ""
        if session in exclude or not _wanted(home, cwd, project):
            continue
        for line in _lines_with(path, needle):
            add("Pi", session, reading.level_for(cwd, home), reading.pi_said(line))

    # A few lines per conversation, the best and newest conversations first.
    by_conv: dict[str, list[Hit]] = {}
    for h in sorted(hits, key=lambda h: (-h.score, -h.when)):
        by_conv.setdefault(h.where, [])
        if len(by_conv[h.where]) < HITS_PER_CONVERSATION:
            by_conv[h.where].append(h)
    ranked = sorted(by_conv.values(), key=lambda hs: (-hs[0].score, -max(h.when for h in hs)))
    return [h for hs in ranked[:MAX_CONVERSATIONS] for h in sorted(hs, key=lambda h: h.when)]


def search(home: Path, cwd: str | Path, query: str, everything: bool = False) -> dict:
    """The results for an agent started in ``cwd``, in the order it should
    read them: {"level", "words", "facts": [...], "conversations": [...]}."""
    words = words_of(query)
    if not words:
        raise ValueError("Give at least one word to look for.")
    level = level_here(home, cwd)
    # A chat in ~ has the wide view (K4): nothing there is another project's.
    everything = everything or level == TOP
    store = Store(memory_root(home))
    order = _levels_up(level)
    rank = {lv: n for n, lv in enumerate(order)}

    def ranked(hits: list[Hit]) -> list[Hit]:
        return sorted(hits, key=lambda h: (rank.get(h.level, len(order)), -h.score, -h.when))

    def here(hits: list[Hit]) -> list[Hit]:
        return hits if everything else [h for h in hits if h.level in rank]

    current = _fact_hits(store, words, ("active",))
    facts = ranked(here(current))
    past = ranked(here(_fact_hits(store, words, PAST)))
    elsewhere = []
    if not everything and len(facts) < ENOUGH_HERE:
        elsewhere = sorted((h for h in current if h.level not in rank), key=lambda h: (-h.score, -h.when))
    exclude = {s for s in os.environ.get(EXCLUDE_ENV, "").split(",") if s}
    project = None if everything else level.split("/")[0]
    convs = _conversation_hits(home, words, project, exclude)
    log.info("Memory search at %r for %s: %d fact(s), %d past, %d elsewhere, %d conversation line(s)",
             level or "the owner", words, len(facts), len(past), len(elsewhere), len(convs))
    return {"level": level, "words": words, "everything": everything,
            "facts": facts[:MAX_FACTS], "more_facts": max(0, len(facts) - MAX_FACTS),
            "past": past[:MAX_PAST], "elsewhere": elsewhere[:MAX_ELSEWHERE],
            "conversations": convs}


def _where(level: str) -> str:
    return "the owner" if level == TOP else f"~/{level}"


def render(result: dict, today: date | None = None) -> str:
    """The results as an agent reads them in its terminal."""
    today = today or date.today()
    out = [f"Memory search for: {' '.join(result['words'])}   (you are at {_where(result['level'])})"]
    current = None
    for h in result["facts"]:
        if h.level != current:
            current = h.level
            out += ["", f"Facts, {_where(h.level)}:"]
        day = show_date(date.fromtimestamp(h.when).isoformat(), today, 60)
        out.append(f"- [{day}] {h.text}  ({h.where})")
    if result["more_facts"]:
        out.append(f"- {result['more_facts']} more matching fact(s); add words to narrow it.")
    if not result["facts"]:
        out += ["", "No fact in memory matches."]
    if result["past"]:
        out += ["", "No longer current (history: true then, check before relying on it):"]
        out += [f"- [{show_date(date.fromtimestamp(h.when).isoformat(), today, 60)}] {_where(h.level)}: "
                f"{h.text}  ({h.where})" for h in result["past"]]
    if result["elsewhere"]:
        out += ["", "Other projects (check it applies here before using it):"]
        out += [f"- [{show_date(date.fromtimestamp(h.when).isoformat(), today, 60)}] {_where(h.level)}: "
                f"{h.text}  ({h.where})" for h in result["elsewhere"]]
    scope = "every folder" if result["everything"] else "this project"
    if result["conversations"]:
        out += ["", f"Past conversations, {scope} (what was said; check it is still true):"]
        for h in result["conversations"]:
            out.append(f"- {datetime.fromtimestamp(h.when):%-d %b %Y}, {_where(h.level)}, {h.where}\n"
                       f"  {h.text}")
    else:
        out += ["", f"No past conversation in {scope} matches."]
    if result["elsewhere"]:
        out += ["", "Only other projects' best facts were shown. Add --all to search everything."]
    elif not result["everything"]:
        out += ["", "Other projects were not searched. Add --all to search everything."]
    return "\n".join(out)

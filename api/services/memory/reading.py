"""Reading conversations for the nightly job: complete, once, safe (K8).

One bookmark per conversation says how far it was read. A night reads what
is new behind each bookmark, oldest first, and moves a bookmark only when the
text behind it was handled. A conversation kept open for months is never read
again from its start.

What is read: what the owner and the agents wrote. Never tool output: a web
page or a file an agent opened cannot write memory. From tool calls only the
paths of the files touched are kept, to file a fact in the right folder.

Not read: sub-agents, compaction summaries (they restate text already read),
harness notices, the job's own runs and the exam's (they run under a hidden
folder), and scheduled runs. Nothing on disk marks a run as scheduled, so the
rule is: a headless run with a single message that is not a cockpit tab, and
whose opening is the same as another such run's. A script repeats itself; a
person who asks one question and closes the tab does not.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from api.services.memory.store import TOP, memory_root

log = logging.getLogger("shellteam.memory")

MAX_MESSAGE_CHARS = 8_000     # a longer message (a pasted document) keeps both ends
CATCH_UP_DAYS = 14            # how far back a conversation with no bookmark is read
# Scratch folders hold research and QA runs, not a project: what they teach is
# about the owner.
SCRATCH_FOLDERS = ("tmp",)
OPENINGS = "_openings"        # in the bookmarks file: openings of one-message headless runs
MIN_OPENING_CHARS = 60        # a shorter opening ("continue") says nothing about who sent it

# Lines a harness wrote in the owner's place: not something the owner said.
_NOT_THE_OWNER = (
    "<local-command", "<command-name>", "<command-message>", "<task-notification",
    "[Conversation compacted", "This session is being continued from a previous conversation",
    "[shellteam:session_event]", "<cockpit-notice", "Caveat: The messages below",
)
_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
_PATH_KEYS = ("file_path", "path", "notebook_path")


@dataclass
class Message:
    role: str            # "owner" | "agent"
    text: str
    ts: float
    end: object          # the bookmark position once this message is read
    paths: list[str] = field(default_factory=list)


@dataclass
class Conversation:
    key: str             # "<source>:<file path or session id>"
    source: str
    session_id: str
    cwd: str
    level: str           # the top-level folder it ran in; "" for ~ and scratch
    messages: list[Message] = field(default_factory=list)
    prompts: int = 0     # owner messages, the ones before the bookmark included
    headless: bool = False
    end: object = None   # how far the source was scanned

    @property
    def chars(self) -> int:
        return sum(len(m.text) for m in self.messages)


def bookmarks_path(home: Path) -> Path:
    return memory_root(home) / "bookmarks.json"


def load_bookmarks(home: Path) -> dict:
    path = bookmarks_path(home)
    return json.loads(path.read_text()) if path.exists() else {}


def save_bookmarks(home: Path, bookmarks: dict) -> None:
    path = bookmarks_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(bookmarks, indent=1))
    tmp.replace(path)


def clip(text: str) -> str:
    text = text.strip()
    if len(text) <= MAX_MESSAGE_CHARS:
        return text
    half = MAX_MESSAGE_CHARS // 2
    return f"{text[:half]}\n[… {len(text) - 2 * half:,} characters left out …]\n{text[-half:]}"


def owner_text(text: str) -> str:
    """What the owner typed in a user line, or "" when a harness wrote it."""
    text = _REMINDER_RE.sub("", text).strip()
    return "" if text.startswith(_NOT_THE_OWNER) else text


def _epoch(iso: object) -> float:
    if not isinstance(iso, str) or not iso:
        return 0.0
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def level_for(cwd: str, home: Path) -> str | None:
    """The level a conversation's facts are filed at by default: its top
    folder under home, or the owner ("") for home itself, outside it and a
    scratch folder. None under a hidden folder: the job's own runs and the
    exam's run there, so they are never read back."""
    try:
        parts = Path(os.path.normpath(cwd)).relative_to(os.path.normpath(home)).parts
    except ValueError:
        return TOP
    if any(p.startswith(".") for p in parts):
        return None
    return TOP if not parts or parts[0] in SCRATCH_FOLDERS else parts[0]


def _new_lines(path: Path, mark: dict | None, start: float):
    """Complete JSON lines behind the bookmark, with the offset after each.
    Without a bookmark the file is read from its first line newer than
    ``start``; older lines are skipped on their timestamp, unparsed."""
    offset = (mark or {}).get("offset", 0)
    if offset > path.stat().st_size:
        log.warning("Memory reading: %s is shorter than its bookmark; reading it by date", path)
        offset, mark, start = 0, None, (mark or {}).get("ts", start)
    start_iso = _iso(start).encode()
    with path.open("rb") as f:
        f.seek(offset)
        for raw in f:
            if not raw.endswith(b"\n"):
                return          # the torn last line of a live conversation: tomorrow
            offset += len(raw)
            if mark is None:
                at = raw.find(b'"timestamp":"')
                if at >= 0 and raw[at + 13:at + 32] <= start_iso:
                    continue
            try:
                yield json.loads(raw), offset
            except json.JSONDecodeError:
                log.warning("Memory reading: one unreadable line in %s", path)


def _not_read(line: dict) -> bool:
    return bool(line.get("isSidechain") or line.get("isMeta") or line.get("isCompactSummary"))


def claude_said(line: dict) -> tuple[str, str, float] | None:
    """(who, text, time) of a Claude Code transcript line the owner or the
    agent wrote, or None: tool output, sub-agents, summaries, harness lines."""
    if _not_read(line):
        return None
    content = (line.get("message") or {}).get("content")
    ts = _epoch(line.get("timestamp"))
    if line.get("type") == "user":
        if line.get("promptSource") == "system":
            return None
        if isinstance(content, list):
            content = "\n".join(b.get("text", "") for b in content
                                if isinstance(b, dict) and b.get("type") == "text")
        text = owner_text(content) if isinstance(content, str) else ""
        return ("owner", text, ts) if text else None
    if line.get("type") == "assistant" and isinstance(content, list):
        text = " ".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
        return ("agent", text, ts) if text else None
    return None


def codex_said(line: dict) -> tuple[str, str, float] | None:
    """(who, text, time) of a Codex rollout line the owner or the agent wrote."""
    payload = line.get("payload") or {}
    if line.get("type") != "event_msg" or not payload.get("message"):
        return None
    ts = _epoch(line.get("timestamp"))
    if payload.get("type") == "user_message":
        text = owner_text(payload["message"])
        return ("owner", text, ts) if text else None
    if payload.get("type") == "agent_message":
        return "agent", payload["message"], ts
    return None


def codex_meta(path: Path) -> dict:
    """The first line of a Codex rollout: the session's id, cwd and source."""
    with path.open() as f:
        return json.loads(f.readline() or "{}").get("payload") or {}


def is_codex_subagent(meta: dict) -> bool:
    return isinstance(meta.get("source"), dict) and "subagent" in meta["source"]


def _claude(home: Path, bookmarks: dict, start: float) -> list[Conversation]:
    out = []
    root = home / ".claude" / "projects"
    for path in sorted(root.glob("*/*.jsonl")) if root.is_dir() else []:
        key = f"claude:{path}"
        mark = bookmarks.get(key)
        size = path.stat().st_size
        if mark and size == mark.get("size"):
            continue
        if not mark and path.stat().st_mtime <= start:
            continue
        conv = Conversation(key, "claude", path.stem, "", TOP,
                            prompts=(mark or {}).get("prompts", 0), headless=True)
        for line, end in _new_lines(path, mark, start):
            conv.end = end
            conv.cwd = line.get("cwd") or conv.cwd
            said = claude_said(line)
            if said and said[0] == "owner":
                conv.prompts += 1
                conv.headless = conv.headless and line.get("entrypoint") == "sdk-cli"
            if said:
                conv.messages.append(Message(said[0], clip(said[1]), said[2], end))
            content = (line.get("message") or {}).get("content")
            if line.get("type") == "assistant" and isinstance(content, list) and not _not_read(line):
                paths = [str(b["input"][k]) for b in content if b.get("type") == "tool_use"
                         and isinstance(b.get("input"), dict) for k in _PATH_KEYS if b["input"].get(k)]
                if paths and conv.messages:
                    conv.messages[-1].paths += paths
        out.append(conv)
    return out


def _codex(home: Path, bookmarks: dict, start: float) -> list[Conversation]:
    out = []
    root = home / ".codex" / "sessions"
    for path in sorted(root.rglob("rollout-*.jsonl")) if root.is_dir() else []:
        key = f"codex:{path}"
        mark = bookmarks.get(key)
        if mark and path.stat().st_size == mark.get("size"):
            continue
        if not mark and path.stat().st_mtime <= start:
            continue
        # The first line names the session and says whether it is a sub-agent.
        meta = codex_meta(path)
        if is_codex_subagent(meta):
            continue
        conv = Conversation(key, "codex", meta.get("id") or meta.get("session_id") or path.stem,
                            meta.get("cwd") or "", TOP, prompts=(mark or {}).get("prompts", 0),
                            headless=True)
        for line, end in _new_lines(path, mark, start):
            conv.end = end
            if line.get("type") == "turn_context":
                conv.cwd = (line.get("payload") or {}).get("cwd") or conv.cwd
            said = codex_said(line)
            if said:
                conv.prompts += said[0] == "owner"
                conv.messages.append(Message(said[0], clip(said[1]), said[2], end))
        out.append(conv)
    return out


def _opencode(home: Path, bookmarks: dict, start: float) -> list[Conversation]:
    """OpenCode keeps everything in one database, opened read-only. The
    bookmark is the id of the last part read (ids only grow)."""
    db = home / ".local" / "share" / "opencode" / "opencode.db"
    out: list[Conversation] = []
    if not db.exists():
        return out
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    try:
        for sid, directory in conn.execute(
                "SELECT id, directory FROM session WHERE time_updated > ?", (int(start * 1000),)):
            key = f"opencode:{sid}"
            mark = bookmarks.get(key)
            conv = Conversation(key, "opencode", sid, directory or str(home), TOP,
                                prompts=(mark or {}).get("prompts", 0))
            rows = conn.execute(
                "SELECT p.id, m.data, p.data FROM part p JOIN message m ON p.message_id = m.id "
                "WHERE p.session_id = ? AND p.id > ? ORDER BY p.id", (sid, (mark or {}).get("offset", "")))
            for part_id, mdata, pdata in rows:
                conv.end = part_id
                m, p = json.loads(mdata), json.loads(pdata)
                ts = ((m.get("time") or {}).get("created") or 0) / 1000
                if p.get("type") != "text" or not p.get("text") or (not mark and ts and ts <= start):
                    continue
                role = "owner" if m.get("role") == "user" else "agent"
                text = owner_text(p["text"]) if role == "owner" else p["text"]
                if text:
                    conv.prompts += role == "owner"
                    conv.messages.append(Message(role, clip(text), ts, part_id))
            out.append(conv)
    finally:
        conn.close()
    return out


# --- agents' own memory notes (K15) -------------------------------------------------------
#
# Claude Code keeps notes per project (~/.claude/projects/<folder>/memory/*.md),
# Codex in ~/.codex/memories, Antigravity in ~/.gemini/antigravity-cli/knowledge.
# They are read like a conversation the agent wrote: a file is read again, whole, only when its content changed (its
# bookmark is the content's hash). Memory never writes them.

NOTE_INDEXES = ("MEMORY.md",)    # an index of the other notes: nothing of its own


def claude_dir_name(path: Path | str) -> str:
    """How Claude Code names the transcript directory of a folder."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def _folder_of_claude_dir(home: Path, name: str) -> str:
    """The folder a Claude Code project directory belongs to, as far as its
    name tells: a top folder of home, home itself, a hidden folder (its
    runs are never read), or "/" for anywhere else."""
    if name == claude_dir_name(home):
        return str(home)
    if name.startswith(claude_dir_name(home) + "--"):
        return str(home / ".hidden")
    best = ""
    for top in (p for p in home.iterdir() if p.is_dir() and not p.name.startswith(".")):
        enc = claude_dir_name(top)
        if (name == enc or name.startswith(enc + "-")) and len(enc) > len(claude_dir_name(home / best)):
            best = top.name
    return str(home / best) if best else "/"


def _note_files(home: Path) -> list[tuple[str, Path, str]]:
    """(source, file, folder) of every agent note on the box."""
    out = []
    claude = home / ".claude" / "projects"
    for path in sorted(claude.glob("*/memory/*.md")) if claude.is_dir() else []:
        if path.name not in NOTE_INDEXES:
            out.append(("claude-notes", path, _folder_of_claude_dir(home, path.parent.parent.name)))
    codex = home / ".codex" / "memories"
    for path in sorted(codex.rglob("*.md")) if codex.is_dir() else []:
        out.append(("codex-notes", path, str(home)))
    # Antigravity's "knowledge items". Empty on the owner's box on 2026-11-14,
    # so their layout is not observed yet: every markdown file under it.
    agy = home / ".gemini" / "antigravity-cli" / "knowledge"
    for path in sorted(agy.rglob("*.md")) if agy.is_dir() else []:
        out.append(("antigravity-notes", path, str(home)))
    return out


def _agent_notes(home: Path, bookmarks: dict, start: float) -> list[Conversation]:
    out = []
    for source, path, folder in _note_files(home):
        key = f"{source}:{path}"
        text = path.read_text(errors="replace").strip()
        digest = hashlib.sha1(text.encode()).hexdigest()[:16]
        if not text or (bookmarks.get(key) or {}).get("offset") == digest:
            continue
        conv = Conversation(key, source, path.stem, folder, TOP, end=digest)
        conv.messages.append(Message("agent", clip(text), path.stat().st_mtime, digest))
        out.append(conv)
    return out


def opening(conv: Conversation) -> str:
    """A fingerprint of a run's first message, numbers left out (a scheduled
    prompt often carries the date). "" when it is too short to tell."""
    first = next((m.text for m in conv.messages if m.role == "owner"), "")
    text = re.sub(r"[^a-z]+", "", first.lower())[:200]
    return hashlib.sha1(text.encode()).hexdigest()[:16] if len(text) >= MIN_OPENING_CHARS else ""


def _open_tabs(home: Path) -> set[str]:
    path = home / ".claude-chat-tabs.json"
    if not path.exists():
        return set()
    return {str(t.get("sessionId")) for t in json.loads(path.read_text()) if t.get("sessionId")}


@dataclass
class Reading:
    conversations: list[Conversation] = field(default_factory=list)
    automated: list[Conversation] = field(default_factory=list)   # held back, not read
    hidden: int = 0                                               # ran under a hidden folder
    failed_sources: list[str] = field(default_factory=list)
    marks: dict = field(default_factory=dict)     # bookmarks for what needs no reading


def gather(home: Path, bookmarks: dict, start: float) -> Reading:
    """Every conversation with text behind its bookmark. ``start`` is where a
    conversation that has no bookmark yet is read from."""
    reading = Reading()
    tabs = _open_tabs(home)
    openings: dict[str, str] = dict(bookmarks.get(OPENINGS) or {})
    single: list[Conversation] = []       # one-message headless runs, not a tab
    for name, fn in (("claude", _claude), ("codex", _codex), ("opencode", _opencode),
                     ("agents' own notes", _agent_notes)):
        try:
            found = fn(home, bookmarks, start)
        except Exception:
            # One broken source must not stop the night, and must be seen.
            log.exception("Memory reading FAILED for %s; the night goes on without it", name)
            reading.failed_sources.append(name)
            continue
        for conv in found:
            level = level_for(conv.cwd, home) if conv.cwd else None
            old = bookmarks.get(conv.key) or {}
            skipped = {"offset": conv.end if conv.end is not None else old.get("offset", 0),
                       "ts": old.get("ts", start), "prompts": conv.prompts, "size": file_size(conv)}
            if level is None or not conv.messages:
                # Nothing here to read: scanned once, opened again only when it grows.
                reading.hidden += level is None and bool(conv.messages)
                reading.marks[conv.key] = skipped
            else:
                conv.level = level
                if conv.headless and conv.prompts <= 1 and conv.session_id not in tabs and opening(conv):
                    single.append(conv)
                else:
                    reading.conversations.append(conv)
        log.info("Memory reading: %s, %d conversation(s) with new text", name, len(found))

    seen: dict[str, int] = {}
    for conv in single:
        seen[opening(conv)] = seen.get(opening(conv), 0) + 1
    for conv in single:
        mark = opening(conv)
        if seen[mark] > 1 or openings.get(mark, conv.session_id) != conv.session_id:
            # Held, not passed over: a second message from the owner makes it
            # a conversation, and it is then read from its start.
            old = bookmarks.get(conv.key) or {}
            reading.automated.append(conv)
            reading.marks[conv.key] = {"offset": old.get("offset", 0), "ts": old.get("ts", start),
                                       "prompts": old.get("prompts", 0), "size": file_size(conv),
                                       "held": True}
        else:
            reading.conversations.append(conv)
        openings.setdefault(mark, conv.session_id)
    reading.marks[OPENINGS] = openings
    return reading


def bookmark_after(conv: Conversation, message: Message, path_size: int | None = None) -> dict:
    """The bookmark once ``message`` is read. ``size`` is set only when the
    whole new text was read: an unchanged file is then skipped unopened."""
    prompts = conv.prompts - sum(1 for m in conv.messages
                                 if m.role == "owner" and m.ts > message.ts)
    mark = {"offset": message.end, "ts": message.ts, "prompts": prompts}
    if path_size is not None and message is conv.messages[-1]:
        mark["size"] = path_size
    return mark


def file_size(conv: Conversation) -> int | None:
    if conv.source == "opencode":
        return None
    return Path(conv.key.split(":", 1)[1]).stat().st_size


def unread_sources(home: Path) -> list[str]:
    """Sources that exist on this box and cannot be read yet."""
    if (home / ".gemini" / "antigravity").is_dir():
        return ["Antigravity conversations (stored in a binary form)"]
    return []

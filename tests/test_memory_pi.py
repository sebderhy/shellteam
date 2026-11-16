"""Pi's own session files are read like Claude Code's and Codex's transcripts:
by the nightly memory job (reading.py), by the search every agent runs
(search.py) and to date a cockpit chat (told.py).

The fixture follows Pi's documented format (docs/session-format.md and
docs/message-types.md of @earendil-works/pi-coding-agent): a header line, then
one ``message`` entry per message.
"""

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from api.services.memory import reading, search, told

NOW = time.time()


def _iso(ago: float) -> str:
    return datetime.fromtimestamp(NOW - ago, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _entry(message: dict, ago: float) -> dict:
    return {"type": "message", "id": f"{int(ago):08x}", "parentId": None,
            "timestamp": _iso(ago), "message": message}


def pi_owner(text: str, ago: float = 100) -> dict:
    return _entry({"role": "user", "content": text, "timestamp": 0}, ago)


def pi_agent(text: str, ago: float = 90, tool_calls: list[dict] | None = None) -> dict:
    content = [{"type": "thinking", "thinking": "private reasoning about nautilus"},
               {"type": "text", "text": text}]
    content += [{"type": "toolCall", "id": f"c{n}", "name": c["name"], "arguments": c["arguments"]}
                for n, c in enumerate(tool_calls or [])]
    return _entry({"role": "assistant", "content": content, "model": "glm", "timestamp": 0}, ago)


def pi_tool_result(text: str, ago: float = 80) -> dict:
    return _entry({"role": "toolResult", "toolCallId": "c0", "toolName": "read",
                   "content": [{"type": "text", "text": text}], "isError": False, "timestamp": 0}, ago)


def write_pi_session(home: Path, cwd: Path, session: str, lines: list[dict], ago: float = 200) -> Path:
    """A session file where Pi puts it: ``--<cwd, / as ->--/<time>_<id>.jsonl``."""
    folder = "--" + str(cwd).lstrip("/").replace("/", "-") + "--"
    path = reading.pi_sessions_root(home) / folder / f"2026-11-16T10-00-00-000Z_{session}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    header = {"type": "session", "version": 3, "id": session, "timestamp": _iso(ago), "cwd": str(cwd)}
    system = _entry({"role": "system", "content": "", "sections": {"preamble": "nautilus system"},
                     "timestamp": 0}, ago)
    path.write_text("\n".join(json.dumps(l) for l in [header, system, *lines]) + "\n")
    return path


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.delenv("SHELLTEAM_MEMORY_ROOT", raising=False)
    monkeypatch.delenv(search.EXCLUDE_ENV, raising=False)
    for folder in ("shellteam", "orchard"):
        (tmp_path / folder).mkdir()
    return tmp_path


def _chat(home: Path) -> Path:
    return write_pi_session(home, home / "shellteam", "pi-1111", [
        pi_owner("From now on the nautilus logo stays in the header."),
        pi_agent("Noted: the nautilus logo stays.",
                 tool_calls=[{"name": "edit", "arguments": {"path": "web/header.html", "edits": []}},
                             {"name": "bash", "arguments": {"command": "ls"}}]),
        pi_tool_result("nautilus logo found in a fetched web page"),
        pi_owner("<system-reminder>harness</system-reminder>Keep it small.", ago=70),
    ])


def test_the_night_reads_what_the_owner_and_the_agent_wrote_and_nothing_else(home):
    path = _chat(home)
    found = [c for c in reading.gather(home, {}, NOW - 3600).conversations if c.source == "pi"]
    assert len(found) == 1
    conv = found[0]
    assert conv.key == f"pi:{path}"
    assert conv.session_id == "pi-1111"
    assert conv.cwd == str(home / "shellteam") and conv.level == "shellteam"
    assert [(m.role, m.text) for m in conv.messages] == [
        ("owner", "From now on the nautilus logo stays in the header."),
        ("agent", "Noted: the nautilus logo stays."),
        ("owner", "Keep it small."),
    ]
    # Only the paths a tool call touched: never its output, never the thinking.
    assert conv.messages[1].paths == ["web/header.html"]
    assert conv.prompts == 2
    assert reading.file_size(conv) == path.stat().st_size


def test_a_second_night_reads_only_what_is_new(home):
    path = _chat(home)
    conv = next(c for c in reading.gather(home, {}, NOW - 3600).conversations if c.source == "pi")
    bookmarks = {conv.key: reading.bookmark_after(conv, conv.messages[-1], path.stat().st_size)}
    assert not [c for c in reading.gather(home, bookmarks, NOW - 3600).conversations if c.source == "pi"]

    with path.open("a") as f:
        f.write(json.dumps(pi_owner("And the footer keeps the old logo.", ago=10)) + "\n")
    again = next(c for c in reading.gather(home, bookmarks, NOW - 3600).conversations if c.source == "pi")
    assert [m.text for m in again.messages] == ["And the footer keeps the old logo."]


def test_a_session_under_a_hidden_folder_is_never_read(home):
    write_pi_session(home, home / ".shellteam" / "dream", "pi-dream", [pi_owner("nautilus in a dream prompt")])
    assert not [c for c in reading.gather(home, {}, NOW - 3600).conversations if c.source == "pi"]


def test_search_finds_pi_conversations_of_this_project_only(home):
    _chat(home)
    write_pi_session(home, home / "orchard", "pi-2222", [pi_owner("The nautilus logo is not for Orchard.")])
    result = search.search(home, home / "shellteam", "nautilus logo")
    said = sorted(h.text for h in result["conversations"])
    assert said == ["the agent: Noted: the nautilus logo stays.",
                    "the owner: From now on the nautilus logo stays in the header."]
    assert all(h.where == "Pi conversation pi-1111" for h in result["conversations"])
    everything = search.search(home, home / "shellteam", "nautilus logo", everything=True)
    assert any("Orchard" in h.text for h in everything["conversations"])


def test_a_pi_cockpit_chat_starts_at_its_session_header(home):
    write_pi_session(home, home / "shellteam", "pi-3333", [pi_owner("hello")], ago=500)
    tab = {"sessionId": "pi-3333", "sessionFamily": "pi", "createdAt": 1000}
    assert told.chat_start(home, tab) == pytest.approx(NOW - 500, abs=1)

"""What an agent sitting the recall exam may not touch.

The exam asks a freshly opened agent about things said in recent
conversations. If the agent could read those conversations it would be
reading the answer key, so every conversation store is out of reach. The
agent also may not write files or call outside services: an exam run must
leave the box as it found it.

Used two ways: as a Claude Code ``PreToolUse`` hook (``python3 this_file``,
tool call on stdin, exit 2 refuses it) and as a library (``reason_blocked``)
to audit the commands of agents that have no such hook.

Environment: ``EXAM_OWN_MEMORY=1`` leaves the agent's own notes readable (the
arm that measures them); ``EXAM_SHELLTEAM_MEMORY=0`` also closes ShellTeam's
memory folders (the memory-off arm).
"""

from __future__ import annotations

import json
import os
import re
import sys

REFUSAL = "Not available in this session."

_WRITE_TOOLS = {"Write", "Edit", "NotebookEdit", "MultiEdit"}
_OUTSIDE_TOOLS = {"Agent", "Task", "WebFetch", "WebSearch"}

_HOME = r"(?:~|\$HOME|/home/[^/\s\"']+|/root)"
_CONVERSATION_STORES = (
    r"\.codex/sessions",
    r"\.codex/history",
    r"\.claude/history",
    r"\.claude/file-history",
    r"\.pi/agent/sessions",
    r"\.gemini",
    rf"{_HOME}/conversations\b",
    r"\.shellteam/(?:exam|dream)\b",
    # The exam's own reports in ~/reports show questions with their keys.
    r"memory-exam-",
)
_CLAUDE_PROJECTS = r"\.claude/projects"
_CLAUDE_OWN_NOTES = r"\.claude/projects/[^/\s\"']+/memory\b"
_SHELLTEAM_MEMORY = r"\.shellteam/memory\b|shellteam-memory\b"


def reason_blocked(tool_name: str, tool_input: object, env: dict | None = None) -> str:
    """Why this tool call is refused during an exam, or "" when it may run."""
    env = os.environ if env is None else env
    if tool_name in _WRITE_TOOLS:
        return "file writes are off during an exam"
    if tool_name in _OUTSIDE_TOOLS or tool_name.startswith("mcp__"):
        return "outside tools are off during an exam"
    text = tool_input if isinstance(tool_input, str) else json.dumps(tool_input)
    for pattern in _CONVERSATION_STORES:
        if re.search(pattern, text):
            return "conversation stores are out of reach"
    if re.search(_CLAUDE_PROJECTS, text):
        own_notes_only = not re.search(_CLAUDE_PROJECTS, re.sub(_CLAUDE_OWN_NOTES, "", text))
        if not (own_notes_only and env.get("EXAM_OWN_MEMORY") == "1"):
            return "conversation stores are out of reach"
    if env.get("EXAM_SHELLTEAM_MEMORY") == "0" and re.search(_SHELLTEAM_MEMORY, text):
        return "memory is off in this arm"
    return ""


def main() -> int:
    call = json.load(sys.stdin)
    if reason_blocked(call.get("tool_name", ""), call.get("tool_input", {})):
        print(REFUSAL, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

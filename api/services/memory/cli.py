"""``shellteam-memory``: what every agent on the box can do with memory.

  shellteam-memory search WORDS... [--all]
      Look further than the launch text: this folder's facts, the levels
      above, then past conversations of this project from every agent.
      --all: every project.
  shellteam-memory note TEXT...
      Leave a note for the next chats started in this folder today. The
      nightly job files it into memory, or leaves it out, and says why.

Agents do not edit memory files. The owner edits memory in the Knowledge tab.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from api.services.memory import notes, search


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="shellteam-memory", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    s = sub.add_parser("search", help="look further than the launch text")
    s.add_argument("words", nargs="+")
    s.add_argument("--all", action="store_true", help="search every project, not only this one")
    n = sub.add_parser("note", help="leave a note for the next chats in this folder")
    n.add_argument("text", nargs="+")
    args = ap.parse_args(argv)

    home, cwd = Path.home(), Path(os.getcwd())
    try:
        if args.command == "search":
            print(search.render(search.search(home, cwd, " ".join(args.words), everything=args.all)))
        else:
            note = notes.add(home, cwd, " ".join(args.text), agent=_agent())
            where = "~" if not note["level"] else f"~/{note['level']}"
            print(f"Noted for chats started in {where} today. The nightly job files it.")
    except ValueError as e:
        print(f"shellteam-memory: {e}", file=sys.stderr)
        return 2
    return 0


def _agent() -> str:
    if os.environ.get("CLAUDECODE"):
        return "claude"
    if any(k.startswith("CODEX_") for k in os.environ):
        return "codex"
    return ""


if __name__ == "__main__":
    sys.exit(main())

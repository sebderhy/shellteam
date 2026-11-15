"""What the Knowledge tab shows (K17b): the tree with how full each level is,
and a night's changes with what has been undone since.

Read-only: changes go through ``nightly.undo_night`` / ``undo_change`` and
the owner's view edits (``views.take_in_hand_edits``).
"""

from __future__ import annotations

import json
from pathlib import Path

from api.services import dreaming
from api.services.memory import notes, told, views
from api.services.memory.store import TOP, Store, load_settings, memory_root

CHANGES = ("added", "replaced", "merged", "moved", "retired")


def _view(root: Path, path: Path, limit: int | None) -> dict | None:
    if not path.exists():
        return None
    return {"path": str(path.relative_to(views.views_dir(root))), "chars": len(path.read_text()),
            "limit": limit}


def levels(home: Path) -> list[dict]:
    """Every level, the owner first: its card and essentials with their size
    and limit, its record pages, how many facts it holds, today's notes."""
    root = memory_root(home)
    store = Store(root)
    limits = load_settings(root)["limits"]
    waiting = notes.load(root)
    out = []
    # A sub-area right under its project: "shellteam", "shellteam/cockpit", "shellteam-cloud".
    for level in sorted(store.levels(), key=lambda l: (l != TOP, l.split("/"))):
        directory = views.level_dir(root, level)
        top = level == TOP
        card_limit = views.card_limit(limits, level)
        records = sorted(
            ({"topic": p.stem.replace("-", " "), "path": str(p.relative_to(views.views_dir(root))),
              "facts": max(0, len(p.read_text().splitlines()) - 1)}
             for p in (directory / "record").glob("*.md")),
            key=lambda r: -r["facts"])
        out.append({
            "level": level, "where": told.where(level),
            "card": _view(root, directory / "card.md", card_limit),
            "essentials": _view(root, directory / "essentials.md",
                                limits["top_essentials" if top else "project_essentials"]),
            "records": records, "facts": len(store.at_level(level)),
            "notes": sum(1 for n in waiting if n["level"] == level),
        })
    return out


def nights(home: Path, limit: int = 10) -> list[dict]:
    """The latest nights of the knowledge tree, newest first."""
    runs = dreaming.dream_dir(home) / "runs"
    out = []
    for run_file in sorted(runs.glob("2*/run.json"), reverse=True) if runs.is_dir() else []:
        summary = json.loads(run_file.read_text())
        if summary.get("memory") != "tree" or summary.get("preview"):
            continue
        out.append({"run": summary["run"], "status": summary["status"],
                    "report": Path(summary["report"]).name if summary.get("report") else None,
                    "new_facts": summary.get("new_facts", 0)})
        if len(out) == limit:
            break
    return out


def _undone(home: Path, run: str) -> tuple[set[str], bool]:
    """The facts (and split folders) whose change of ``run`` was undone one
    by one, and whether the whole night was undone."""
    path = memory_root(home) / "ops.jsonl"
    entries = [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []
    mine = [e for e in entries if e["run"] == run]
    one_by_one = {r.get("id") or r.get("split") for e in mine for r in e["results"]
                  if r.get("undone") and (r.get("id") or r.get("split"))}
    return one_by_one, bool(mine) and all(e.get("undone") for e in mine)


def night(home: Path, run: str) -> dict:
    """One night's changes per level, each with its fact id and whether it
    has been undone since."""
    path = dreaming.dream_dir(home) / "runs" / run / "run.json"
    if not path.exists() or "/" in run or ".." in run:
        raise KeyError(f"no night {run}")
    summary = json.loads(path.read_text())
    one_by_one, whole = _undone(home, run)
    levels_out = {}
    for name, info in summary.get("levels", {}).items():
        level = "" if name == "owner" else name
        entry = {key: [{**item, "undone": whole or item.get("id") in one_by_one}
                       for item in info.get(key, [])] for key in CHANGES}
        entry["not_kept"] = info.get("not_kept", [])
        entry["confirmed"] = len(info.get("confirmed", []))
        entry["untouched"] = info.get("untouched", [])
        split = info.get("split")
        entry["split"] = ({**split, "undone": whole or split["folder"] in one_by_one}
                          if split and split.get("folder") else None)
        levels_out[level] = entry
    return {"run": run, "status": summary["status"], "undone": whole,
            "report": Path(summary["report"]).name if summary.get("report") else None,
            "read": summary.get("read"), "seconds": summary.get("seconds"),
            "not_read": summary.get("not_read", {}).get("sources", []), "levels": levels_out}

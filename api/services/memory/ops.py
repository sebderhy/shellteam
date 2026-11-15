"""Operations: the only way a model changes memory.

The model chooses (add, confirm, replace, merge, move, card, retire) and
refers to existing facts by id; this code checks and writes. A level whose
operations fail any check is left exactly as it was. Every applied operation
is logged with the facts as they were before, so one change or a whole night
can be undone.
"""

from __future__ import annotations

import copy
import difflib
import json
import logging
import re
from dataclasses import asdict
from datetime import date

from api.services.memory.store import KINDS, PARTS, TOP, Fact, Store, level_of, unsafe_reason

log = logging.getLogger("shellteam.memory")

OPS = ("add", "confirm", "replace", "merge", "move", "card", "retire", "split")
SAME_FACT = 0.85            # how alike a new sentence and a removed one must be
MAX_CARD_LOSS = 0.25        # of a card's lines one run may take off it
MIN_SPLIT = 6               # facts a group needs before its sub-folder earns a card (K18)


class OpError(ValueError):
    """An operation failed a check; the level it belongs to is left untouched."""


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", text.lower()).strip()


def same_fact(a: str, b: str) -> bool:
    a, b = _norm(a), _norm(b)
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() >= SAME_FACT


def removed_by_owner(store: Store, level: str, text: str) -> Fact | None:
    """The fact the owner removed at this level that says the same thing."""
    levels = store.levels() | {level}
    for f in store.facts.values():
        if f.status == "removed" and level_of(f.folder, levels) == level and same_fact(f.text, text):
            return f
    return None


def _on_branch(level: str, folder: str) -> bool:
    """A fact may move up or down its own branch, never into another project."""
    if level == TOP or folder == TOP:
        return True
    return folder.split("/")[0] == level.split("/")[0]


def apply_ops(store: Store, level: str, ops: list[dict], *, run: str,
              today: date | None = None, strict: bool = True,
              max_card_loss: float | None = MAX_CARD_LOSS,
              card_base: set[str] | None = None) -> list[dict]:
    """Apply one level's operations, all or none. Returns one entry per
    operation saying what happened ("applied", or "skipped" with the reason).

    ``strict``: a new sentence that is unsafe to show an agent fails the level
    (a model run); otherwise it is stored blocked (the one-time move of the
    owner's own notes). ``max_card_loss``: the share of the card's lines the
    run may take off it; None for owner actions and the one-time move.
    ``card_base``: the card's facts when the night began, when a night
    places a level in several passes: the loss is counted against that.
    """
    today_iso = (today or date.today()).isoformat()
    before = copy.deepcopy(store.facts)
    subareas_before = set(store.subareas)
    levels = store.levels() | {level}
    card_before = card_base if card_base is not None else (
        {f.id for f in store.at_level(level) if f.on_card} if level in store.levels() else set())
    results: list[dict] = []

    def own(fid: object, op: str) -> Fact:
        fact = store.facts.get(fid) if isinstance(fid, str) else None
        if fact is None:
            raise OpError(f"unknown fact id {fid!r} in {op}")
        if not fact.active:
            raise OpError(f"fact {fid} is {fact.status}, not active ({op})")
        if level_of(fact.folder, levels) != level:
            raise OpError(f"fact {fid} belongs to another level ({op})")
        return fact

    def create(op: dict, like: Fact | None = None) -> Fact | None:
        text = " ".join(str(op.get("text") or "").split())
        folder = str(op.get("folder", like.folder if like else level)).strip("/")
        if not _on_branch(level, folder):
            raise OpError(f"{op['op']} would file a fact in another project ({folder!r})")
        kind = op.get("kind") or (like.kind if like else None)
        if kind not in KINDS:
            raise OpError(f"unknown kind {kind!r} in {op['op']}")
        part = op.get("part", like.part if like else "")
        if part not in ("", *PARTS):
            raise OpError(f"unknown card part {part!r}")
        if strict and (reason := unsafe_reason(text)):
            raise OpError(f"new sentence {reason}")
        if not text:
            raise OpError(f"{op['op']} without a sentence")
        source = op.get("source")
        if not isinstance(source, dict) or source.get("type") not in (
                "conversation", "owner", "old-knowledge", "agent-notes"):
            raise OpError(f"{op['op']} without a source the owner or an agent wrote")
        essential = bool(op.get("essential", like.essential if like else False))
        return store.add(
            text=text, kind=kind, folder=folder,
            topic=op.get("topic") or (like.topic if like else "general"),
            source=source, seen=op.get("seen") or today_iso,
            on_card=bool(op.get("card", like.on_card if like else False)) or essential,
            essential=essential, part=part)

    try:
        for op in ops:
            name = op.get("op")
            if name not in OPS:
                raise OpError(f"unknown operation {name!r}")
            entry: dict = {"op": name, "what": "applied"}
            if name == "add":
                gone = removed_by_owner(store, level_of(str(op.get("folder", level)).strip("/"), levels),
                                        str(op.get("text") or ""))
                if gone:
                    entry.update(what="skipped", why="the owner removed this", id=gone.id)
                else:
                    entry["id"] = create(op).id
            elif name == "confirm":
                fact = own(op.get("id"), name)
                fact.last_confirmed = max(fact.last_confirmed, op.get("seen") or today_iso)
                if isinstance(op.get("source"), dict):
                    fact.sources.append(op["source"])
                entry["id"] = fact.id
            elif name == "replace":
                old = own(op.get("id"), name)
                if old.pinned:
                    entry.update(what="skipped", why="the owner pinned this fact", id=old.id)
                else:
                    new = create(op, like=old)
                    new.first_seen = min(old.first_seen, new.first_seen)
                    old.status, old.replaced_by, old.on_card, old.essential = "replaced", new.id, False, False
                    entry.update(id=new.id, replaced=old.id)
            elif name == "merge":
                ids = op.get("ids")
                if not isinstance(ids, list) or len(set(ids)) < 2:
                    raise OpError("merge needs two or more fact ids")
                facts = [own(i, name) for i in dict.fromkeys(ids)]
                pinned = [f for f in facts if f.pinned]
                if len(pinned) > 1:
                    entry.update(what="skipped", why="two pinned facts cannot be merged")
                else:
                    if op.get("text") and not pinned:
                        keep = create(op, like=max(facts, key=lambda f: f.last_confirmed))
                        keep.on_card = keep.on_card or any(f.on_card for f in facts)
                    else:
                        keep = pinned[0] if pinned else own(op.get("into", facts[0].id), name)
                    rest = [f for f in facts if f.id != keep.id]
                    keep.first_seen = min(f.first_seen for f in [keep, *rest])
                    keep.last_confirmed = max(f.last_confirmed for f in [keep, *rest])
                    keep.sources += [s for f in rest for s in f.sources if s not in keep.sources]
                    keep.on_card = keep.on_card or any(f.on_card for f in rest)
                    keep.essential = keep.essential or any(f.essential for f in rest)
                    for f in rest:
                        f.status, f.replaced_by, f.on_card, f.essential = "replaced", keep.id, False, False
                    entry.update(id=keep.id, replaced=[f.id for f in rest])
            elif name == "move":
                fact = own(op.get("id"), name)
                folder = str(op.get("folder", "")).strip("/")
                if not _on_branch(level, folder):
                    raise OpError(f"move of {fact.id} into another project ({folder!r})")
                joins = levels | ({folder.split("/")[0]} if folder else set())
                if level_of(folder, joins) != level:
                    fact.on_card = fact.essential = False   # the level it joins decides
                fact.folder = folder
                entry.update(id=fact.id, folder=folder)
            elif name == "card":
                fact = own(op.get("id"), name)
                on = bool(op.get("on"))
                if fact.pinned and not on:
                    entry.update(what="skipped", why="the owner pinned this fact", id=fact.id)
                else:
                    fact.on_card = on
                    fact.essential = on and bool(op.get("essential", fact.essential))
                    if op.get("part") in PARTS:
                        fact.part = op["part"]
                    entry["id"] = fact.id
            elif name == "split":
                entry.update(split(store, level, op, own))
            elif name == "retire":
                fact = own(op.get("id"), name)
                if fact.pinned:
                    entry.update(what="skipped", why="the owner pinned this fact", id=fact.id)
                else:
                    fact.status, fact.on_card, fact.essential = "retired", False, False
                    entry["id"] = fact.id
            results.append(entry)

        if max_card_loss is not None and card_before:
            still = {f.id for f in store.facts.values() if f.active and f.on_card
                     and level_of(f.folder, levels) == level}
            def stands_in(fid: str) -> bool:
                """A line replaced or merged is not lost when the fact that
                stands for it is on the card."""
                seen = set()
                while fid in store.facts and fid not in seen and store.facts[fid].replaced_by:
                    seen.add(fid)
                    fid = store.facts[fid].replaced_by
                return fid in still

            lost = sum(1 for fid in card_before - still if not stands_in(fid))
            if lost > max(1, int(len(card_before) * max_card_loss)):
                raise OpError(f"{lost} of {len(card_before)} card lines taken off in one run "
                              f"(at most a quarter)")
    except OpError:
        _put_back(store, before)
        store.subareas = subareas_before
        raise

    changed = [fid for fid, f in store.facts.items() if before.get(fid) != f]
    with (store.root / "ops.jsonl").open("a") if store.root.exists() else _mkdir_open(store) as log_file:
        log_file.write(json.dumps({
            "run": run, "level": level, "date": today_iso, "results": results,
            "before": {fid: asdict(before[fid]) if fid in before else None for fid in changed},
        }) + "\n")
    log.info("Memory ops for %r (run %s): %d applied, %d skipped", level or "the owner", run,
             sum(r["what"] == "applied" for r in results), sum(r["what"] == "skipped" for r in results))
    return results


def split(store: Store, level: str, op: dict, own) -> dict:
    """A sub-folder of ``level`` gets a card of its own (K18): the group of
    facts about it moves down, and the lines of the parent's card that hold
    for the whole level become its essentials, which the sub-area's chats
    receive above their own card."""
    folder = str(op.get("folder") or "").strip("/")
    if level == TOP or not folder.startswith(level + "/"):
        raise OpError(f"split into {folder!r}: not a sub-folder of {level or 'the owner'!r}")
    if any(p.startswith(".") for p in folder.split("/")) or folder[len(level) + 1:].split("/")[0] == "record":
        raise OpError(f"split into {folder!r}: a hidden folder, or one named like a record folder")
    if folder in store.subareas:
        raise OpError(f"{folder!r} already has a card")
    ids = op.get("ids")
    if not isinstance(ids, list) or len(set(ids)) < MIN_SPLIT:
        raise OpError(f"a split needs a group of at least {MIN_SPLIT} facts")
    group = [own(i, "split") for i in dict.fromkeys(ids)]
    essentials = [own(i, "split") for i in dict.fromkeys(op.get("essentials") or [])]
    if {f.id for f in essentials} & {f.id for f in group}:
        raise OpError("a fact cannot both move down and be an essential of the level above")
    for f in group:
        if not (f.folder == folder or f.folder.startswith(folder + "/")):
            f.folder = folder
        f.essential = False     # the sub-area has no level below it yet
    for f in essentials:
        f.on_card = f.essential = True
    store.subareas.add(folder)
    return {"split": folder, "ids": [f.id for f in group], "essentials": [f.id for f in essentials]}


def _put_back(store: Store, before: dict[str, Fact]) -> None:
    """Every fact as it was, in place: whoever holds a fact sees it restored."""
    for fid in list(store.facts):
        if fid not in before:
            del store.facts[fid]
        else:
            store.facts[fid].__dict__.update(copy.deepcopy(before[fid].__dict__))


def _mkdir_open(store: Store):
    store.root.mkdir(parents=True, exist_ok=True)
    return (store.root / "ops.jsonl").open("a")


def undo_change(store: Store, run: str, fact_id: str) -> bool:
    """Put back the facts one operation of a run touched (the fact it wrote
    and the ones it replaced). The log entry is marked."""
    path = store.root / "ops.jsonl"
    entries = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    for entry in reversed(entries):
        if entry["run"] != run:
            continue
        for result in entry["results"]:
            if result.get("id") != fact_id or result.get("undone") or result["what"] != "applied":
                continue
            replaced = result.get("replaced") or []
            for fid in [fact_id, *([replaced] if isinstance(replaced, str) else replaced)]:
                was = entry["before"].get(fid, "untouched")
                if was is None:
                    store.facts.pop(fid, None)
                elif was != "untouched":
                    store.facts[fid] = Fact(**was)
            result["undone"] = True
            path.write_text("".join(json.dumps(e) + "\n" for e in entries))
            log.info("Memory: one change of run %s undone (%s)", run, fact_id)
            return True
    return False


def undo_run(store: Store, run: str) -> int:
    """Put back every fact a run changed, newest change first. Returns how
    many log entries were undone. The entries stay in the log, marked."""
    path = store.root / "ops.jsonl"
    entries = [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []
    undone = 0
    for entry in reversed(entries):
        if entry["run"] != run or entry.get("undone"):
            continue
        for fid, was in entry["before"].items():
            if was is None:
                store.facts.pop(fid, None)
            else:
                store.facts[fid] = Fact(**was)
        for result in entry["results"]:
            if result.get("split") and not result.get("undone"):
                store.subareas.discard(result["split"])
        entry["undone"] = True
        undone += 1
    if undone:
        path.write_text("".join(json.dumps(e) + "\n" for e in entries))
        log.info("Memory: run %s undone (%d level change(s))", run, undone)
    return undone


def undo_split(store: Store, run: str, folder: str) -> bool:
    """Put back one split: its facts return to the level above, the
    essentials it chose are unmarked, and the sub-folder has no card."""
    path = store.root / "ops.jsonl"
    entries = [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []
    for entry in reversed(entries):
        if entry["run"] != run or entry.get("undone"):
            continue
        for result in entry["results"]:
            if result.get("split") != folder or result.get("undone"):
                continue
            for fid in [*result["ids"], *result["essentials"]]:
                was = entry["before"].get(fid)
                if was is not None:
                    store.facts[fid] = Fact(**was)
            store.subareas.discard(folder)
            result["undone"] = True
            path.write_text("".join(json.dumps(e) + "\n" for e in entries))
            log.info("Memory: the split of %s in run %s undone", folder, run)
            return True
    return False

"""The one-time move: the old knowledge files become facts, cards and records.

Run once per box, on its first night (``switch.move_in``). The old files are
only read, never written; they are kept 30 days. A stopped move is picked up
again: it takes in only the old lines it has not seen.

Three stages, each a narrow model decision with code doing the writing:
  A  per old line: keep (as one or more short facts), retire, or drop, with a
     kind, a topic and the folder it is really about
  B  per level: which facts say the same thing (merge)
  C  per level: which facts go on the card and the essentials
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path

from api.services import dreaming
from api.services.memory import ops, views
from api.services.memory.store import KINDS, TOP, Fact, Store, load_settings, memory_root

log = logging.getLogger("shellteam.memory")

# A fact is never lost over a label: the kinds a model writes when it does
# not use ours, read as the nearest of ours.
_KIND_WORDS = {**{k: k for k in KINDS}, "preference": "rule", "trap": "rule", "gotcha": "rule",
               "convention": "rule", "feedback": "correction", "goal": "state", "status": "state",
               "contact": "person", "people": "person", "path": "reference", "fact": "reference"}

BATCH_LINES = 50
MERGE_CHUNK = 220
OLD_TEXT_CHARS = 700
UNDATED = "2026-07-01"      # before the change log's first entry

TOP_TOPICS = ("career", "ventures", "people", "preferences", "working style", "finances",
              "personal", "tools")
PROJECT_TOPICS = ("product", "release", "security", "infrastructure", "testing", "design",
                  "marketing", "pricing", "agents", "integrations", "data", "people", "process")


@dataclass
class OldLine:
    rid: str
    file: str        # path under ~/.shellteam/knowledge
    level: str       # "" for the owner files, else the node the file belongs to
    section: str
    text: str
    seen: str        # YYYY-MM-DD

    @property
    def key(self) -> str:
        return hashlib.sha1(f"{self.file}|{self.text}".encode()).hexdigest()[:16]


# --- reading the old files -----------------------------------------------------------
#
# The knowledge files the old nightly job wrote: the owner's five files, then
# one folder per project with an index and detail pages. Read once, by the
# move; nothing writes them any more.

OWNER_FILES = ("identity.md", "preferences.md", "feedback.md", "projects.md", "contacts.md")


def old_dir(home: Path) -> Path:
    return home / ".shellteam" / "knowledge"


def _old_nodes(home: Path) -> list[str]:
    tree = old_dir(home) / "tree"
    return sorted(str(p.parent.relative_to(tree)) for p in tree.rglob("index.md")) if tree.is_dir() else []


def old_review_queue(home: Path) -> Path:
    return old_dir(home) / "review-queue.jsonl"


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()[:150]


def _dates(home: Path) -> dict[str, str]:
    """When each stored line was first written, from the change log."""
    seen: dict[str, str] = {}
    path = old_dir(home) / "changelog.jsonl"
    if path.exists():
        for raw in path.read_text().splitlines():
            if not raw.strip():
                continue
            entry = json.loads(raw)
            if entry.get("verdict") == "applied":
                seen.setdefault(_norm(entry.get("text", "")), entry["ts"][:10])
    return seen


def _date_in(text: str) -> str:
    """A full date written in the line itself ("13/11/2026", "2026-11-13"),
    for lines the change log does not know. Day first: the owner's notation."""
    for pattern, order in ((r"\b(\d{4})-(\d{2})-(\d{2})\b", (1, 2, 3)),
                           (r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", (3, 2, 1))):
        m = re.search(pattern, text)
        if m:
            y, mo, d = (int(m.group(i)) for i in order)
            try:
                return date(y, mo, d).isoformat()
            except ValueError:
                continue
    return ""


def _blocks(text: str):
    """(section, text) for every bullet, and for every paragraph of prose,
    in a knowledge file. Comments, headings and block quotes are not content."""
    section, para = "", []

    def flush():
        if para:
            yield section, " ".join(para)
            para.clear()

    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#"):
            yield from flush()
            section = line.lstrip("# ").strip()
        elif not line or line.startswith(("<!--", ">")):
            yield from flush()
        elif line.startswith(("- ", "* ")):
            yield from flush()
            para.append(line[2:].strip())
        elif para:
            para.append(line)
        else:
            para.append(line)
    yield from flush()


def read_old(home: Path) -> list[OldLine]:
    root = old_dir(home)
    dates = _dates(home)
    files = [(root / name, TOP) for name in OWNER_FILES]
    for node in _old_nodes(home):
        files.append((root / "tree" / node / "index.md", node))
        files += [(p, node) for p in sorted((root / "tree" / node / "details").glob("*.md"))]
    lines: list[OldLine] = []
    for path, level in files:
        if not path.exists():
            continue
        in_file: list[OldLine] = []
        for section, text in _blocks(path.read_text()):
            text = re.sub(r"\s*\*\(supersedes:.*?\)\*\s*$", "", text).strip()
            if len(text) < 12 or text.startswith("Older state notes: see"):
                continue
            in_file.append(OldLine("", str(path.relative_to(root)), level, section,
                                   text[:OLD_TEXT_CHARS], dates.get(_norm(text)) or _date_in(text)))
        # A line the change log does not know (edited by hand, or reworded
        # since) takes the date of its neighbour: the nightly job appended, so
        # within a section the lines are in the order they were learned.
        for i, line in enumerate(in_file):
            if not line.seen:
                before = next((l.seen for l in reversed(in_file[:i])
                               if l.seen and l.section == line.section), "")
                after = next((l.seen for l in in_file[i + 1:] if l.seen), "")
                line.seen = before or after or UNDATED
        for line in in_file:
            line.rid = f"r{len(lines):04d}"
            lines.append(line)
    return lines


# --- stage A: line by line -----------------------------------------------------------

LINE_PROMPT = """\
You are moving one person's AI-agent memory into a new form. Below are lines
from the old memory file `{file}` ({where}). For EACH line decide:

  "keep"    it tells a capable new colleague something they could not get from
            the code, git history or docs: a preference or correction of the
            owner, a decision and its reason, a trap that costs time, where
            things stand now, where something lives, who someone is.
            Rewrite it as one or more SHORT facts (one sentence each, at most
            240 characters, plain words). Split a line that holds two facts.
            Drop commit ids, version numbers, ticket numbers and "shipped in";
            keep the point and the reason.
  "retire"  true once, no longer something to act on (a past plan, a finished
            launch, a measurement of the day). Give ONE short fact; it is kept
            in the record, off every card.
  "drop"    the code or git states it (what was built, how a function works,
            a log of finished work), a one-off request, a guess about the
            owner's character, or an exact repeat. Give "why" in a few words.

For each fact give:
  "kind"    one of: rule, correction, decision, state, reference, person
            (state = where things stand now; it goes stale)
  "topic"   one or two lowercase words; reuse one of [{topics}] when it fits
  "folder"  what the fact is ABOUT, not where it was stored:
            "" for the owner themself (who they are, career, people, how they
            like to work, rules that hold in every project);
            or one of these project folders: {folders}
            (a sub-folder like "{example}/some/dir" is fine when the fact is
            only about that part).
            A fact about another project than `{where}` goes to that project.

Facts about the owner are written as facts about their wishes ("Seb wants X"),
never as orders to the reader. Never output a secret (key, token, password).

Return ONLY a JSON object:
{{"lines": [{{"id": "r0001", "do": "keep", "facts": [{{"text": "...", "kind": "...",
  "topic": "...", "folder": "..."}}]}}, {{"id": "r0002", "do": "drop", "why": "..."}}]}}

Lines:
{lines}
"""


def _stage_a(home: Path, work: Path, n: int, batch: list[OldLine], folders: list[str]) -> list[dict]:
    """The verdicts for one batch of old lines. Kept on disk, so a move that
    is stopped (a usage limit, a restart) resumes without asking again."""
    cache = memory_root(home) / "move-cache" / (
        hashlib.sha1("".join(l.key for l in batch).encode()).hexdigest()[:16] + ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    first = batch[0]
    prompt = LINE_PROMPT.format(
        file=first.file,
        where="about the owner" if first.level == TOP else f"project ~/{first.level}",
        topics=", ".join(TOP_TOPICS if first.level == TOP else PROJECT_TOPICS),
        folders=", ".join(json.dumps(f) for f in folders),
        example=first.level or (folders[0] if folders else "project"),
        lines="\n".join(json.dumps({"id": l.rid, "section": l.section, "text": l.text}) for l in batch))
    text, _ = dreaming.ask_engine(home, prompt, work, f"line-{n:03d}")
    verdicts = {v.get("id"): v for v in dreaming.parse_json_object(text).get("lines", [])}
    missing = [l.rid for l in batch if verdicts.get(l.rid, {}).get("do") not in ("keep", "retire", "drop")]
    if missing:
        raise ValueError(f"No verdict for old line(s) {missing[:5]} in {first.file}")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps([verdicts[l.rid] for l in batch]))
    return [verdicts[l.rid] for l in batch]


# --- stages B and C: per level -------------------------------------------------------

MERGE_PROMPT = """\
Below are facts from one person's AI-agent memory, all filed at the same place
({where}). Find the ones that say the SAME thing (the same lesson, rule or
state, even in different words or from different incidents) and merge them.

A merge keeps one fact and marks the others as replaced by it. Give "text"
only when one clearer sentence (at most 240 characters) states the group
better than any single member. Do not merge facts that are merely related.

Return ONLY a JSON object:
{{"merges": [{{"ids": ["f-aaaaaa", "f-bbbbbb"], "into": "f-aaaaaa", "text": ""}}]}}
An empty list is a fine answer.

Facts:
{facts}
"""

CARD_PROMPT = """\
Below is every fact of one person's AI-agent memory filed at {where}. Choose
what goes on the CARD: the short page an agent {reader} is given in full at
the start of every chat. Everything else stays in the record, one lookup away.

The card has about {budget:,} characters for facts (each fact costs its length
plus about 12). Fill it with what an agent most needs in order not to go
wrong or ask again; leave the rest. Prefer current facts over old ones and
rules that bite over background.

Card parts:
  "what"   two or three lines: {what}
  "now"    where things stand: current goals, open threads, recent decisions
  "rules"  preferences, corrections, traps, decisions that bite
{essentials}
Return ONLY a JSON object:
{{"card": [{{"id": "f-aaaaaa", "part": "what" | "now" | "rules"{essential_field}}}]}}

Facts (id, kind, last confirmed, text):
{facts}
"""

TOP_ESSENTIALS = """\

Also mark the ESSENTIALS: the few card facts that hold in EVERY project (the
owner's name, how they like to work and be spoken to, rules that apply
everywhere). An agent working inside a project receives only these about the
owner, so nothing about career, people or other ventures belongs there. About
{budget:,} characters. Set "essential": true on those.
"""


def _listing(facts) -> str:
    return "\n".join(f"{f.id} | {f.kind} | {f.last_confirmed} | {f.text}" for f in facts)


def _where(level: str) -> str:
    return "the owner's own level (who they are and how they work)" if level == TOP else f"project ~/{level}"


def _merges(home: Path, work: Path, level: str, chunk: list, tag: str) -> list[dict]:
    """The merges a model proposes for one chunk of facts. A chunk the model
    cannot answer is halved and tried again (one odd sentence can derail a
    call); a small one that still fails is left unmerged and logged."""
    try:
        text, _ = dreaming.ask_engine(
            home, MERGE_PROMPT.format(where=_where(level), facts=_listing(chunk)), work, tag)
        return dreaming.parse_json_object(text).get("merges", [])
    except (RuntimeError, ValueError) as e:
        if len(chunk) < 40:
            log.warning("Memory move: %d fact(s) of %r left unmerged (%s)", len(chunk),
                        level or "the owner", str(e)[:120])
            return []
        half = len(chunk) // 2
        return (_merges(home, work, level, chunk[:half], tag + "a")
                + _merges(home, work, level, chunk[half:], tag + "b"))


def _stage_b(home: Path, work: Path, store: Store, level: str, run: str) -> int:
    """Merge duplicates at one level. Facts are shown topic by topic so the
    ones most likely to repeat each other are in the same call."""
    facts = sorted(store.at_level(level), key=lambda f: (f.topic, f.kind, f.text))
    merged = 0
    for n in range(0, len(facts), MERGE_CHUNK):
        chunk = [f for f in facts[n:n + MERGE_CHUNK] if f.active]
        if len(chunk) < 2:
            continue
        known = {f.id for f in chunk}
        todo = []
        for m in _merges(home, work, level, chunk, f"merge-{level.replace('/', '-') or 'top'}-{n:04d}"):
            ids = [i for i in dict.fromkeys(m.get("ids") or []) if i in known]
            if len(ids) < 2:
                continue
            known -= set(ids)       # a fact joins one merge only
            op = {"op": "merge", "ids": ids}
            if m.get("text"):
                op.update(text=m["text"], source={"type": "old-knowledge", "ref": "merged"})
            elif m.get("into") in ids:
                op["into"] = m["into"]
            todo.append(op)
        results = ops.apply_ops(store, level, todo, run=run, strict=False, max_card_loss=None)
        merged += sum(len(r.get("replaced", [])) for r in results)
    return merged


def _stage_c(home: Path, work: Path, store: Store, level: str, run: str, limits: dict) -> None:
    facts = sorted(store.at_level(level), key=lambda f: f.last_confirmed, reverse=True)
    if not facts:
        return
    top = level == TOP
    budget = int((limits["top_card"] if top else limits["project_card"]) * 0.8)
    prompt = CARD_PROMPT.format(
        where=_where(level), budget=budget, facts=_listing(facts),
        reader="started in the home folder (a chief of staff with a wide view)" if top
        else "working in this project",
        what="who the owner is" if top else "what this project is and what it is for",
        essentials=TOP_ESSENTIALS.format(budget=int(limits["top_essentials"] * 0.85)) if top else "",
        essential_field=', "essential": false' if top else "")
    text, _ = dreaming.ask_engine(home, prompt, work, f"card-{level.replace('/', '-') or 'top'}")
    known = {f.id for f in facts}
    todo = [{"op": "card", "id": c["id"], "on": True, "part": c.get("part"),
             "essential": bool(c.get("essential")) and top}
            for c in dreaming.parse_json_object(text).get("card", []) if c.get("id") in known]
    ops.apply_ops(store, level, todo, run=run, strict=False, max_card_loss=None)


# --- the move ------------------------------------------------------------------------


def _project_folders(home: Path, lines: list[OldLine]) -> list[str]:
    """The projects a fact may be filed under: every folder that has old notes."""
    return sorted({l.level.split("/")[0] for l in lines if l.level})


def _clean_folder(folder: object, allowed: set[str], fallback: str) -> str:
    folder = str(folder or "").strip().strip("/").removeprefix("~/")
    if folder in ("", "~"):
        return TOP
    return folder if folder.split("/")[0] in allowed and ".." not in folder else fallback


def move(home: Path, *, workers: int = 5, today: date | None = None) -> dict:
    """Run the move (or its top-up) into the memory root and print the views.
    Returns the counts the owner's page shows."""
    today = today or date.today()
    root = memory_root(home)
    root.mkdir(parents=True, exist_ok=True)
    store = Store(root)
    views.take_in_hand_edits(store, today)     # the owner's corrections to the proposal come first
    run = f"move-{datetime.now():%Y%m%d-%H%M%S}"
    work = home / ".shellteam" / "dream" / "runs" / run     # a hidden folder: never read back
    work.mkdir(parents=True, exist_ok=True)

    moved_path = root / "moved-lines.json"
    moved: dict[str, dict] = json.loads(moved_path.read_text()) if moved_path.exists() else {}
    old = read_old(home)
    fresh = [l for l in old if l.key not in moved]
    log.info("Memory move %s: %d old line(s), %d not moved yet", run, len(old), len(fresh))
    folders = _project_folders(home, old)
    allowed = set(folders)

    batches: list[list[OldLine]] = []
    for line in fresh:
        if batches and batches[-1][0].file == line.file and len(batches[-1]) < BATCH_LINES:
            batches[-1].append(line)
        else:
            batches.append([line])
    with ThreadPoolExecutor(workers) as pool:
        jobs = [pool.submit(_stage_a, home, work, n, b, folders) for n, b in enumerate(batches)]
        verdicts = [job.result() for job in jobs]

    touched: set[str] = set()
    for batch, batch_verdicts in zip(batches, verdicts):
        for line, verdict in zip(batch, batch_verdicts):
            entry = moved[line.key] = {"file": line.file, "level": line.level, "old": line.text,
                                       "do": verdict["do"], "why": verdict.get("why", ""), "facts": []}
            if verdict["do"] == "drop":
                continue
            for raw in (verdict.get("facts") or [])[: 1 if verdict["do"] == "retire" else 4]:
                if not str(raw.get("text") or "").strip():
                    log.warning("Memory move: fact without a sentence for %s: %r", line.rid, raw)
                    continue
                kind = _KIND_WORDS.get(str(raw.get("kind") or "").lower().rstrip("s"), "reference")
                folder = _clean_folder(raw.get("folder"), allowed, line.level)
                fact = store.add(
                    text=str(raw["text"])[:400], kind=kind, folder=folder,
                    topic=str(raw.get("topic") or "general")[:40],
                    source={"type": "old-knowledge", "ref": line.file, "quote": line.text[:200]},
                    seen=line.seen)
                if verdict["do"] == "retire" and fact.active:
                    fact.status = "retired"
                entry["facts"].append(fact.id)
                touched.add(folder.split("/")[0] if folder else TOP)
            if not entry["facts"]:
                entry.update(do="drop", why=entry["why"] or "no usable fact returned")
    store.save()
    moved_path.write_text(json.dumps(moved, indent=1))

    # Levels still to merge and to give a card. Kept on disk, so a stopped
    # move picks them up again; a level whose model answer cannot be used is
    # left for the next run and named in the summary.
    state_path = root / "move-state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"pending": [], "merged_away": 0}
    pending = sorted((set(state["pending"]) | touched) & store.levels())
    state_path.write_text(json.dumps({**state, "pending": pending}))
    limits = load_settings(root)["limits"]
    failed: dict[str, str] = {}
    for level in list(pending):
        try:
            state["merged_away"] += _stage_b(home, work, store, level, run)
            _stage_c(home, work, store, level, run, limits)
        except Exception as e:
            log.exception("Memory move: level %r not placed; it stays pending", level or "the owner")
            failed[level or "~"] = str(e)[:200]
            continue
        store.save()
        pending.remove(level)
        state_path.write_text(json.dumps({**state, "pending": pending}))
    merged = state["merged_away"]
    printed = views.print_views(store, today)

    did = Counter(m["do"] for m in moved.values())
    refiled = [
        {"old": m["old"], "from": m["level"] or "~", "to": store.facts[fid].folder or "~",
         "text": store.facts[fid].text}
        for m in moved.values() for fid in m["facts"]
        if fid in store.facts and (store.facts[fid].folder.split("/")[0] if store.facts[fid].folder else "")
        != m["level"].split("/")[0]]
    summary = {
        "run": run, "old_lines": len(old), "new_this_run": len(fresh),
        "kept": did["keep"], "retired": did["retire"], "dropped": did["drop"],
        "facts": len(store.facts), "active": len(store.active()), "merged_away": merged,
        "refiled": refiled,
        "blocked": sum(1 for f in store.facts.values() if f.status == "blocked"),
        "not_placed": failed,
        "levels": {
            level: {"facts": len(store.at_level(level)), "card_chars": lp.card_chars,
                    "card_limit": lp.card_limit, "essentials_chars": lp.essentials_chars,
                    "taken_off_to_fit": len(lp.taken_off_to_fit)}
            for level, lp in printed.levels.items()},
    }
    (root / "move.json").write_text(json.dumps(summary, indent=1))
    log.info("Memory move %s done: %d kept, %d retired, %d dropped, %d merged away, %d active fact(s)",
             run, did["keep"], did["retire"], did["drop"], merged, len(store.active()))
    return summary


def resized(home: Path, dest: Path, factor: float) -> dict:
    """The same facts as a tree of its own under ``dest``, with every limit
    multiplied by ``factor`` and the cards chosen again for those limits.
    For the exam's size table; the proposal itself is not touched."""
    import os

    source = Store(memory_root(home))
    dest.mkdir(parents=True, exist_ok=True)
    limits = {k: int(v * factor) for k, v in load_settings(source.root)["limits"].items()}
    (dest / "settings.json").write_text(json.dumps({"limits": limits}, indent=1))
    store = Store(dest)
    store.facts = {fid: Fact(**asdict(f)) for fid, f in source.facts.items()}
    for f in store.facts.values():
        if not f.pinned:
            f.on_card = f.essential = False
    work = home / ".shellteam" / "dream" / "runs" / f"resize-{datetime.now():%Y%m%d-%H%M%S}"
    work.mkdir(parents=True)
    with ThreadPoolExecutor(6) as pool:
        list(pool.map(lambda level: _stage_c(home, work, store, level, work.name, limits),
                      sorted(store.levels())))
    saved = os.environ.get("SHELLTEAM_MEMORY_ROOT")
    os.environ["SHELLTEAM_MEMORY_ROOT"] = str(dest)     # record paths are printed for this tree
    try:
        printed = views.print_views(store)
    finally:
        os.environ.pop("SHELLTEAM_MEMORY_ROOT") if saved is None else os.environ.update(
            SHELLTEAM_MEMORY_ROOT=saved)
    return {level or "~": lp.card_chars for level, lp in printed.levels.items()}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    result = move(Path.home())
    print(json.dumps({k: v for k, v in result.items() if k != "refiled"}, indent=2))

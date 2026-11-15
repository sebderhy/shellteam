"""The one-time move of the old knowledge files (K9)."""

import json
from datetime import date
from pathlib import Path

import pytest

from api.services import dreaming
from api.services.memory import migrate, views
from api.services.memory.store import Store, memory_root

TODAY = date(2026, 11, 14)
UGLY = ["Seb called a research report really ugly.", "A report without the design skill came out ugly.",
        "Reports must keep the polished standard.", "A market study page was called catastrophic."]


def _seed(home: Path) -> None:
    k = migrate.old_dir(home)
    (k / "tree" / "shellteam" / "details").mkdir(parents=True)
    (k / "tree" / "orchard").mkdir(parents=True)
    (k / "feedback.md").write_text(
        "# Feedback\n\n<!-- corrections -->\n\n## Current state\n" + "".join(f"- {u}\n" for u in UGLY))
    (k / "identity.md").write_text("# Identity\n\n## People\n- Spell the name Seb, never with an accent.\n")
    (k / "tree" / "shellteam" / "index.md").write_text(
        "# shellteam — project knowledge\n\n> Maintained nightly.\n\n## Decisions\n"
        "- ShellTeam has NO dev branch and stays on main.\n"
        "- Phone composer uses the Messenger collapse pattern. Shipped (commit c619ffa).\n"
        "- Ship gate defect fixed: the gate now deploys in its own worktree for Orchard.\n"
        "- Show HN post finalized and scheduled for a Tuesday slot.\n"
        "- Never use pkill -f in QA cleanup; agents can't restart shellteam-ai-chat from a session.\n")
    (k / "tree" / "shellteam" / "details" / "archive.md").write_text(
        "# archive\n\n## Archived from index — 20260801\n- Managed boxes run release tags, never main.\n")
    (k / "tree" / "orchard" / "index.md").write_text("# orchard\n\n## Current state\n- Orchard develops on dev.\n")
    (migrate.old_dir(home) / "changelog.jsonl").write_text(json.dumps({
        "ts": "2026-09-03T07:00:00+0000", "verdict": "applied", "node": "shellteam",
        "text": "ShellTeam has NO dev branch and stays on main."}) + "\n")


def _fake_engine(calls):
    def engine(home, prompt, work, tag):
        calls.append(tag)
        if tag.startswith("line-"):
            out = []
            for raw in prompt.split("Lines:\n")[1].splitlines():
                line = json.loads(raw)
                t = line["text"]
                fact = lambda text, kind="rule", folder="shellteam", topic="process": {
                    "text": text, "kind": kind, "topic": topic, "folder": folder}
                if "Shipped (commit" in t:
                    out.append({"id": line["id"], "do": "drop", "why": "the code states it"})
                elif "Show HN" in t:
                    out.append({"id": line["id"], "do": "retire",
                                "facts": [fact("A Show HN post was planned for a Tuesday.", "state")]})
                elif "pkill" in t:
                    out.append({"id": line["id"], "do": "keep", "facts": [
                        fact("In QA cleanup kill only exact pids you started."),
                        fact("Agents cannot restart shellteam-ai-chat from inside a session.")]})
                elif "Ship gate" in t:
                    out.append({"id": line["id"], "do": "keep", "facts": [
                        fact("The ship gate deploys from its own worktree.", "decision", "orchard")]})
                elif "ugly" in t or "polished" in t or "catastrophic" in t or "Spell" in t:
                    out.append({"id": line["id"], "do": "keep", "facts": [
                        fact(t, "correction", "", "working style")]})
                else:
                    out.append({"id": line["id"], "do": "keep", "facts": [fact(t, folder=(
                        "orchard" if "Orchard develops" in t else "shellteam"))]})
            return json.dumps({"lines": out}), 0
        rows = [r.split(" | ") for r in prompt.split("Facts")[-1].splitlines() if r.startswith("f-")]
        if tag.startswith("merge-"):
            ugly = [r[0] for r in rows if any(w in r[3] for w in ("ugly", "polished", "catastrophic"))]
            merges = [{"ids": ugly, "text": "Reports and decks must look polished; check them in screenshots."}] \
                if len(ugly) > 1 else []
            return json.dumps({"merges": merges}), 0
        return json.dumps({"card": [{"id": r[0], "part": "rules", "essential": "Spell" in r[3]}
                                    for r in rows]}), 0
    return engine


@pytest.fixture
def moved(tmp_path, monkeypatch):
    _seed(tmp_path)
    calls: list[str] = []
    monkeypatch.setattr(dreaming, "ask_engine", _fake_engine(calls))
    monkeypatch.delenv("SHELLTEAM_MEMORY_ROOT", raising=False)
    summary = migrate.move(tmp_path, workers=1, today=TODAY)
    return tmp_path, summary, calls


def test_every_old_line_is_read_with_its_date(tmp_path):
    _seed(tmp_path)
    lines = migrate.read_old(tmp_path)
    assert len(lines) == 12, "bullets of every file, the archive included; no headings or comments"
    by_text = {l.text: l for l in lines}
    assert by_text["ShellTeam has NO dev branch and stays on main."].seen == "2026-09-03"
    assert by_text["Managed boxes run release tags, never main."].level == "shellteam"
    assert by_text["Phone composer uses the Messenger collapse pattern. Shipped (commit c619ffa)."].seen \
        == "2026-09-03", "a line the change log does not know takes its neighbour's date"


def test_a_date_written_in_the_line_is_used_when_the_change_log_has_none():
    assert migrate._date_in("Seb asked (13/11/2026) for more concise answers.") == "2026-11-13"
    assert migrate._date_in("Decided on 2026-09-03 to stay on main.") == "2026-09-03"
    assert migrate._date_in("Version 31/31/2026 is not a date.") == ""


def test_keep_split_retire_drop_and_refile(moved):
    home, summary, _ = moved
    store = Store(memory_root(home))
    texts = {f.text: f for f in store.facts.values()}
    assert "Phone composer" not in " ".join(texts), "what the code states is dropped"
    assert texts["A Show HN post was planned for a Tuesday."].status == "retired"
    assert texts["In QA cleanup kill only exact pids you started."].active
    assert texts["Agents cannot restart shellteam-ai-chat from inside a session."].active
    gate = texts["The ship gate deploys from its own worktree."]
    assert gate.folder == "orchard", "a fact filed under the wrong project is re-filed"
    assert [r["to"] for r in summary["refiled"]] == ["orchard"]
    branch = texts["ShellTeam has NO dev branch and stays on main."]
    assert branch.first_seen == "2026-09-03" and branch.sources[0]["type"] == "old-knowledge"
    assert (summary["kept"], summary["retired"], summary["dropped"]) == (10, 1, 1)


def test_a_lesson_stored_four_times_appears_once(moved):
    home, summary, _ = moved
    store = Store(memory_root(home))
    ugly = [f for f in store.active() if "polished" in f.text or "ugly" in f.text]
    assert len(ugly) == 1 and len(ugly[0].sources) == 5
    assert summary["merged_away"] == 4


def test_views_are_printed_and_the_old_files_are_only_read(moved):
    home, _, _ = moved
    root = memory_root(home)
    card = (views.level_dir(root, "shellteam") / "card.md").read_text()
    assert "NO dev branch" in card and "ugly" not in card and "Orchard develops" not in card
    essentials = (views.level_dir(root, "") / "essentials.md").read_text()
    assert "Spell the name Seb" in essentials and "polished" not in essentials
    assert not (root / "live.json").exists()
    assert migrate.old_dir(home).joinpath("feedback.md").read_text().count("ugly") == 2, \
        "the old files are only read"


def test_a_second_run_takes_in_only_new_lines_and_keeps_owner_corrections(moved, monkeypatch):
    home, _, calls = moved
    root = memory_root(home)
    card = views.level_dir(root, "shellteam") / "card.md"
    card.write_text("\n".join(l for l in card.read_text().splitlines() if "exact pids" not in l) + "\n")
    with (migrate.old_dir(home) / "tree" / "shellteam" / "index.md").open("a") as f:
        f.write("- Release tags must be signed.\n")
    calls.clear()
    summary = migrate.move(home, workers=1, today=TODAY)
    assert summary["new_this_run"] == 1 and calls.count("line-000") == 1
    assert not [c for c in calls if "orchard" in c or "top" in c], "untouched levels are not redone"
    store = Store(root)
    removed = [f for f in store.facts.values() if "exact pids" in f.text]
    assert [f.status for f in removed] == ["removed"]
    assert "Release tags must be signed." in card.read_text() and "exact pids" not in card.read_text()

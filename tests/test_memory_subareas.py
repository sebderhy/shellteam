"""Sub-area cards (K18): a full card hands a group of facts about one
sub-folder to a card of its own; the project gets essentials; the split is in
the report and can be undone, alone or with its night."""

import json
from datetime import date
from pathlib import Path

import pytest

from api.services import dreaming
from api.services.memory import nightly, ops, overview, switch, told, views
from api.services.memory.store import Store, memory_root

SRC = {"type": "conversation", "ref": "claude:s1", "quote": "q"}
SUB = "shellteam/computer/ai-chat"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    memory_root(tmp_path).mkdir(parents=True)
    switch.live_path(tmp_path).write_text(json.dumps({"since": date.today().isoformat()}))
    (tmp_path / SUB).mkdir(parents=True)
    (tmp_path / "shellteam" / "api").mkdir()
    return tmp_path


def _seed(home: Path, cockpit: int = 7, project: int = 4) -> tuple[Store, list[str], list[str]]:
    """``cockpit`` facts only about the cockpit, ``project`` about the whole
    project, all on the card."""
    store = Store(memory_root(home))
    sub = [store.add(text=f"Cockpit rule {n}: the tab strip works this way.", kind="rule",
                     folder="shellteam", topic="cockpit", source=SRC, seen="2026-11-10", on_card=True).id
           for n in range(cockpit)]
    whole = [store.add(text=f"Project rule {n}: ship from main.", kind="rule", folder="shellteam",
                       topic="release", source=SRC, seen="2026-11-10", on_card=True).id
             for n in range(project)]
    views.print_views(store)
    return store, sub, whole


def _split(store, sub, essentials, run="20261115-034400"):
    return ops.apply_ops(store, "shellteam", [{"op": "split", "folder": SUB, "ids": sub,
                                              "essentials": essentials}],
                         run=run, max_card_loss=None)


class TestTheSplit:
    def test_the_group_moves_down_and_the_project_gets_essentials(self, home):
        store, sub, whole = _seed(home)
        [result] = _split(store, sub, whole[:2])
        assert result["split"] == SUB and result["ids"] == sub
        assert store.levels() == {"", "shellteam", SUB}
        assert {f.id for f in store.at_level(SUB)} == set(sub)
        assert all(store.facts[i].essential for i in whole[:2])
        views.print_views(store)

        again = Store(store.root)
        assert again.subareas == {SUB}, "the sub-area survives a reload"
        root = store.root
        card = (views.level_dir(root, SUB) / "card.md").read_text()
        assert card.startswith("SUB-AREA: ai-chat   ~/shellteam/computer/ai-chat")
        assert "Cockpit rule 0" in card and "Project rule" not in card
        assert "The full card of ~/shellteam is not loaded here" in card
        parent = (views.level_dir(root, "shellteam") / "card.md").read_text()
        assert "Cockpit rule" not in parent, "the parent card got its room back"
        assert f"- ~/{SUB}" in parent.split("Below")[1], "one pointer line on the parent"
        essentials = (views.level_dir(root, "shellteam") / "essentials.md").read_text()
        assert "Project rule 0" in essentials and "Project rule 3" not in essentials

    def test_a_fact_already_filed_deeper_keeps_its_folder(self, home):
        store, sub, _ = _seed(home)
        deep = store.add(text="The composer lives in public/app.js.", kind="reference",
                         folder=SUB + "/public", topic="cockpit", source=SRC)
        _split(store, [*sub, deep.id], [])
        assert store.facts[deep.id].folder == SUB + "/public"
        assert deep in store.at_level(SUB)

    @pytest.mark.parametrize("op, why", [
        ({"folder": SUB, "ids": "few"}, "at least 6"),
        ({"folder": "orchard/web", "ids": "all"}, "not a sub-folder"),
        ({"folder": "shellteam/.git", "ids": "all"}, "hidden"),
        ({"folder": "shellteam/record", "ids": "all"}, "record"),
        ({"folder": SUB, "ids": "all", "essentials": "overlap"}, "both move down"),
    ])
    def test_a_split_that_fails_a_check_changes_nothing(self, home, op, why):
        store, sub, whole = _seed(home)
        op = {"op": "split", **op}
        op["ids"] = sub[:3] if op["ids"] == "few" else sub
        if op.get("essentials") == "overlap":
            op["essentials"] = [sub[0]]
        before = {fid: f.folder for fid, f in store.facts.items()}
        with pytest.raises(ops.OpError, match=why):
            ops.apply_ops(store, "shellteam", [op], run="r", max_card_loss=None)
        assert {fid: f.folder for fid, f in store.facts.items()} == before
        assert store.subareas == set() and store.levels() == {"", "shellteam"}

    def test_a_sub_area_with_no_fact_left_is_not_a_level(self, home):
        store, sub, _ = _seed(home)
        _split(store, sub, [])
        for fid in sub:
            store.facts[fid].status = "retired"
        assert store.levels() == {"", "shellteam"}

    def test_a_split_is_undone_alone_or_with_its_night(self, home):
        store, sub, whole = _seed(home)
        _split(store, sub, whole[:1], run="night1")
        store.save()
        assert nightly.undo_split(home, "night1", SUB)
        again = Store(memory_root(home))
        assert again.subareas == set() and again.levels() == {"", "shellteam"}
        assert all(again.facts[i].folder == "shellteam" for i in sub)
        assert not again.facts[whole[0]].essential
        assert not (views.level_dir(again.root, SUB) / "card.md").exists(), "its card is gone"
        assert not nightly.undo_split(home, "night1", SUB), "an undone split is not undone twice"

        _split(again, sub, [], run="night2")
        again.save()
        assert nightly.undo_night(home, "night2") == 1
        assert Store(memory_root(home)).subareas == set()


class Model:
    def __init__(self, monkeypatch, split):
        self.split, self.prompts = split, {}
        monkeypatch.setattr(dreaming, "ask_engine", self)

    def __call__(self, home, prompt, run_cwd, tag):
        self.prompts[tag] = prompt
        if tag.startswith("split"):
            return json.dumps(self.split(prompt)), None
        if tag.startswith("extract"):
            return json.dumps({"facts": []}), None
        raise AssertionError(f"unexpected call {tag}")


def _printed(store, level="shellteam", chars=7_500, limit=8_000):
    report = views.PrintReport()
    report.levels[level] = views.LevelPrint(card_chars=chars, card_limit=limit)
    return report


class TestTheNightlyCheck:
    def test_a_full_card_that_changed_is_split_when_the_model_finds_a_group(self, home, monkeypatch):
        store, sub, whole = _seed(home)
        model = Model(monkeypatch, lambda p: {"split": {"folder": SUB, "ids": sub, "essentials": whole[:1],
                                                         "why": "the cockpit has its own rules"}})
        out = nightly.split_full_levels(home, store, _printed(store), {"shellteam"}, "r", home, date.today())
        prompt = model.prompts["split-shellteam"]
        assert SUB in prompt.split("--- SUB-FOLDERS")[1] and "shellteam/api" in prompt
        assert f"{sub[0]} | C | shellteam | cockpit |" in prompt
        assert out["shellteam"] == {"folder": SUB, "why": "the cockpit has its own rules", "facts": 7,
                                    "card": 7, "essentials": ["Project rule 0: ship from main."]}
        assert store.subareas == {SUB}

    @pytest.mark.parametrize("chars, changed", [(6_000, {"shellteam"}), (7_500, set())])
    def test_a_card_with_room_or_unchanged_tonight_is_not_asked(self, home, monkeypatch, chars, changed):
        store, _, _ = _seed(home)
        model = Model(monkeypatch, lambda p: {"split": None})
        assert nightly.split_full_levels(home, store, _printed(store, chars=chars), changed, "r", home,
                                         date.today()) == {}
        assert model.prompts == {}

    def test_no_group_is_reported_and_nothing_moves(self, home, monkeypatch):
        store, _, _ = _seed(home)
        Model(monkeypatch, lambda p: {"split": None, "why": "facts are spread across the project"})
        out = nightly.split_full_levels(home, store, _printed(store), {"shellteam"}, "r", home, date.today())
        assert out["shellteam"] == {"folder": None, "why": "facts are spread across the project"}
        assert store.subareas == set()

    def test_a_folder_the_model_invents_is_refused_out_loud(self, home, monkeypatch):
        store, sub, _ = _seed(home)
        Model(monkeypatch, lambda p: {"split": {"folder": "shellteam/nowhere", "ids": sub}})
        out = nightly.split_full_levels(home, store, _printed(store), {"shellteam"}, "r", home, date.today())
        assert "not one of the sub-folders listed" in out["shellteam"]["failed"]
        assert store.subareas == set()

    def test_tonights_candidates_about_a_sub_area_are_placed_there(self, home):
        store, sub, _ = _seed(home)
        _split(store, sub, [])
        levels = store.levels()
        assert nightly.level_of_candidate({"folder": SUB + "/public"}, levels) == SUB
        assert nightly.level_of_candidate({"folder": "shellteam/api"}, levels) == "shellteam"
        assert nightly.level_of_candidate({"folder": "newproj/x"}, levels) == "newproj"
        prompt = nightly.place_prompt(store, SUB, [{"kind": "rule", "seen": "2026-11-15",
                                                    "folder": SUB, "text": "x"}])
        assert "the sub-area ~/shellteam/computer/ai-chat" in prompt and "of 4,000 characters" in prompt
        parent = nightly.place_prompt(store, "shellteam", [{"kind": "rule", "seen": "2026-11-15",
                                                            "folder": "shellteam", "text": "x"}])
        assert '"essential": true only for a line that holds for all of ~/shellteam' in parent


class TestWhereItShows:
    def test_the_tree_the_night_and_the_launch_key_know_the_sub_area(self, home):
        store, sub, whole = _seed(home)
        _split(store, sub, whole[:1], run="20261115-034400")
        views.print_views(store)
        run_dir = dreaming.dream_dir(home) / "runs" / "20261115-034400"
        run_dir.mkdir(parents=True)
        split = {"folder": SUB, "why": "w", "facts": 7, "card": 7, "essentials": ["Project rule 0: ship from main."]}
        (run_dir / "run.json").write_text(json.dumps({
            "run": "20261115-034400", "status": "ok", "memory": "tree",
            "levels": {"shellteam": {**nightly._new_level(), "split": split}}}))

        names = [l["level"] for l in overview.levels(home)]
        assert names == ["", "shellteam", SUB], "a sub-area is listed right under its project"
        tree = {l["level"]: l for l in overview.levels(home)}
        assert tree[SUB]["card"]["limit"] == 4_000 and tree["shellteam"]["essentials"]["limit"] == 2_000

        night = overview.night(home, "20261115-034400")
        assert night["levels"]["shellteam"]["split"] == {**split, "undone": False}
        assert nightly.undo_split(home, "20261115-034400", SUB)
        assert overview.night(home, "20261115-034400")["levels"]["shellteam"]["split"]["undone"] is True

        store = Store(memory_root(home))
        _split(store, sub, [], run="again")
        store.save()
        assert told.launch_key(home, home / SUB / "public") == "shellteam", "printed only at the next print"
        views.print_views(store)
        assert told.launch_key(home, home / SUB / "public") == SUB

    def test_the_report_says_which_sub_folder_got_a_card(self):
        from api.services.memory import night_report
        info = {**nightly._new_level(), "split": {"folder": SUB, "why": "own rules", "facts": 7, "card": 5,
                                                  "essentials": ["Ship from main."]}}
        summary = {"levels": {"shellteam": info}, "not_read": {"sources": []}, "seconds": 60}
        assert f"~/{SUB} got its own card" in night_report.in_words(summary)
        html = night_report._level_html("shellteam", info)
        assert f"New card for ~/{SUB}" in html and "7 facts" in html and "Ship from main." in html
        assert "Nothing changed" not in html

"""Knowledge tab API: module gate, path jail, owner edits, a night's changes.

The whole surface must be a 404 without the dreaming module (the tab "does
not exist" on a non-dreaming box), and file access must be jailed to memory's
printed views even for the authenticated owner.
"""

import pytest

from api import config


@pytest.fixture
def dreaming_home(monkeypatch, tmp_path):
    """Enable the module and point the owner's HOME at a temp dir."""
    monkeypatch.setattr(config, "MODULES", frozenset({"dreaming"}))
    monkeypatch.setattr(config, "HOME_DIR", tmp_path)
    return tmp_path


class TestModuleGate:
    def test_api_404_without_module(self, client, auth_header):
        assert client.get("/api/knowledge/overview", headers=auth_header).status_code == 404
        assert client.get("/api/knowledge/dream/status", headers=auth_header).status_code == 404

    def test_page_404_without_module(self, client, auth_header):
        assert client.get("/knowledge", headers=auth_header).status_code == 404

    def test_api_requires_auth_even_with_module(self, client, dreaming_home):
        r = client.get("/api/knowledge/overview")
        assert r.status_code in (401, 403)


class TestDreamStatus:
    def test_latest_report_comes_from_state_not_glob(self, client, auth_header, dreaming_home):
        """Any stray dream-*.html in ~/reports/ used to shadow the real
        report; the run's own state entry is the source of truth."""
        import json as _json

        from api.services import dreaming
        reports = dreaming_home / "reports"
        reports.mkdir()
        (reports / "dream-2026-07-08.html").write_text("real")
        (reports / "dream-zzz-artifact.html").write_text("stray")  # sorts last
        dreaming.state_path(dreaming_home).parent.mkdir(parents=True, exist_ok=True)
        dreaming.state_path(dreaming_home).write_text(_json.dumps(
            {"last_run": "20260708-070228", "last_status": "ok",
             "last_report": "dream-2026-07-08.html"}))
        r = client.get("/api/knowledge/dream/status", headers=auth_header).json()
        assert r["latest_report"] == "/reports/dream-2026-07-08.html"


class TestKnowledgeTreeViews:
    """K17a: the owner reads and edits the printed views; an edit becomes a
    pinned fact, a removal sticks."""

    @staticmethod
    def _seed(home):
        from api.services.memory import views
        from api.services.memory.store import Store, memory_root
        store = Store(memory_root(home))
        src = {"type": "conversation", "ref": "s"}
        store.add(text="Spell his name Seb.", kind="rule", folder="", topic="preferences",
                  source=src, on_card=True, essential=True)
        store.add(text="No dev branch.", kind="rule", folder="shellteam", topic="process",
                  source=src, on_card=True)
        store.add(text="Managed boxes run tags.", kind="reference", folder="shellteam",
                  topic="release", source=src)
        views.print_views(store)
        (store.root / "live.json").write_text('{"since": "2026-11-14"}')
        return store.root

    def test_the_tree_shows_how_full_each_level_is(self, client, dreaming_home, auth_header, monkeypatch):
        monkeypatch.delenv("SHELLTEAM_MEMORY_ROOT", raising=False)
        self._seed(dreaming_home)
        levels = client.get("/api/knowledge/overview", headers=auth_header).json()["levels"]
        assert [l["level"] for l in levels] == ["", "shellteam"]
        owner, project = levels
        assert owner["card"]["path"] == "_top/card.md" and owner["card"]["limit"] == 10_000
        assert 0 < owner["essentials"]["chars"] <= owner["essentials"]["limit"]
        assert project["card"]["limit"] == 8_000 and project["essentials"] is None
        assert project["records"] == [{"topic": "release", "path": "shellteam/record/release.md", "facts": 1}]
        assert project["facts"] == 2
        assert "No dev branch." in client.get(
            "/api/knowledge/file?path=shellteam/card.md", headers=auth_header).json()["content"]

    @pytest.mark.parametrize("bad", [
        "../../.ssh/id_rsa.md", "../facts.jsonl", "shellteam/../../../secrets.md", "_top/card.txt",
    ])
    def test_path_jail(self, client, auth_header, dreaming_home, bad):
        assert client.get(f"/api/knowledge/file?path={bad}", headers=auth_header).status_code == 400

    def test_an_edit_and_a_removal_become_facts(self, client, dreaming_home, auth_header, monkeypatch):
        from api.services.memory.store import Store
        monkeypatch.delenv("SHELLTEAM_MEMORY_ROOT", raising=False)
        root = self._seed(dreaming_home)
        card = client.get("/api/knowledge/file?path=shellteam/card.md", headers=auth_header).json()["content"]
        edited = card.replace("No dev branch.", "No dev branch; ask before pushing to main.")
        saved = client.put("/api/knowledge/file", json={"path": "shellteam/card.md", "content": edited}, headers=auth_header).json()
        assert [e["what"] for e in saved["taken_in"]] == ["edited"]
        facts = Store(root).facts.values()
        new = next(f for f in facts if "ask before pushing" in f.text)
        assert new.pinned and new.sources[0]["type"] == "owner"
        page = client.get("/api/knowledge/file?path=shellteam/record/release.md", headers=auth_header).json()["content"]
        gone = "\n".join(l for l in page.splitlines() if "tags" not in l) + "\n"
        saved = client.put("/api/knowledge/file",
                           json={"path": "shellteam/record/release.md", "content": gone}, headers=auth_header).json()
        assert [e["what"] for e in saved["taken_in"]] == ["removed"]
        assert [f.status for f in Store(root).facts.values() if "tags" in f.text] == ["removed"]

    def test_the_view_jail_holds(self, client, dreaming_home, auth_header, monkeypatch):
        monkeypatch.delenv("SHELLTEAM_MEMORY_ROOT", raising=False)
        self._seed(dreaming_home)
        assert client.put("/api/knowledge/file",
                          json={"path": "shellteam/new.md", "content": "x"}, headers=auth_header).status_code == 404


class TestWhatAChatWasTold:
    """K16: from a cockpit chat, the exact launch text it started with."""

    def test_a_chat_gets_the_text_in_force_when_it_started(self, client, dreaming_home, auth_header, monkeypatch):
        import json as _json
        monkeypatch.delenv("SHELLTEAM_MEMORY_ROOT", raising=False)
        TestKnowledgeTreeViews._seed(dreaming_home)
        told = dreaming_home / ".shellteam" / "memory" / "told"
        told.mkdir(parents=True)
        (told / "aaa.md").write_text("OLD TEXT for shellteam")
        (told / "bbb.md").write_text("NEW TEXT for shellteam")
        (told / "launches.jsonl").write_text("".join(_json.dumps(l) + "\n" for l in [
            {"at": 1000.0, "key": "shellteam", "sha": "aaa"}, {"at": 5000.0, "key": "shellteam", "sha": "bbb"},
            {"at": 6000.0, "key": "", "sha": "bbb"}]))
        (dreaming_home / ".claude-chat-tabs.json").write_text(_json.dumps([
            {"id": 0, "title": "slot"},
            {"id": 7, "title": "ST PM", "cwd": str(dreaming_home / "shellteam" / "api"), "createdAt": 2_000_000},
            {"id": 8, "title": "Later", "cwd": str(dreaming_home / "shellteam"), "createdAt": 9_000_000},
            {"id": 9, "title": "Early", "cwd": str(dreaming_home / "shellteam"), "createdAt": 500_000}]))
        chats = client.get("/api/knowledge/overview", headers=auth_header).json()["chats"]
        assert {c["id"]: c["key"] for c in chats} == {7: "shellteam", 8: "shellteam", 9: "shellteam"}
        one = client.get("/api/knowledge/told?chat=7", headers=auth_header).json()
        assert one["text"] == "OLD TEXT for shellteam" and one["where"] == "~/shellteam" and one["chat"] == "ST PM"
        assert client.get("/api/knowledge/told?chat=8", headers=auth_header).json()["text"] == "NEW TEXT for shellteam"
        early = client.get("/api/knowledge/told?chat=9", headers=auth_header).json()
        assert early["text"] == "OLD TEXT for shellteam" and early["exact"] is False
        assert "before launch texts were kept" in early["note"]
        assert one["exact"] is True
        assert client.get("/api/knowledge/told?folder=shellteam", headers=auth_header).json()["text"] == "NEW TEXT for shellteam"
        assert client.get("/api/knowledge/told?chat=42", headers=auth_header).status_code == 404
        assert client.get("/api/knowledge/told?folder=../x", headers=auth_header).status_code == 400


class TestANightAndItsUndo:
    """K17b: last night's changes, with undo per change and for the night."""

    def _night(self, home, monkeypatch):
        from datetime import date
        from api.services.memory import nightly, switch
        from tests.test_memory_nightly import Model, fact, two_messages
        monkeypatch.delenv("SHELLTEAM_MEMORY_ROOT", raising=False)
        switch.live_path(home).parent.mkdir(parents=True, exist_ok=True)
        switch.live_path(home).write_text('{"since": "%s"}' % date.today().isoformat())
        two_messages(home)
        Model(monkeypatch, extract=lambda p: {"facts": [
            fact("The projects column is the default layout.", "now the default layout for everyone", "decision"),
            fact("Never use a dev branch here.", "never use a dev branch here")]})
        from api.services import dreaming
        return dreaming.run_dream(home)["run"]

    def test_one_change_is_undone_without_touching_a_file(self, client, dreaming_home, auth_header, monkeypatch):
        from api.services.memory.store import Store, memory_root
        run = self._night(dreaming_home, monkeypatch)
        nights = client.get("/api/knowledge/overview", headers=auth_header).json()["nights"]
        assert nights[0]["run"] == run and nights[0]["report"].startswith("memory-night-")
        night = client.get(f"/api/knowledge/night/{run}", headers=auth_header).json()
        added = night["levels"]["shellteam"]["added"]
        assert [a["text"] for a in added] == ["The projects column is the default layout.", "Never use a dev branch here."]
        assert not any(a["undone"] for a in added)
        r = client.post(f"/api/knowledge/night/{run}/undo/{added[1]['id']}", headers=auth_header)
        assert r.status_code == 200
        active = [f.text for f in Store(memory_root(dreaming_home)).active()]
        assert active == ["The projects column is the default layout."]
        card = client.get("/api/knowledge/file?path=shellteam/card.md", headers=auth_header).json()["content"]
        assert "dev branch" not in card, "the views are printed again"
        night = client.get(f"/api/knowledge/night/{run}", headers=auth_header).json()
        assert [a["undone"] for a in night["levels"]["shellteam"]["added"]] == [False, True]
        assert client.post(f"/api/knowledge/night/{run}/undo/{added[1]['id']}", headers=auth_header).status_code == 404

    def test_the_whole_night_is_undone_in_one_action(self, client, dreaming_home, auth_header, monkeypatch):
        from api.services.memory.store import Store, memory_root
        run = self._night(dreaming_home, monkeypatch)
        assert client.post(f"/api/knowledge/night/{run}/undo", headers=auth_header).json()["undone"] >= 1
        assert Store(memory_root(dreaming_home)).active() == []
        assert client.get(f"/api/knowledge/night/{run}", headers=auth_header).json()["undone"] is True
        assert client.get("/api/knowledge/night/19990101-000000", headers=auth_header).status_code == 404
        assert client.post("/api/knowledge/night/..%2Fx/undo", headers=auth_header).status_code in (400, 404, 405)

    def test_no_undo_while_the_job_runs(self, client, dreaming_home, auth_header, monkeypatch):
        from api.services import dreaming
        run = self._night(dreaming_home, monkeypatch)
        monkeypatch.setattr(dreaming, "is_dream_running", lambda home: True)
        assert client.post(f"/api/knowledge/night/{run}/undo", headers=auth_header).status_code == 409

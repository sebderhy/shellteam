"""Knowledge tab API — module gate, path jail, review flow.

The whole surface must be a 404 without the dreaming module (the tab "does
not exist" on a non-dreaming box), and file access must be jailed to
~/.shellteam/knowledge/ even for the authenticated owner.
"""

import pytest

from api import config
from api.services import knowledge_tree as kt


@pytest.fixture
def dreaming_home(monkeypatch, tmp_path):
    """Enable the module and point the owner's HOME at a temp dir."""
    monkeypatch.setattr(config, "MODULES", frozenset({"dreaming"}))
    monkeypatch.setattr(config, "HOME_DIR", tmp_path)
    return tmp_path


class TestModuleGate:
    def test_api_404_without_module(self, client, auth_header):
        assert client.get("/api/knowledge/tree", headers=auth_header).status_code == 404
        assert client.get("/api/knowledge/dream/status", headers=auth_header).status_code == 404

    def test_page_404_without_module(self, client, auth_header):
        assert client.get("/knowledge", headers=auth_header).status_code == 404

    def test_api_requires_auth_even_with_module(self, client, dreaming_home):
        r = client.get("/api/knowledge/tree")
        assert r.status_code in (401, 403)


class TestTreeAndFiles:
    def test_tree_lists_layers_and_nodes(self, client, auth_header, dreaming_home):
        kt.ensure_node(dreaming_home, "acme-project")
        (kt.knowledge_dir(dreaming_home) / "identity.md").write_text("# id\n")
        t = client.get("/api/knowledge/tree", headers=auth_header).json()
        assert [n["node"] for n in t["nodes"]] == ["acme-project"]
        identity = next(e for e in t["user_layer"] if e["path"] == "identity.md")
        assert identity["exists"] is True

    def test_read_write_roundtrip(self, client, auth_header, dreaming_home):
        kt.ensure_node(dreaming_home, "acme-project")
        path = "tree/acme-project/index.md"
        r = client.put("/api/knowledge/file", headers=auth_header,
                       json={"path": path, "content": "# mine now\n"})
        assert r.status_code == 200
        r = client.get(f"/api/knowledge/file?path={path}", headers=auth_header)
        assert r.json()["content"] == "# mine now\n"

    @pytest.mark.parametrize("bad", [
        "../../.ssh/id_rsa.md", "../agent-layer/system-prompt.md",
        "tree/acme-project/../../secrets.md", "identity.txt",
    ])
    def test_path_jail(self, client, auth_header, dreaming_home, bad):
        r = client.get(f"/api/knowledge/file?path={bad}", headers=auth_header)
        assert r.status_code == 400


class TestReviewFlow:
    def test_approve_via_api(self, client, auth_header, dreaming_home):
        kt.apply_delta(dreaming_home, "acme-project", [{
            "action": "add_fact", "file": "index", "section": "Current state",
            "text": "Maybe-fact.", "confidence": "low",
        }], "r1")
        entries = client.get("/api/knowledge/review", headers=auth_header).json()["entries"]
        assert len(entries) == 1
        r = client.post(f"/api/knowledge/review/{entries[0]['id']}",
                        headers=auth_header, json={"approve": True})
        assert r.json()["resolved"] == "approved"
        assert "Maybe-fact." in (kt.node_dir(dreaming_home, "acme-project") / "index.md").read_text()

    def test_unknown_entry_404(self, client, auth_header, dreaming_home):
        r = client.post("/api/knowledge/review/nope", headers=auth_header,
                        json={"approve": False})
        assert r.status_code == 404


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

    def test_latest_report_glob_fallback_pre_upgrade(self, client, auth_header, dreaming_home):
        reports = dreaming_home / "reports"
        reports.mkdir()
        (reports / "dream-2026-07-08.html").write_text("real")
        r = client.get("/api/knowledge/dream/status", headers=auth_header).json()
        assert r["latest_report"] == "/reports/dream-2026-07-08.html"

"""Reports tab (SHE-84): the ~/reports catalog + workspace attribution.

The catalog lists every report and attributes each to the workspace folder the
producing agent was in — recovered from agent transcripts (Claude/Codex), since
nothing records it at write time. These tests pin the listing rules, the
attribution heuristic (earliest transcript wins, incremental watermark), and
the dashboard wiring (hidden-by-default 7th tab, probe reveal, strict preview
sandbox).
"""

import json
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from api.services import report_catalog, reports

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = (ROOT / "frontend/dashboard.html").read_text()
REPORTS_HTML = (ROOT / "frontend/reports.html").read_text()


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A fake owner home with reports and agent transcripts."""
    monkeypatch.setattr(report_catalog, "DATA_DIR", tmp_path / "data")
    h = tmp_path / "home"
    rdir = h / "reports"
    rdir.mkdir(parents=True)
    (rdir / "a.html").write_text("<html><title>Webshop &amp; Friends</title></html>")
    (rdir / "sub").mkdir()
    (rdir / "sub" / "b.md").write_text("# Sub Analysis\ntext")
    (rdir / "c.mp3").write_bytes(b"ID3")
    (rdir / "dream-2026-08-01.html").write_text("<html><title>Dream</title></html>")
    # Never listed: dotfiles, asset bundles, non-report extensions.
    (rdir / ".hidden.html").write_text("x")
    (rdir / "assets").mkdir()
    (rdir / "assets" / "chart.html").write_text("x")
    (rdir / "logo.png").write_bytes(b"\x89PNG")

    claude = h / ".claude" / "projects" / "-home-x-webshop"
    claude.mkdir(parents=True)
    t1 = claude / "session1.jsonl"
    t1.write_text(_write_line(h / "webshop", f"{h}/reports/a.html"))
    os.utime(t1, (1000, 1000))

    # A session that only TALKS about a report (and a Codex rollout, which is
    # not scanned at all) must never attribute — discussion is not authorship.
    chatter = h / ".claude" / "projects" / "-home-x-chatter"
    chatter.mkdir(parents=True)
    t2 = chatter / "session2.jsonl"
    t2.write_text(
        json.dumps({"cwd": str(h / "chatter"), "type": "user",
                    "message": {"content": f"please look at {h}/reports/c.mp3"}}) + "\n"
    )
    os.utime(t2, (2000, 2000))
    codex = h / ".codex" / "sessions" / "2026" / "08" / "29"
    codex.mkdir(parents=True)
    t3 = codex / "rollout-x.jsonl"
    t3.write_text(
        json.dumps({"type": "session_meta", "payload": {"cwd": str(h / "shellteam"), "id": "s1"}})
        + "\n"
        + json.dumps({"type": "event_msg", "payload": {"type": "agent_message",
                      "message": f'"file_path": "{h}/reports/c.mp3"'}}) + "\n"
    )
    os.utime(t3, (2000, 2000))
    return h


def _write_line(cwd, file_path) -> str:
    """A Claude transcript line containing a Write tool call — the authorship
    evidence _WRITE_RE matches."""
    return json.dumps({
        "cwd": str(cwd), "type": "assistant",
        "message": {"content": [{"type": "tool_use", "name": "Write",
                                 "input": {"file_path": str(file_path), "content": "…"}}]},
    }) + "\n"


class TestListing:
    def test_lists_reports_with_metadata_newest_first(self, home):
        entries = report_catalog.list_reports("owner", home)
        paths = [e["path"] for e in entries]
        assert set(paths) == {
            "reports/a.html", "reports/sub/b.md", "reports/c.mp3",
            "reports/dream-2026-08-01.html",
        }
        assert [e["mtime"] for e in entries] == sorted(
            (e["mtime"] for e in entries), reverse=True
        )

    def test_dotfiles_assets_and_images_are_not_reports(self, home):
        paths = {e["path"] for e in report_catalog.list_reports("owner", home)}
        assert not any(".hidden" in p or "assets/" in p or p.endswith(".png") for p in paths)

    def test_titles_parsed_from_html_and_markdown(self, home):
        by_path = {e["path"]: e for e in report_catalog.list_reports("owner", home)}
        assert by_path["reports/a.html"]["title"] == "Webshop & Friends"
        assert by_path["reports/sub/b.md"]["title"] == "Sub Analysis"
        assert by_path["reports/c.mp3"]["title"] is None

    def test_probe_count_and_missing_dir(self, home, tmp_path):
        assert report_catalog.count_reports(home) == 4
        assert report_catalog.count_reports(tmp_path / "nowhere") == 0
        assert report_catalog.list_reports("owner", tmp_path / "nowhere") == []


class TestAttribution:
    def test_only_write_evidence_attributes(self, home):
        by_path = {e["path"]: e for e in report_catalog.list_reports("owner", home)}
        assert by_path["reports/a.html"]["workspace"] == "webshop"      # Write tool call
        # Mentioned in a Claude chat and in a Codex rollout — neither is a write.
        assert by_path["reports/c.mp3"]["workspace"] == report_catalog.UNATTRIBUTED
        assert by_path["reports/sub/b.md"]["workspace"] == report_catalog.UNATTRIBUTED

    def test_dream_reports_fall_back_by_name(self, home):
        by_path = {e["path"]: e for e in report_catalog.list_reports("owner", home)}
        assert by_path["reports/dream-2026-08-01.html"]["workspace"] == "Dreaming"

    def test_earliest_writer_wins_and_scan_is_incremental(self, home):
        report_catalog.refresh_attribution("owner", home)
        # A LATER session re-WRITING a.html (an edit pass from another folder)
        # must not steal the attribution from the session that created it…
        late = home / ".claude" / "projects" / "-home-x-scout" / "session9.jsonl"
        late.parent.mkdir(parents=True)
        late.write_text(
            _write_line(home / "scout", home / "reports" / "a.html")
            + _write_line(home / "scout", home / "reports" / "sub" / "b.md")
        )
        future = time.time() + 60
        os.utime(late, (future, future))
        attribution = report_catalog.refresh_attribution("owner", home)
        assert report_catalog._workspace_label(attribution["a.html"]["cwd"], home) == "webshop"
        # …but its write does claim the previously-unattributed report (keyed
        # by basename, so the sub/ segment is transparent).
        assert report_catalog._workspace_label(attribution["b.md"]["cwd"], home) == "scout"

    def test_v1_index_is_discarded_and_rebuilt(self, home):
        # v1 indexes were mention-based and carry stolen attributions — a
        # version bump must invalidate them wholesale.
        p = report_catalog._index_path("owner")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"watermark": 9e12,
                                 "attribution": {"a.html": {"cwd": "/bogus", "ts": 1}}}))
        attribution = report_catalog.refresh_attribution("owner", home)
        assert report_catalog._workspace_label(attribution["a.html"]["cwd"], home) == "webshop"

    def test_corrupt_index_rebuilds(self, home):
        report_catalog.refresh_attribution("owner", home)
        report_catalog._index_path("owner").write_text("{not json")
        attribution = report_catalog.refresh_attribution("owner", home)
        assert "a.html" in attribution


class TestWorkspaceLabels:
    def test_labels(self, tmp_path):
        home = tmp_path
        f = report_catalog._workspace_label
        assert f(str(home / "webshop" / "code"), home) == "webshop"
        assert f(str(home), home) == "Home"
        assert f(str(home / ".shellteam" / "dream" / "runs" / "x"), home) == "Dreaming"
        assert f(str(home / ".claude"), home) == "Home"
        assert f("/somewhere/else", home) == "else"


class TestRouter:
    @pytest.fixture(autouse=True)
    def _clean_public(self):
        reports._public_reports.clear()
        yield
        reports._public_reports.clear()

    def test_list_merges_public_state(self, client, auth_header, home):
        reports._public_reports["user-uuid-1234"] = {"reports/a.html"}
        with patch("api.routers.computers.containers.user_home_dir", return_value=home):
            resp = client.get("/api/computers/reports/list", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 4
        by_path = {e["path"]: e for e in data["reports"]}
        assert by_path["reports/a.html"]["public"] is True
        assert by_path["reports/c.mp3"]["public"] is False

    def test_probe_is_count_only(self, client, auth_header, home):
        with patch("api.routers.computers.containers.user_home_dir", return_value=home):
            resp = client.get("/api/computers/reports/list?probe=1", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json() == {"count": 4}
        # The probe must never pay for a transcript scan — no index is built.
        assert not report_catalog._index_path("user-uuid-1234").exists()

    def test_requires_auth(self, client, home):
        resp = client.get("/api/computers/reports/list")
        assert resp.status_code == 401

    def test_reports_page_served(self, client):
        resp = client.get("/reports")
        assert resp.status_code == 200
        assert "Reports — ShellTeam" in resp.text


class TestDashboardWiring:
    def test_reports_tab_ships_hidden_and_probe_reveals_it(self):
        assert 'id="reports-tab" style="display:none"' in DASHBOARD
        assert "/api/computers/reports/list?probe=1" in DASHBOARD
        assert "await reportsProbe" in DASHBOARD

    def test_reports_iframe_wired_like_siblings(self):
        assert "case 'reports':  return `/reports?v=${ASSET_VERSION}`" in DASHBOARD
        assert "reports: 'reports-iframe'" in DASHBOARD
        assert 'id="panel-reports" role="tabpanel" aria-labelledby="reports-tab"' in DASHBOARD

    def test_preview_sandbox_is_strict_for_agent_html(self):
        # Agent-produced HTML previews without allow-same-origin (no cookies,
        # no parent DOM) — the same trust split the dashboard side-panel uses.
        assert "const STRICT = 'allow-scripts allow-popups allow-forms allow-downloads'" in REPORTS_HTML
        assert "STRICT + ' allow-same-origin'" in REPORTS_HTML  # only for our /_editor/ SPA

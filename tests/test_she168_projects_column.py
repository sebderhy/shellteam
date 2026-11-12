"""SHE-168 — the projects column, control-plane side.

The cockpit draws the column (computer/ai-chat/test/projects-column-she168.test.mjs
covers that side). Here: the Settings switch that turns it on for every device,
the dashboard wiring around it, the per-project views of the Reports and
Knowledge pages, and a moved chat's reports following it to its new project.
"""

import json
from pathlib import Path

import pytest

from api.routers import settings as settings_router
from api.services import report_catalog

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = (ROOT / "frontend/dashboard.html").read_text()
REPORTS_HTML = (ROOT / "frontend/reports.html").read_text()
KNOWLEDGE_HTML = (ROOT / "frontend/knowledge.html").read_text()
EDITOR_HTML = (ROOT / "computer/file-editor.html").read_text()


@pytest.fixture
def env_file(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("")
    monkeypatch.setenv("SHELLTEAM_ENV_FILE", str(env))
    monkeypatch.delenv("COCKPIT_LAYOUT", raising=False)
    return env


# ── Settings switch ──────────────────────────────────────────────────────────


def test_layout_requires_the_owner(client, env_file):
    assert client.get("/api/settings/layout").status_code == 401
    assert client.post("/api/settings/layout", json={"layout": "projects"}).status_code == 401


def test_layout_defaults_to_tabs_and_is_stored_for_every_device(client, auth_header, env_file):
    assert client.get("/api/settings/layout", headers=auth_header).json() == {"layout": "tabs"}
    resp = client.post("/api/settings/layout", json={"layout": "Projects"}, headers=auth_header)
    assert resp.status_code == 200 and resp.json() == {"layout": "projects"}
    assert "COCKPIT_LAYOUT=projects" in env_file.read_text()
    assert client.get("/api/settings/layout", headers=auth_header).json() == {"layout": "projects"}


def test_layout_rejects_an_unknown_value(client, auth_header, env_file):
    resp = client.post("/api/settings/layout", json={"layout": "sideways"}, headers=auth_header)
    assert resp.status_code == 400
    assert env_file.read_text() == ""


def test_a_hand_edited_unknown_layout_falls_back_to_tabs(monkeypatch):
    monkeypatch.setenv("COCKPIT_LAYOUT", "banana")
    assert settings_router.cockpit_layout() == "tabs"


def test_the_dashboard_is_served_with_the_chosen_layout(client, auth_header, monkeypatch):
    monkeypatch.setenv("COCKPIT_LAYOUT", "projects")
    html = client.get("/", headers=auth_header).text
    assert 'const COCKPIT_LAYOUT = "projects";' in html
    assert "__COCKPIT_LAYOUT__" not in html
    monkeypatch.delenv("COCKPIT_LAYOUT")
    assert 'const COCKPIT_LAYOUT = "tabs";' in client.get("/", headers=auth_header).text


# ── Dashboard wiring ─────────────────────────────────────────────────────────


def test_the_cockpit_frame_stays_on_screen_in_the_projects_layout():
    """The column is inside the cockpit frame: every other screen opens beside it."""
    assert "body.layout-projects #panel-agents { display: flex;" in DASHBOARD
    assert "left: var(--pj-side, 276px)" in DASHBOARD
    assert "+ (PROJECTS_LAYOUT ? '&layout=projects' : '')" in DASHBOARD


def test_project_views_open_trusted_but_only_for_this_dashboards_own_pages():
    """Files / Reports / Knowledge are first-party pages; agent-made HTML never is."""
    assert "x.pathname === '/reports' || x.pathname === '/knowledge'" in DASHBOARD
    assert "if (x.host !== location.host) return false;" in DASHBOARD
    # The cockpit asks for a project view; the dashboard grants it only for those pages.
    assert "openReport(d.url, d.title, d.tool === true && isFirstPartyApp(d.url))" in DASHBOARD


def test_hidden_panel_buttons_are_really_hidden():
    """.report-btn sets display, which beats [hidden] (the SHE-167 trap)."""
    assert ".report-btn[hidden] { display: none; }" in DASHBOARD


def test_reports_and_knowledge_pages_can_show_one_project():
    assert "PARAMS.get('workspace')" in REPORTS_HTML
    assert "j.reports.filter(r => groupName(r) === ONLY_WORKSPACE)" in REPORTS_HTML
    assert "PARAMS.get('project')" in KNOWLEDGE_HTML
    assert "t.nodes.find(n => n.node === ONLY_PROJECT)" in KNOWLEDGE_HTML


def test_the_editor_can_open_on_a_folder():
    assert "const isDir = query.has('dir');" in EDITOR_HTML
    # ...selected and scrolled to the top, not lost somewhere down the home tree.
    assert "currentDir = '/' + filePath + '/';" in EDITOR_HTML
    assert "scrollIntoView({ block: 'start' })" in EDITOR_HTML


# ── A moved chat's reports follow it ─────────────────────────────────────────


def _transcript(home: Path, cwd: str, session: str, *report_names: str) -> None:
    folder = home / ".claude" / "projects" / cwd.replace("/", "-")
    folder.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"cwd": cwd, "type": "user"})]
    for name in report_names:
        lines.append(json.dumps({"cwd": cwd, "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": f"{home}/reports/{name}"}}]}}))
    (folder / f"{session}.jsonl").write_text("\n".join(lines) + "\n")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(report_catalog, "DATA_DIR", tmp_path / "data")
    h = tmp_path / "home"
    (h / "reports").mkdir(parents=True)
    for name in ("magnets.html", "finance.html", "shop.html"):
        (h / "reports" / name).write_text(f"<title>{name}</title>")
    _transcript(h, str(h), "magnet-chat", "magnets.html")
    _transcript(h, str(h), "finance-chat", "finance.html")
    _transcript(h, str(h / "webshop"), "shop-chat", "shop.html")
    return h


def _workspaces(home: Path) -> dict[str, str]:
    return {e["name"]: e["workspace"] for e in report_catalog.list_reports("u", home)}


def _record_move(home: Path, **move) -> None:
    path = home / ".config" / "shellteam" / "moved-sessions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(move) + "\n")


def test_without_a_move_reports_stay_where_they_were_written(home):
    assert _workspaces(home) == {"magnets.html": "Home", "finance.html": "Home", "shop.html": "webshop"}


def test_a_moved_chats_reports_follow_it_and_nobody_elses_do(home):
    _record_move(home, session="magnet-chat", **{"from": str(home), "to": str(home / "magnet-lab")})
    assert _workspaces(home) == {"magnets.html": "magnet-lab", "finance.html": "Home", "shop.html": "webshop"}
    # Listing again (the index is now on disk) gives the same answer.
    assert _workspaces(home)["magnets.html"] == "magnet-lab"


def test_moves_chain_and_survive_a_rebuilt_index(home):
    _record_move(home, session="magnet-chat", **{"from": str(home), "to": str(home / "magnet-lab")})
    # The chat moved again; its new session carries the same write in its transcript.
    _transcript(home, str(home / "magnet-lab"), "magnet-chat-2", "magnets.html")
    _record_move(home, session="magnet-chat-2", **{"from": str(home / "magnet-lab"), "to": str(home / "coreshot")})
    assert _workspaces(home)["magnets.html"] == "coreshot"
    report_catalog._index_path("u").unlink()
    assert _workspaces(home)["magnets.html"] == "coreshot"


def test_a_broken_or_hostile_moves_file_is_skipped_not_fatal(home):
    path = home / ".config" / "shellteam" / "moved-sessions.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text('not json\n{"session": 5}\n'
                    + json.dumps({"session": "../../etc/passwd", "from": str(home), "to": "/x"}) + "\n"
                    + json.dumps({"session": "*", "from": str(home), "to": "/x"}) + "\n")
    assert _workspaces(home) == {"magnets.html": "Home", "finance.html": "Home", "shop.html": "webshop"}


def test_reports_page_is_one_pane_inside_the_project_panel():
    """SHE-171: in the narrow project panel, opening a report left the list
    (and its search box) squeezing it. The panel now behaves like a phone:
    the list, or the report with a Back button."""
    html = (Path(__file__).resolve().parent.parent / "frontend" / "reports.html").read_text()
    assert "classList.toggle('one-pane', !!PARAMS.get('panel') || PHONE.matches)" in html
    assert "body.one-pane.previewing .side { display: none; }" in html
    assert "body.one-pane.previewing #back { display: inline-block; }" in html

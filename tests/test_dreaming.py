"""Dreaming pipeline (gather → route → extract → apply → report).

Extraction (the one LLM call) is mocked throughout — these tests pin the
DETERMINISTIC guarantees: transcript parsing per agent family, tool-noise
stripping, self-ingestion exclusion, the watermark advancing only on success,
loud failure when every extraction dies, preview writing nothing, and the
report/artifact trail existing after every run.
"""

import json
import sqlite3
import time

import pytest

from api.services import dreaming
from api.services import knowledge_tree as kt


NOW = time.time()


# --- fixtures: fabricate each agent family's on-disk transcript format ----------------


def write_claude_session(home, cwd, session_id="s1", *, mtime=None, extra_lines=()):
    d = home / ".claude" / "projects" / str(cwd).replace("/", "-")
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{session_id}.jsonl"
    lines = [
        # user text (string content) — kept
        {"type": "user", "cwd": str(cwd), "sessionId": session_id,
         "message": {"role": "user", "content": "Please fix the deploy script"}},
        # tool_result noise (list content) — stripped
        {"type": "user", "cwd": str(cwd),
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "t1", "content": "SECRET_ENV_DUMP=xyz"}]}},
        # assistant prose + tool_use noise — prose kept, tool_use stripped
        {"type": "assistant", "cwd": str(cwd),
         "message": {"role": "assistant", "content": [
             {"type": "text", "text": "Fixed deploy.sh: it now restarts the API."},
             {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "rm -rf /"}}]}},
        # sidechain (subagent) — whole line skipped
        {"type": "assistant", "isSidechain": True, "cwd": str(cwd),
         "message": {"role": "assistant", "content": [
             {"type": "text", "text": "SIDECHAIN-NOISE"}]}},
        # bookkeeping lines without cwd — ignored
        {"type": "queue-operation"},
        *extra_lines,
    ]
    f.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    import os
    os.utime(f, times=(mtime or NOW, mtime or NOW))
    return f


def write_codex_session(home, cwd, session_id="c1", *, mtime=None):
    d = home / ".codex" / "sessions" / "2026" / "07" / "07"
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"rollout-2026-07-07T01-00-00-{session_id}.jsonl"
    lines = [
        {"timestamp": "t", "type": "session_meta", "payload": {"id": session_id, "cwd": str(cwd)}},
        {"timestamp": "t", "type": "event_msg",
         "payload": {"type": "user_message", "message": "codex user text"}},
        {"timestamp": "t", "type": "event_msg",
         "payload": {"type": "agent_message", "message": "codex assistant text"}},
        {"timestamp": "t", "type": "response_item",
         "payload": {"type": "function_call", "name": "shell", "arguments": "{}"}},
    ]
    f.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    import os
    os.utime(f, times=(mtime or NOW, mtime or NOW))
    return f


def write_opencode_db(home, cwd, session_id="ses_1", *, updated_ms=None):
    d = home / ".local" / "share" / "opencode"
    d.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(d / "opencode.db")
    conn.execute("CREATE TABLE IF NOT EXISTS session (id TEXT, directory TEXT, time_updated INT)")
    conn.execute("CREATE TABLE IF NOT EXISTS message (id TEXT, session_id TEXT, data TEXT)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS part (id TEXT, message_id TEXT, session_id TEXT, data TEXT)")
    conn.execute("INSERT INTO session VALUES (?, ?, ?)",
                 (session_id, str(cwd), updated_ms or int(NOW * 1000)))
    conn.execute("INSERT INTO message VALUES ('m1', ?, ?)",
                 (session_id, json.dumps({"role": "user"})))
    conn.execute("INSERT INTO part VALUES ('p1', 'm1', ?, ?)",
                 (session_id, json.dumps({"type": "text", "text": "opencode user text"})))
    conn.execute("INSERT INTO part VALUES ('p2', 'm1', ?, ?)",
                 (session_id, json.dumps({"type": "tool", "tool": "bash", "state": {}})))
    conn.commit()
    conn.close()


# --- gather ---------------------------------------------------------------------------


class TestGather:
    def test_claude_parse_strips_tool_noise_and_sidechains(self, tmp_path):
        write_claude_session(tmp_path, tmp_path / "acme-project")
        sessions = dreaming.gather_sessions(tmp_path, since=NOW - 60)
        assert len(sessions) == 1
        s = sessions[0]
        assert s.source == "claude" and s.node == "acme-project"
        text = s.transcript()
        assert "fix the deploy script" in text
        assert "Fixed deploy.sh" in text
        assert "SECRET_ENV_DUMP" not in text      # tool_result stripped
        assert "rm -rf" not in text               # tool_use stripped
        assert "SIDECHAIN-NOISE" not in text      # subagent transcript skipped

    def test_codex_and_opencode_parse(self, tmp_path):
        write_codex_session(tmp_path, tmp_path / "acme-project")
        write_opencode_db(tmp_path, tmp_path / "llmdev")
        sessions = {s.source: s for s in dreaming.gather_sessions(tmp_path, since=NOW - 60)}
        assert sessions["codex"].node == "acme-project"
        assert "codex user text" in sessions["codex"].transcript()
        assert "function_call" not in sessions["codex"].transcript()
        assert sessions["opencode"].node == "llmdev"
        assert "opencode user text" in sessions["opencode"].transcript()

    def test_watermark_filters_old_sessions(self, tmp_path):
        write_claude_session(tmp_path, tmp_path / "acme-project", "old", mtime=NOW - 9999)
        assert dreaming.gather_sessions(tmp_path, since=NOW - 60) == []

    def test_self_ingestion_structurally_excluded(self, tmp_path):
        """A session working under ~/.shellteam (e.g. a previous dream's
        extraction) must never enter the corpus."""
        write_claude_session(tmp_path, tmp_path / ".shellteam" / "dream" / "runs" / "x")
        assert dreaming.gather_sessions(tmp_path, since=NOW - 60) == []

    def test_broken_source_does_not_kill_the_sweep(self, tmp_path):
        write_claude_session(tmp_path, tmp_path / "acme-project")
        # A corrupt opencode DB (not sqlite) must be survived, loudly.
        d = tmp_path / ".local" / "share" / "opencode"
        d.mkdir(parents=True)
        (d / "opencode.db").write_text("this is not a database")
        sessions = dreaming.gather_sessions(tmp_path, since=NOW - 60)
        assert [s.source for s in sessions] == ["claude"]


# --- the run: watermark, failure, preview, artifacts ------------------------------------


@pytest.fixture
def fake_extract(monkeypatch):
    """Replace the one LLM call with a canned high-confidence delta."""
    calls = []

    def fake(home, node, sessions, run_cwd):
        calls.append(node)
        return [{"action": "add_fact", "file": "index" if node else "projects",
                 "section": "Current state",
                 "text": f"Learned something about {node or 'the box'}.",
                 "confidence": "high"}]

    monkeypatch.setattr(dreaming, "extract_ops", fake)
    return calls


class TestRunDream:
    def test_full_run_applies_and_advances_watermark(self, tmp_path, fake_extract):
        write_claude_session(tmp_path, tmp_path / "acme-project")
        summary = dreaming.run_dream(tmp_path)
        assert summary["status"] == "ok"
        assert summary["nodes"]["acme-project"]["applied"] == 1
        assert "Learned something about acme-project." in (
            kt.node_dir(tmp_path, "acme-project") / "index.md").read_text()
        state = json.loads(dreaming.state_path(tmp_path).read_text())
        assert state["last_sweep_at"] == pytest.approx(NOW, abs=2)
        # Artifact trail exists.
        run_dir = dreaming.dream_dir(tmp_path) / "runs" / summary["run"]
        assert (run_dir / "sessions.json").exists()
        assert (run_dir / "delta-acme-project.json").exists()
        assert (run_dir / "run.json").exists()
        # Report written.
        assert summary["report"] and "dream-" in summary["report"]

    def test_all_extractions_failed_is_loud_and_no_advance(self, tmp_path, monkeypatch):
        write_claude_session(tmp_path, tmp_path / "acme-project")

        def boom(*a, **k):
            raise RuntimeError("model unavailable")

        monkeypatch.setattr(dreaming, "extract_ops", boom)
        with pytest.raises(RuntimeError, match="every extraction failed"):
            dreaming.run_dream(tmp_path)
        state = json.loads(dreaming.state_path(tmp_path).read_text())
        assert "last_sweep_at" not in state          # watermark NOT advanced
        assert state["last_status"] == "failed"
        # Failure still leaves a report on disk.
        assert list((tmp_path / "reports").glob("dream-*.html"))

    def test_partial_failure_still_advances_and_reports(self, tmp_path, monkeypatch):
        write_claude_session(tmp_path, tmp_path / "acme-project")
        write_codex_session(tmp_path, tmp_path / "llmdev")

        def flaky(home, node, sessions, run_cwd):
            if node == "llmdev":
                raise RuntimeError("boom")
            return [{"action": "add_fact", "file": "index", "section": "Current state",
                     "text": "acme-project fact.", "confidence": "high"}]

        monkeypatch.setattr(dreaming, "extract_ops", flaky)
        summary = dreaming.run_dream(tmp_path)
        assert summary["status"] == "partial"
        assert [f["node"] for f in summary["failures"]] == ["llmdev"]
        assert "last_sweep_at" in json.loads(dreaming.state_path(tmp_path).read_text())

    def test_no_new_sessions_skips_without_advancing(self, tmp_path, fake_extract):
        summary = dreaming.run_dream(tmp_path, since_hours=1)
        assert summary["status"] == "no-new-sessions"
        assert fake_extract == []                     # no LLM call at all
        assert "last_sweep_at" not in json.loads(dreaming.state_path(tmp_path).read_text())

    def test_preview_writes_no_knowledge_and_keeps_watermark(self, tmp_path, fake_extract):
        write_claude_session(tmp_path, tmp_path / "acme-project")
        summary = dreaming.run_dream(tmp_path, preview=True)
        assert summary["nodes"]["acme-project"] == {"proposed": 1}
        assert not (kt.tree_dir(tmp_path)).exists()
        assert "last_sweep_at" not in json.loads(dreaming.state_path(tmp_path).read_text())

    def test_second_run_is_incremental(self, tmp_path, fake_extract):
        write_claude_session(tmp_path, tmp_path / "acme-project")
        dreaming.run_dream(tmp_path)
        summary2 = dreaming.run_dream(tmp_path)
        assert summary2["status"] == "no-new-sessions"


class TestOwnerPass:
    """The user layer starves without a dedicated pass: node batches are
    project-framed and nobody runs agents from bare ~. The owner pass reads
    EVERY session of the day and is the single writer of the user/root layer
    (docs/decisions/20260710-dreaming-owner-pass.md)."""

    def test_owner_pass_reads_all_sessions_including_scratch(self, tmp_path, monkeypatch):
        write_claude_session(tmp_path, tmp_path / "acme-project", "s1")
        write_claude_session(tmp_path, tmp_path / "tmp" / "st-qa", "s2")
        calls = {}

        def fake(home, node, sessions, run_cwd):
            calls[node or "owner"] = sorted(s.cwd for s in sessions)
            return []

        monkeypatch.setattr(dreaming, "extract_ops", fake)
        summary = dreaming.run_dream(tmp_path)
        # Scratch never becomes a project node…
        assert "tmp" not in calls and "tmp" not in summary["nodes"]
        # …but its sessions DO feed the owner pass, alongside everything else.
        assert calls["owner"] == sorted(
            [str(tmp_path / "acme-project"), str(tmp_path / "tmp" / "st-qa")])
        assert calls["acme-project"] == [str(tmp_path / "acme-project")]

    def test_owner_ops_land_in_user_and_root_layer(self, tmp_path, monkeypatch):
        write_claude_session(tmp_path, tmp_path / "acme-project")

        def fake(home, node, sessions, run_cwd):
            if node:
                return []
            return [
                {"action": "add_fact", "file": "identity", "text": "Owner is Seb, a builder.",
                 "confidence": "high"},
                {"action": "add_fact", "file": "contacts",
                 "text": "Alex — external collaborator on ~/acme-project.", "confidence": "high"},
            ]

        monkeypatch.setattr(dreaming, "extract_ops", fake)
        summary = dreaming.run_dream(tmp_path)
        assert summary["nodes"]["owner"]["applied"] == 2
        assert "Seb" in (kt.knowledge_dir(tmp_path) / "identity.md").read_text()
        assert "Alex" in (kt.knowledge_dir(tmp_path) / "contacts.md").read_text()

    def test_owner_prompt_gives_every_session_a_fair_share(self, tmp_path):
        giant = dreaming.Session(
            "claude", "g", str(tmp_path / "acme-project"), "acme-project", NOW,
            [("assistant", "acme-project " + "x" * 600)] * 400)
        small1 = dreaming.Session(
            "claude", "a", str(tmp_path / "llmdev"), "llmdev", NOW,
            [("user", "small-session-one marker")])
        small2 = dreaming.Session(
            "codex", "b", str(tmp_path / "tmp"), "tmp", NOW,
            [("user", "small-session-two marker")])
        prompt = dreaming._owner_prompt(tmp_path, [giant, small1, small2])
        # Greedy newest-first fill would let the giant evict the small ones.
        assert "small-session-one marker" in prompt
        assert "small-session-two marker" in prompt
        assert len(prompt) < dreaming.MAX_OWNER_BATCH_CHARS + 20_000

    def test_owner_prompt_carries_the_routing_rubric(self, tmp_path):
        s = dreaming.Session("claude", "s", str(tmp_path), "", NOW, [("user", "hi")])
        prompt = dreaming._owner_prompt(tmp_path, [s])
        for f in ('"identity"', '"preferences"', '"feedback"', '"projects"', '"contacts"'):
            assert f in prompt
        assert "OWNER pass" in prompt

    def test_prompt_asks_for_succinct_facts_and_autonomous_confidence(self, tmp_path):
        s = dreaming.Session("claude", "s", str(tmp_path / "p"), "p", NOW, [("user", "hi")])
        prompt = dreaming._project_prompt(tmp_path, "p", [s])
        assert "≤200 chars" in prompt and "One fact per op" in prompt
        # Confidence guidance tells the model high+medium are recorded
        # automatically and low is the only reviewed bucket.
        assert "recorded automatically" in prompt and "real doubt" in prompt

    def test_project_prompt_excludes_owner_facts_and_user_layer(self, tmp_path):
        s = dreaming.Session(
            "claude", "s", str(tmp_path / "acme-project"), "acme-project", NOW, [("user", "hi")])
        prompt = dreaming._project_prompt(tmp_path, "acme-project", [s])
        assert "do NOT propose them here" in prompt
        assert '"feedback"' not in prompt and '"identity"' not in prompt

    def test_first_run_mines_two_weeks(self):
        assert dreaming.FIRST_RUN_LOOKBACK_S == 14 * 24 * 3600

    def test_state_records_last_report(self, tmp_path, fake_extract):
        write_claude_session(tmp_path, tmp_path / "acme-project")
        summary = dreaming.run_dream(tmp_path)
        state = json.loads(dreaming.state_path(tmp_path).read_text())
        assert state["last_report"] == summary["report"].rsplit("/", 1)[-1]


class TestHygieneReportOnly:
    def test_stale_tabs_and_tmp_surfaced_never_deleted(self, tmp_path):
        (tmp_path / ".claude-chat-tabs.json").write_text(json.dumps([
            {"id": 0, "title": "slot0", "lastUsedAt": 0},
            {"id": 3, "title": "old tab", "cwd": "/x", "lastUsedAt": 0},
            {"id": 4, "title": "fresh", "lastUsedAt": int(NOW * 1000)},
        ]))
        old = tmp_path / "tmp" / "old.bin"
        old.parent.mkdir()
        old.write_bytes(b"x" * 2_000_000)
        import os
        os.utime(old, times=(NOW - 10 * 86400, NOW - 10 * 86400))

        report = dreaming.hygiene_report(tmp_path)
        assert [t["id"] for t in report["stale_tabs"]] == [3]  # slot 0 + fresh kept out
        assert report["tmp"]["stale_files"] == 1
        assert old.exists()                                     # report-only: nothing deleted
        tabs = json.loads((tmp_path / ".claude-chat-tabs.json").read_text())
        assert len(tabs) == 3


class TestDreamDigestNotification:
    """The morning dream digest is an OPTIONAL ping — the report is always on
    disk in the Knowledge layer. When no notify channel is configured it must
    stay quiet (INFO), not fire notify's loud "dropping" WARNING."""

    _SUMMARY = {"status": "ok", "sessions": 1, "report": None,
                "nodes": {"acme-project": {"applied": 1, "queued": 0}}}

    def test_silent_when_no_notify_channel(self, monkeypatch):
        from api.services import notify
        calls = {"n": 0}

        async def _spy(*a, **k):
            calls["n"] += 1
            return {"channel": "none", "ok": False}

        monkeypatch.setattr(notify, "notify_channel", lambda: "none")
        monkeypatch.setattr(notify, "send_notification", _spy)
        dreaming._notify_owner(self._SUMMARY)
        assert calls["n"] == 0   # never even reaches the notify choke-point

    def test_pings_when_channel_configured(self, monkeypatch):
        from api.services import notify
        calls = {"n": 0}

        async def _spy(*a, **k):
            calls["n"] += 1
            return {"channel": "ntfy", "ok": True}

        monkeypatch.setattr(notify, "notify_channel", lambda: "ntfy")
        monkeypatch.setattr(notify, "send_notification", _spy)
        dreaming._notify_owner(self._SUMMARY)
        assert calls["n"] == 1

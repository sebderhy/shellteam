"""The recall exam (K10): what it may read, what it asks, how it scores."""

import json
import os
import time
from pathlib import Path

import pytest

from api.services import dreaming, memory_exam as ex, memory_exam_guard as guard
from api.services.memory import reading, search

NOW = time.time()


def _claude_session(home: Path, cwd: Path, sid: str, turns: int = 3) -> None:
    d = home / ".claude" / "projects" / str(cwd).replace("/", "-")
    d.mkdir(parents=True, exist_ok=True)
    lines = []
    for n in range(turns):
        lines.append({"type": "user", "cwd": str(cwd), "message": {"content": f"owner says {n}"}})
        lines.append({"type": "assistant", "cwd": str(cwd),
                      "message": {"content": [{"type": "text", "text": f"agent says {n}"}]}})
    (d / f"{sid}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")


class TestGuard:
    @pytest.mark.parametrize("tool,tool_input", [
        ("Write", {"file_path": "/tmp/x"}),
        ("Edit", {"file_path": "/home/user/shellteam/a.py"}),
        ("mcp__linear__save_issue", {"title": "x"}),
        ("Agent", {"prompt": "look around"}),
        ("Bash", {"command": "grep -r layout ~/.claude/projects"}),
        ("Read", {"file_path": "/home/user/.claude/projects/-home-seb-shellteam/abc.jsonl"}),
        ("Bash", {"command": "ls /home/user/.codex/sessions/2026"}),
        ("Grep", {"pattern": "layout", "path": "/home/user/conversations"}),
        ("Bash", {"command": "cat ~/.shellteam/exam/sets/frozen.json"}),
        ("Read", {"file_path": "/home/user/.claude/projects/-home-seb-shellteam/memory/MEMORY.md"}),
        # 14 Nov 2026: an agent opened an exam report while searching ~/reports
        # and read the answer key of the question it was asked.
        ("Read", {"file_path": "/home/user/reports/memory-exam-search2.html"}),
        ("Bash", {"command": "sed -n 1,80p ~/reports/memory-exam-baseline.html"}),
    ])
    def test_refused(self, tool, tool_input):
        assert guard.reason_blocked(tool, tool_input, {"EXAM_OWN_MEMORY": "0"})

    @pytest.mark.parametrize("tool,tool_input", [
        ("Read", {"file_path": "/home/user/shellteam/README.md"}),
        ("Bash", {"command": "git log --oneline -5"}),
        ("Read", {"file_path": "/home/user/.shellteam/knowledge/tree/shellteam/index.md"}),
        ("Grep", {"pattern": "conversations", "path": "/home/user/shellteam/docs"}),
    ])
    def test_allowed(self, tool, tool_input):
        assert guard.reason_blocked(tool, tool_input, {"EXAM_OWN_MEMORY": "0"}) == ""

    def test_own_notes_readable_only_in_the_arm_that_measures_them(self):
        notes = {"file_path": "/home/user/.claude/projects/-home-seb-shellteam/memory/MEMORY.md"}
        assert guard.reason_blocked("Read", notes, {"EXAM_OWN_MEMORY": "1"}) == ""
        both = {"command": "cat ~/.claude/projects/x/memory/a.md ~/.claude/projects/x/s.jsonl"}
        assert guard.reason_blocked("Bash", both, {"EXAM_OWN_MEMORY": "1"})

    def test_memory_off_arm_closes_shellteam_memory(self):
        f = {"file_path": "/home/user/.shellteam/memory/views/_top/card.md"}
        assert guard.reason_blocked("Read", f, {"EXAM_SHELLTEAM_MEMORY": "0"})
        assert guard.reason_blocked("Read", f, {"EXAM_SHELLTEAM_MEMORY": "1"}) == ""
        cmd = {"command": "/home/user/shellteam/bin/shellteam-memory search release tags"}
        assert guard.reason_blocked("Bash", cmd, {"EXAM_SHELLTEAM_MEMORY": "0"})
        assert guard.reason_blocked("Bash", cmd, {"EXAM_SHELLTEAM_MEMORY": "1"}) == ""


class TestKeptOutOfTheNightlyJob:
    def test_the_exams_own_model_calls_run_where_the_nightly_job_never_reads(self, tmp_path):
        work = ex._scratch(tmp_path, "grade-x")
        _claude_session(tmp_path, work, "exam-call")
        _claude_session(tmp_path, tmp_path / "proj", "real-chat")
        read = reading.gather(tmp_path, {}, NOW - 60).conversations
        assert [c.session_id for c in read] == ["real-chat"]

    def test_agents_under_test_save_no_conversation(self, tmp_path, monkeypatch):
        monkeypatch.setattr(dreaming.llm_gateway, "apply_gateway", lambda *a: None)
        # Started from a cockpit chat with own memory off: the arm still decides.
        monkeypatch.setenv("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")
        layer = {"claude": ["--mcp-config", "/x.json", "--append-system-prompt-file", "/p.md"],
                 "codex": ["-c", 'mcp_servers.docs.url="u"', "-c", 'developer_instructions="hi"'],
                 "codexEnv": {"HOME": "/overlay"}}
        claude, env = ex.claude_command(layer, ex.ARMS["tree"], "m", tmp_path)
        assert "--no-session-persistence" in claude
        assert "--mcp-config" not in claude and "--strict-mcp-config" in claude
        assert claude[-2:] == ["--append-system-prompt-file", "/p.md"]
        assert env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"
        assert "ANTHROPIC_API_KEY" not in env
        _, env = ex.claude_command(layer, ex.ARMS["tree+own"], "m", tmp_path)
        assert "CLAUDE_CODE_DISABLE_AUTO_MEMORY" not in env and env["EXAM_OWN_MEMORY"] == "1"
        codex, env = ex.codex_command(layer, ex.ARMS["tree"], None, tmp_path, tmp_path)
        assert "--ephemeral" in codex and 'developer_instructions="hi"' in codex
        assert not any(a.startswith("mcp_servers.") for a in codex)
        assert env["HOME"] == "/overlay"


class TestGenerate:
    def test_only_real_conversations_and_no_folder_fills_the_exam(self, tmp_path):
        for n in range(4):
            _claude_session(tmp_path, tmp_path / "big", f"big{n}")
        _claude_session(tmp_path, tmp_path / "small", "small0")
        _claude_session(tmp_path, tmp_path / "small", "oneshot", turns=1)
        _claude_session(tmp_path, tmp_path / "small", "small1", turns=2)
        _claude_session(tmp_path, tmp_path / "tmp", "scratch0")
        sessions = ex.conversations(tmp_path, 14)
        assert "oneshot" not in {s.session_id for s in sessions}
        picked = ex.spread(sessions, tmp_path, 3)
        assert {ex.ask_folder(tmp_path, s) for s in picked} == {
            tmp_path / "big", tmp_path / "small", tmp_path}

    def test_a_long_conversation_gives_pieces_from_its_whole_length(self, monkeypatch):
        monkeypatch.setattr(ex, "CHUNK_CHARS", 60)
        monkeypatch.setattr(ex, "MAX_CHUNKS", 3)
        s = reading.Conversation("claude:s", "claude", "s", "/x", "x", [
            reading.Message("owner", f"message number {n:02d} " + "x" * 20, NOW, None) for n in range(20)])
        pieces = ex.chunks(s)
        assert len(pieces) == 3
        assert "number 00" in pieces[0] and "number 19" in pieces[-1]
        assert "number 00" not in pieces[1] and "number 19" not in pieces[1]

    def test_set_is_built_per_kind_and_never_overwritten(self, tmp_path, monkeypatch):
        _claude_session(tmp_path, tmp_path / "alpha", "a")
        _claude_session(tmp_path, tmp_path / "beta", "b")

        def fake_engine(home, prompt, work, tag):
            if tag == "select":
                ids = [json.loads(l)["id"] for l in prompt.splitlines() if l.startswith('{"id"')]
                return json.dumps({"recent": ids, "changed": ids, "lookup": ids,
                                   "should_not_know": ids}), 0
            folder = "alpha" if "~/alpha" in prompt else "beta"
            return json.dumps({"questions": [
                {"kind": "recent", "question": f"{folder} layout?", "answer": "projects",
                 "support": "s", "about_project": True},
                {"kind": "changed", "question": f"{folder} opt-in?", "answer": "no",
                 "old_answer": "yes", "support": "s", "about_project": True},
                {"kind": "bogus", "question": "x", "answer": "y"},
            ]}), 0

        monkeypatch.setattr(dreaming, "ask_engine", fake_engine)
        path = ex.generate(tmp_path, "t", workers=1)
        qs = json.loads(path.read_text())["questions"]
        assert [q["kind"] for q in qs].count("recent") == 2
        assert [q["kind"] for q in qs].count("changed") == 2
        assert not [q for q in qs if q["kind"] in ("lookup", "should_not_know")], \
            "a question is used once, under its own kind"
        assert all(q["source"]["session"] in ("a", "b") for q in qs)
        with pytest.raises(FileExistsError):
            ex.generate(tmp_path, "t")

    def test_should_not_know_is_asked_from_another_project(self, tmp_path):
        q = {"folder": "~/alpha"}
        assert ex._other_project(tmp_path, q, ["~/alpha", "~/beta"], 0) == "~/beta"
        with pytest.raises(ValueError):
            ex._other_project(tmp_path, q, ["~/alpha"], 0)


class TestReadingAnswers:
    def test_claude_stream(self):
        out = ex._read_claude("\n".join(json.dumps(x) for x in [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Read", "input": {}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "is_error": True, "content": guard.REFUSAL}]}},
            {"type": "result", "result": "the projects column", "total_cost_usd": 0.3,
             "num_turns": 2, "is_error": False},
        ]))
        assert out["answer"] == "the projects column"
        assert out["tools"] == ["Read"] and out["refused"] == 1 and not out["failed"]

    def test_codex_stream_flags_a_conversation_store(self):
        events = [
            {"type": "item.completed", "item": {"type": "command_execution",
                                                "command": "grep -r x ~/.codex/sessions"}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "found it"}},
            {"type": "turn.completed", "usage": {"input_tokens": 5}},
        ]
        out = ex._read_codex("\n".join(json.dumps(e) for e in events), ex.ARMS["tree"])
        assert out["answer"] == "found it" and out["contaminated"] and out["tokens"]


class TestGradeAndSummary:
    def _seed(self, home: Path) -> None:
        ex.set_path(home, "s").parent.mkdir(parents=True)
        ex.set_path(home, "s").write_text(json.dumps({"name": "s", "questions": [
            {"id": "q001", "kind": "recent", "folder": "~/alpha", "question": "layout?",
             "answer": "projects", "old_answer": "", "support": "s"},
            {"id": "q002", "kind": "changed", "folder": "~/alpha", "question": "opt-in?",
             "answer": "no", "old_answer": "yes", "support": "s"},
            {"id": "q003", "kind": "lookup", "folder": "~/alpha", "question": "tags?",
             "answer": "tags", "old_answer": "", "support": "s"},
            {"id": "q004", "kind": "should_not_know", "folder": "~/beta", "asked_from": "~/alpha",
             "question": "beta rule?", "answer": "no dev branch", "old_answer": "", "support": "s"},
        ]}))
        d = ex.run_dir(home, "r")
        d.mkdir(parents=True)
        (d / "claude--today.arm.json").write_text(json.dumps({
            "set": "s", "agent": "claude", "arm": "tree", "what": "w", "own_memory": False,
            "shellteam_memory": "live", "model": "m",
            "launch_text": {"~/alpha": "beta has no dev branch"}}))
        (d / "claude--today.answers.jsonl").write_text("\n".join(json.dumps(a) for a in [
            {"id": "q001", "answer": "the projects column", "tools": [], "seconds": 4, "cost_usd": 0.3},
            {"id": "q002", "answer": "", "failed": True, "tools": [], "seconds": 420},
            {"id": "q003", "answer": "tags", "contaminated": True, "tools": ["shell"], "seconds": 9},
        ]) + "\n")

    def test_scores_per_kind(self, tmp_path, monkeypatch):
        self._seed(tmp_path)
        seen = []

        def fake_engine(home, prompt, work, tag):
            seen.append(prompt)
            if "leak" in tag:
                return json.dumps({"grades": [{"id": "q004", "verdict": "leak"}]}), 0
            return json.dumps({"grades": [{"id": "q001", "verdict": "right", "note": "ok"}]}), 0

        monkeypatch.setattr(dreaming, "ask_engine", fake_engine)
        ex.grade(tmp_path, "r", workers=1)
        assert len(seen) == 2, "a failed or contaminated answer needs no model to grade"
        arm = ex.summarize(tmp_path, "r")["arms"][0]
        assert ex.score(arm["kinds"]["recent"]) == 100
        assert arm["kinds"]["changed"] == {"n": 1, "unknown": 1}
        assert arm["kinds"]["lookup"] == {"n": 1, "wrong": 1}
        assert ex.score(arm["kinds"]["should_not_know"]) == 0
        assert arm["no_answer"] == 1 and arm["contaminated"] == 1
        assert arm["launch_chars"] == {"~/alpha": 22}
        assert arm["notional_cost_usd"] == 0.3

    def test_detail_the_question_did_not_ask_for_is_not_required(self, tmp_path, monkeypatch):
        """Owner, 2026-11-14: an answer that answers the question passes; old
        grades are regraded on request and kept aside, never lost."""
        self._seed(tmp_path)
        prompts = []

        def fake_engine(home, prompt, work, tag):
            prompts.append(prompt)
            if "leak" in tag:
                return json.dumps({"grades": [{"id": "q004", "verdict": "clean"}]}), 0
            return json.dumps({"grades": [{"id": "q001", "verdict": "right", "note": "ok"}]}), 0

        monkeypatch.setattr(dreaming, "ask_engine", fake_engine)
        d = ex.run_dir(tmp_path, "r")
        (d / "claude--today.grades.json").write_text(json.dumps([{"id": "q001", "verdict": "partly"}]))
        ex.grade(tmp_path, "r", workers=1)
        assert prompts == [], "graded arms are left alone without --again"
        ex.grade(tmp_path, "r", workers=1, again=True)
        assert "Judge the answer against the QUESTION" in prompts[0]
        assert json.loads((d / "claude--today.grades-v1.json").read_text())[0]["verdict"] == "partly"
        assert {g["id"]: g["verdict"] for g in json.loads((d / "claude--today.grades.json").read_text())}["q001"] == "right"
        prompts.clear()
        ex.grade(tmp_path, "r", workers=1, again=True)
        assert prompts == [], "an arm already graded by this grader is not regraded"

    def test_an_arm_not_graded_yet_does_not_stop_the_summary(self, tmp_path):
        """Regression: an arm still running (answers, no grades) crashed the
        summary of the whole run while picking answers for the hand check."""
        self._seed(tmp_path)
        arm = ex.summarize(tmp_path, "r")["arms"][0]
        assert arm["kinds"] == {} and arm["hand_check"] == [] and arm["asked"] == 3

    def test_a_grader_that_skips_an_item_fails_loudly(self, tmp_path, monkeypatch):
        self._seed(tmp_path)
        monkeypatch.setattr(dreaming, "ask_engine", lambda *a: (json.dumps({"grades": []}), 0))
        with pytest.raises(ValueError, match="no usable verdict"):
            ex.grade(tmp_path, "r", workers=1)


def test_a_report_keeps_the_answer_key_out_of_reach_of_a_text_search():
    """The hand-check section shows questions, keys and answers to the owner,
    but a grep over ~/reports by an agent sitting the exam must not find
    them: they are written encoded and shown by the page itself."""
    import base64
    from api.services import memory_exam_report as report
    check = {"id": "q1", "kind": "recent", "folder": "~/x", "question": "Which zebra?",
             "key": "The striped zebra named Okapi.", "answer": "Okapi, the zebra.",
             "verdict": "right", "note": "names the zebra"}
    arm = {"agent": "claude", "arm": "tree", "what": "Tree", "set": "s", "model": "m", "own_memory": False, "shellteam_memory": "tree", "kinds": {}, "launch_chars": {},
           "asked": 1, "to_ask": 1, "no_answer": 0, "contaminated": 0, "refused_calls": 0,
           "lookups_per_question": 0, "seconds_per_question": 0, "wall_seconds": None,
           "notional_cost_usd": None, "hand_check": [check]}
    html = report.render({"run": "r", "written": "2026-11-14T12:00:00", "margin": "m", "arms": [arm]})
    for text in ("zebra", "Okapi"):
        assert text.lower() not in html.lower()
    blob = html.split('data-checks="')[1].split('"')[0]
    assert json.loads(base64.b64decode(blob))[0][0]["key"] == "The striped zebra named Okapi."


def test_a_run_stops_when_answers_stop_coming_and_resumes_later(tmp_path, monkeypatch):
    """A usage limit must not burn through the question list: the run stops,
    keeps what it has, and asks the unanswered ones again next time."""
    ex.set_path(tmp_path, "s").parent.mkdir(parents=True)
    ex.set_path(tmp_path, "s").write_text(json.dumps({"name": "s", "questions": [
        {"id": f"q{n:03d}", "kind": "recent", "folder": "~", "question": "?", "answer": "a",
         "old_answer": "", "support": "s"} for n in range(12)]}))
    monkeypatch.setattr(ex, "launch_layer", lambda folder, arm: {"launchText": ""})
    limit_hit = {"on": True}

    def fake_ask(home, agent, arm, model, layer, q, exclude=""):
        if limit_hit["on"] and q["id"] >= "q003":
            return {"id": q["id"], "answer": "", "failed": True, "error": "usage limit"}
        return {"id": q["id"], "answer": "a", "failed": False}

    monkeypatch.setattr(ex, "ask", fake_ask)
    with pytest.raises(RuntimeError, match="usage limit"):
        ex.run(tmp_path, "s", "r", "codex", "tree", workers=1)
    answers = ex.run_dir(tmp_path, "r") / "codex--tree.answers.jsonl"
    assert len(answers.read_text().splitlines()) == 3
    limit_hit["on"] = False
    ex.run(tmp_path, "s", "r", "codex", "tree", workers=1)
    assert len(answers.read_text().splitlines()) == 12


def test_search_never_finds_the_conversations_the_questions_came_from(tmp_path, monkeypatch):
    """K13: during the exam the memory search leaves out every source
    conversation of the set, passed to each agent in its environment."""
    ex.set_path(tmp_path, "s").parent.mkdir(parents=True)
    ex.set_path(tmp_path, "s").write_text(json.dumps({"name": "s", "questions": [
        {"id": f"q{n}", "kind": "recent", "folder": "~", "question": "?", "answer": "a", "old_answer": "",
         "support": "s", "source": {"agent": "claude", "session": f"sess-{n % 2}"}} for n in range(3)]}))
    monkeypatch.setattr(ex, "launch_layer", lambda folder, arm: {"launchText": "", "claude": []})
    monkeypatch.setattr(dreaming.llm_gateway, "apply_gateway", lambda *a: None)
    seen = []

    class Proc:
        stdout, stderr, returncode = "", "", 0

    def fake_run(argv, **kw):
        seen.append(kw["env"][search.EXCLUDE_ENV])
        return Proc()

    monkeypatch.setattr(ex.subprocess, "run", fake_run)
    monkeypatch.setattr(ex, "STOP_AFTER_FAILURES", 99)
    ex.run(tmp_path, "s", "r", "claude", "tree", workers=1)
    assert seen and set(seen) == {"sess-0,sess-1"}

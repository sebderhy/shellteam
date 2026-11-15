"""Dreaming: the night's entry point and the engine every memory model call uses.

The night itself is tested in test_memory_nightly.py. These pin the engine's
contract (argv, environment, answer parsing, per engine), the housekeeping
notes, and the morning ping.
"""

import json
import time
from pathlib import Path

import pytest

from api.services import dreaming


NOW = time.time()


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

    _SUMMARY = {"status": "ok", "run": "20261114-034400", "report": None}

    def test_silent_when_no_notify_channel(self, monkeypatch):
        from api.services import notify
        calls = {"n": 0}

        async def _spy(*a, **k):
            calls["n"] += 1
            return {"channel": "none", "ok": False}

        monkeypatch.setattr(notify, "notify_channel", lambda: "none")
        monkeypatch.setattr(notify, "send_notification", _spy)
        dreaming._notify_owner(self._SUMMARY, "~/acme: 1 added.")
        assert calls["n"] == 0   # never even reaches the notify choke-point

    def test_pings_when_channel_configured(self, monkeypatch):
        from api.services import notify
        calls = {"n": 0}

        async def _spy(*a, **k):
            calls["n"] += 1
            return {"channel": "ntfy", "ok": True}

        monkeypatch.setattr(notify, "notify_channel", lambda: "ntfy")
        monkeypatch.setattr(notify, "send_notification", _spy)
        dreaming._notify_owner(self._SUMMARY, "~/acme: 1 added.")
        assert calls["n"] == 1


# --- the extraction engine: claude -p vs codex exec (DREAM_ENGINE) -----------------------
# docs/decisions/20260903-dreaming-engine-choice.md. The LLM call itself is
# faked at subprocess.run; these pin the argv/env/parsing contract per engine.


class TestExtractionEngine:
    @pytest.fixture
    def run_dir(self, tmp_path):
        d = tmp_path / ".shellteam" / "dream" / "runs" / "t"
        d.mkdir(parents=True)
        return d

    @staticmethod
    def _capture(monkeypatch, *, stdout="", rc=0, on_run=None):
        calls = []

        class Proc:
            def __init__(self):
                self.stdout, self.stderr, self.returncode = stdout, "", rc

        def fake_run(argv, **kw):
            calls.append({"argv": argv, **kw})
            if on_run:
                on_run(argv)
            return Proc()

        monkeypatch.setattr(dreaming.subprocess, "run", fake_run)
        return calls

    def test_default_engine_is_claude_and_strips_every_metered_key(
        self, tmp_path, run_dir, monkeypatch
    ):
        monkeypatch.delenv("DREAM_ENGINE", raising=False)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-leak")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-oa-leak")
        result = {"result": '{"facts": []}', "total_cost_usd": 0.01}
        calls = self._capture(monkeypatch, stdout=json.dumps(result))
        text, cost = dreaming.ask_engine(tmp_path, "PROMPT-TEXT", run_dir, "acme")
        assert text == '{"facts": []}' and cost == 0.01
        (call,) = calls
        assert call["argv"][:4] == ["claude", "-p", "--model", "opus"]
        assert call["argv"][call["argv"].index("--tools") + 1] == ""   # it may only answer
        assert "ANTHROPIC_API_KEY" not in call["env"] and "OPENAI_API_KEY" not in call["env"]
        assert call["input"] == "PROMPT-TEXT"  # the prompt travels on stdin
        assert (run_dir / "response-acme.json").exists()

    def test_codex_engine_argv_reads_final_message_and_stays_ephemeral(
        self, tmp_path, run_dir, monkeypatch
    ):
        monkeypatch.setenv("DREAM_ENGINE", "codex")
        monkeypatch.delenv("DREAM_CODEX_MODEL", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-oa-leak")

        def write_final_message(argv):
            out = Path(argv[argv.index("-o") + 1])
            out.write_text('Sure.\n{"facts": [{"text": "from codex"}]}')

        calls = self._capture(monkeypatch, stdout="banner\ncodex\n{...}\ntokens used\n5", on_run=write_final_message)
        text, _ = dreaming.ask_engine(tmp_path, "PROMPT", run_dir, "owner")
        assert dreaming.parse_json_object(text) == {"facts": [{"text": "from codex"}]}
        (call,) = calls
        argv = call["argv"]
        assert argv[:2] == ["codex", "exec"]
        for flag in ("--ephemeral", "--skip-git-repo-check"):
            assert flag in argv
        assert argv[argv.index("-s") + 1] == "read-only"
        assert argv[argv.index("-C") + 1] == str(run_dir)
        assert "-m" not in argv  # no model set → the CLI's own default
        assert "OPENAI_API_KEY" not in call["env"]
        assert call["input"]  # prompt travels on stdin
        assert (run_dir / "codex-owner.log").read_text().startswith("banner")

    def test_codex_model_override(self, tmp_path, run_dir, monkeypatch):
        monkeypatch.setenv("DREAM_ENGINE", "codex")
        monkeypatch.setenv("DREAM_CODEX_MODEL", "gpt-5.6-sol")
        calls = self._capture(
            monkeypatch,
            on_run=lambda argv: Path(argv[argv.index("-o") + 1]).write_text('{"facts": []}'),
        )
        dreaming.ask_engine(tmp_path, "PROMPT", run_dir, "acme")
        argv = calls[0]["argv"]
        assert argv[argv.index("-m") + 1] == "gpt-5.6-sol"
        assert dreaming.engine_label("codex") == "codex/gpt-5.6-sol"

    def test_codex_without_final_message_fails_loudly(
        self, tmp_path, run_dir, monkeypatch
    ):
        monkeypatch.setenv("DREAM_ENGINE", "codex")
        self._capture(monkeypatch, stdout="banner only")
        with pytest.raises(RuntimeError, match="no final message"):
            dreaming.ask_engine(tmp_path, "PROMPT", run_dir, "acme")

    def test_nonzero_exit_names_the_engine(self, tmp_path, run_dir, monkeypatch):
        monkeypatch.setenv("DREAM_ENGINE", "codex")
        self._capture(monkeypatch, rc=2)
        with pytest.raises(RuntimeError, match="codex extraction failed"):
            dreaming.ask_engine(tmp_path, "PROMPT", run_dir, "acme")

    def test_unknown_engine_is_a_loud_error_not_a_fallback(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DREAM_ENGINE", "gemini")
        with pytest.raises(ValueError, match="DREAM_ENGINE"):
            dreaming.dream_engine()
        # And the whole night refuses before it moves or reads anything.
        with pytest.raises(ValueError, match="DREAM_ENGINE"):
            dreaming.run_dream(tmp_path)
        assert not (tmp_path / ".shellteam" / "memory" / "live.json").exists()

    def test_engine_is_read_at_call_time_not_import_time(self, monkeypatch):
        monkeypatch.setenv("DREAM_ENGINE", "claude")
        assert dreaming.dream_engine() == "claude"
        monkeypatch.setenv("DREAM_ENGINE", "codex")  # what the Settings toggle does
        assert dreaming.dream_engine() == "codex"

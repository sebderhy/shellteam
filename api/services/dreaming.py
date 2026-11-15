"""Dreaming: the nightly memory job's entry point and its model engine.

ONE host-orchestrated run (systemd timer or the owner's "run now"). The night
itself is ``api/services/memory/nightly.py``: it reads conversations by
bookmark and changes memory by operation
(docs/decisions/20261113-memory-nightly-operations.md). This module holds what
the night, the one-time move and the recall exam share: the headless model
call on the owner's subscription (``ask_engine``), the run lock, the
housekeeping notes, the morning ping.

A box that still has the old knowledge files moves them into the knowledge
tree on its first night (``memory.switch.move_in``). There is no other path.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

from api.config import child_env
from api.services import llm_gateway

log = logging.getLogger("shellteam.dream")

# --- tunables (env-overridable where it matters) --------------------------------------

# `or` (not a get() default): a BLANK value in .env must fall back too — this
# module is imported by api.main unconditionally, so a crash here (int(""))
# would take the whole control plane down even with the module off.
DREAM_MODEL = os.environ.get("DREAM_MODEL") or "opus"
# Which coding-agent CLI runs the extraction. Read at CALL time (not import
# time): the Settings toggle persists DREAM_ENGINE to .env AND os.environ, and
# an owner "dream now" runs inside the long-lived API process, so a module
# constant would keep dreaming with the old engine until the next restart.
DREAM_ENGINES = ("claude", "codex")
# Both engines ride the owner's subscription: every metered key is stripped
# from the subprocess env so neither CLI can silently bill an API key instead
# (an ambient ANTHROPIC_API_KEY once cost $575 this way).
_METERED_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
EXTRACT_TIMEOUT_S = int(os.environ.get("DREAM_EXTRACT_TIMEOUT") or "600")
STALE_TAB_DAYS = 7
STALE_TMP_DAYS = 3


def dream_dir(home: Path) -> Path:
    return home / ".shellteam" / "dream"


def state_path(home: Path) -> Path:
    return dream_dir(home) / "state.json"


def is_dream_running(home: Path) -> bool:
    """True when ANY dream run holds the flock — including the nightly
    systemd-timer run, which lives in a different process than the API and
    would otherwise be invisible to the Knowledge tab."""
    lock_path = dream_dir(home) / "lock"
    if not lock_path.exists():
        return False
    with lock_path.open("a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(f, fcntl.LOCK_UN)
        return False


# --- the engine ----------------------------------------------------------------------


def dream_engine() -> str:
    """The configured extraction engine, validated. Unknown values raise —
    a typo in .env must fail the sweep loudly, never fall back to a default."""
    engine = (os.environ.get("DREAM_ENGINE") or "claude").strip().lower()
    if engine not in DREAM_ENGINES:
        raise ValueError(
            f"DREAM_ENGINE={engine!r} is not one of {', '.join(DREAM_ENGINES)}"
        )
    return engine


def dream_model(engine: str) -> str | None:
    """Model the engine's CLI is asked for. Claude keeps DREAM_MODEL (Opus by
    default). Codex uses DREAM_CODEX_MODEL when set, else the Codex CLI's own
    default — the flagship the account is entitled to, which differs between
    personal and enterprise ChatGPT plans, so we don't guess an id."""
    if engine == "claude":
        return DREAM_MODEL
    return os.environ.get("DREAM_CODEX_MODEL") or None


def engine_label(engine: str) -> str:
    """Human label for reports/status: ``claude/opus``, ``codex/default``."""
    return f"{engine}/{dream_model(engine) or 'default'}"


def _claude_argv(model: str) -> list[str]:
    # --tools "": the run reads transcripts (text anyone the owner talked to
    # could have written) and only has to answer in JSON. With the owner's
    # allowed Bash patterns loaded it could have been steered into acting.
    return ["claude", "-p", "--model", model, "--output-format", "json", "--max-turns", "1", "--tools", ""]


def _codex_argv(model: str | None, run_cwd: Path, response_file: Path) -> list[str]:
    """``codex exec`` reads the prompt from stdin and writes its final message
    to ``response_file`` (-o). ``--ephemeral`` keeps the run out of
    ~/.codex/sessions so the sweep never ingests its own rollout; read-only
    sandbox + ``--skip-git-repo-check`` because the run dir is a plain scratch
    folder. Reasoning effort is pinned high: the nightly sweep is the one place
    worth the model's best, and Codex's default effort is model-dependent."""
    argv = [
        "codex", "exec", "--ephemeral", "--skip-git-repo-check",
        "-s", "read-only", "-C", str(run_cwd),
        "-c", 'model_reasoning_effort="high"',
        "-o", str(response_file),
    ]
    if model:
        argv += ["-m", model]
    return argv


def engine_env(engine: str, home: Path) -> tuple[dict[str, str], object]:
    """The environment for a headless run of ``engine`` and the company gateway
    it goes through, if any. Without a gateway every metered key is removed,
    so the run can only use the owner's subscription."""
    env = child_env()
    gateway = llm_gateway.apply_gateway(env, "claude" if engine == "claude" else "codex", home)
    if not gateway:
        for key in _METERED_KEYS:
            env.pop(key, None)
    return env, gateway


def _engine_launch(
    engine: str, model: str | None, home: Path, run_cwd: Path, response_file: Path
) -> tuple[dict[str, str], list[str]]:
    """The subprocess env and argv for one extraction. On the owner's
    subscription every metered key is stripped; when a company gateway is
    configured the run goes through it instead, exactly like the cockpit's
    agents (llm_gateway mirrors session.mjs)."""
    env, gateway = engine_env(engine, home)
    if engine == "claude":
        return env, _claude_argv(model)
    argv = _codex_argv(model, run_cwd, response_file)
    if gateway:
        argv[2:2] = [a for o in llm_gateway.codex_provider_overrides(gateway.base_url) for a in ("-c", o)]
    return env, argv


def ask_engine(home: Path, prompt: str, run_cwd: Path, tag: str) -> tuple[str, object]:
    """One headless call to the DREAM_ENGINE: prompt in, final text and cost out.

    Runs on the owner's subscription: metered API keys are stripped from the
    subprocess env so the CLI can never silently bill them. The prompt, the
    raw response and (Codex) the log are kept in ``run_cwd`` under ``tag``.
    ``run_cwd`` must sit under a hidden folder of the home directory: that is
    the structural guard that keeps these runs out of tomorrow's reading
    (memory.reading.level_for excludes hidden folders).
    """
    engine = dream_engine()
    model = dream_model(engine)
    (run_cwd / f"prompt-{tag}.txt").write_text(prompt)
    response_file = run_cwd / f"response-{tag}.json"

    env, argv = _engine_launch(engine, model, home, run_cwd, response_file)
    proc = subprocess.run(
        argv, input=prompt, capture_output=True, text=True,
        timeout=EXTRACT_TIMEOUT_S, cwd=run_cwd, env=env,
    )
    if engine == "claude":
        response_file.write_text(proc.stdout or proc.stderr)
    else:
        # Codex's stdout is a human transcript (banner, prompt echo, token
        # count); keep it for the audit trail next to the -o final message.
        (run_cwd / f"codex-{tag}.log").write_text(
            (proc.stdout or "") + ("\n--- stderr ---\n" + proc.stderr if proc.stderr else "")
        )
    if proc.returncode != 0:
        raise RuntimeError(
            f"{argv[0]} extraction failed for {tag!r} (rc={proc.returncode}): "
            f"{(proc.stderr or proc.stdout)[:500]}"
        )
    if engine == "claude":
        outer = json.loads(proc.stdout)
        return outer.get("result", ""), outer.get("total_cost_usd")
    if not response_file.exists():
        raise RuntimeError(
            f"codex exec wrote no final message for {tag!r} — see "
            f"{run_cwd / f'codex-{tag}.log'}"
        )
    return response_file.read_text(), "subscription"


def parse_json_object(text: str) -> dict:
    """The JSON object in a model's answer (it may be wrapped in prose or a
    code fence)."""
    start = text.find("{")
    if start < 0:
        raise ValueError(f"No JSON object in the model's response: {text[:300]!r}")
    # The first complete object: a model sometimes adds a remark, or a second
    # object, after its answer.
    obj, _ = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(obj, dict):
        raise ValueError(f"The model's response is not a JSON object: {text[:300]!r}")
    return obj


# --- housekeeping (report-only) ----------------------------------------------------


def hygiene_report(home: Path) -> dict:
    """Surface, never delete: stale cockpit tabs and old ~/tmp bulk. v1 is
    deliberately read-only (see decision doc) — pruning knobs come later."""
    report: dict = {"stale_tabs": [], "tmp": {}}
    tabs_file = home / ".claude-chat-tabs.json"
    if tabs_file.exists():
        try:
            cutoff = (time.time() - STALE_TAB_DAYS * 86400) * 1000
            for tab in json.loads(tabs_file.read_text()):
                if tab.get("id") == 0:
                    continue
                if (tab.get("lastUsedAt") or 0) < cutoff:
                    report["stale_tabs"].append(
                        {"id": tab.get("id"), "title": (tab.get("title") or "")[:60],
                         "cwd": tab.get("cwd", "")}
                    )
        except (json.JSONDecodeError, TypeError):
            log.warning("Hygiene: could not parse %s", tabs_file)
    tmp = home / "tmp"
    if tmp.is_dir():
        cutoff = time.time() - STALE_TMP_DAYS * 86400
        n, size = 0, 0
        for f in tmp.rglob("*"):
            try:
                st = f.stat()
            except OSError:
                continue
            if f.is_file() and st.st_mtime < cutoff:
                n, size = n + 1, size + st.st_size
        report["tmp"] = {"stale_files": n, "stale_mb": round(size / 1e6, 1)}
    return report


# --- the run ------------------------------------------------------------------------


def run_dream(home: Path | None = None, *, preview: bool = False) -> dict:
    """Run one night. Returns the run summary (also written to disk). Raises
    RuntimeError when every batch failed: systemd then shows the unit red.

    Holds an exclusive flock for the whole run and releases it explicitly on
    every exit path — relying on GC to close the fd leaks the lock inside any
    long-lived process (the API server, pytest) and blocks every later run.
    """
    home = home or Path.home()
    dream_dir(home).mkdir(parents=True, exist_ok=True)
    lock = (dream_dir(home) / "lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError("Another dream run is in progress (lock held)") from None
    try:
        return _run_dream_locked(home, preview=preview)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def _run_dream_locked(home: Path, *, preview: bool) -> dict:
    from api.services.memory import night_report, nightly

    summary = nightly.run_night(home, preview=preview)
    run_dir = dream_dir(home) / "runs" / summary["run"]
    _finish(home, run_dir, summary)
    if summary["status"] == "failed":
        raise RuntimeError(
            f"Memory night {summary['run']}: every batch failed, nothing was read. "
            f"See {run_dir} and the report.")
    if not preview:
        _notify_owner(summary, night_report.in_words(summary))
    return summary


def _notify_owner(summary: dict, text: str) -> None:
    """Morning ping through the M0 notify primitive (best-effort — notify
    itself logs failures and never raises)."""
    import asyncio

    try:
        from api.config import APP_URL
        from api.services.notify import send_notification, notify_channel

        # The dream digest is an OPTIONAL ping — the report is always in the
        # Knowledge layer on disk. If the owner never configured a channel, stay
        # quiet at INFO rather than firing notify's loud "dropping" WARNING (that
        # warning is meant for ship/escalation sends that must not be lost).
        if notify_channel() == "none":
            log.info("Dream report ready (no notify channel configured — see the Knowledge layer).")
            return

        # The report path _finish stored is the one source of truth for the
        # link — recomputing the date here could 404 across midnight.
        report = summary.get("report")
        asyncio.run(send_notification(
            f"🌙 Memory: the night of {summary['run'][:8]} ({summary['status']})", text,
            url=f"{APP_URL}/reports/{Path(report).name}" if report else APP_URL,
        ))
    except Exception:
        log.exception("Dream owner-notification failed (report is on disk regardless)")


def _finish(home: Path, run_dir: Path, summary: dict) -> None:
    from api.services.memory import night_report

    (run_dir / "run.json").write_text(json.dumps(summary, indent=2))
    try:
        summary["report"] = str(night_report.write_report(home, summary))
        (run_dir / "run.json").write_text(json.dumps(summary, indent=2))
    except Exception:
        log.exception("Memory night report writing failed (run artifacts intact at %s)", run_dir)
    state = _load_state(home)
    state.update({"last_run": summary["run"], "last_status": summary["status"]})
    if summary.get("report"):
        # The status API links "last report" from here: a filename glob over
        # ~/reports/ proved fragile.
        state["last_report"] = Path(summary["report"]).name
    state_path(home).parent.mkdir(parents=True, exist_ok=True)
    state_path(home).write_text(json.dumps(state, indent=2))


def _load_state(home: Path) -> dict:
    p = state_path(home)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            log.warning("Dream state file corrupt — starting fresh: %s", p)
    return {}


# --- misc ------------------------------------------------------------------------------


def _slug(node: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (node or "owner").lower()).strip("-") or "owner"


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description="Run one night of ShellTeam memory")
    ap.add_argument("--preview", action="store_true", help="read and propose, write nothing")
    args = ap.parse_args()
    result = run_dream(preview=args.preview)
    print(json.dumps(result, indent=2))

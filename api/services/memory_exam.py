"""The recall exam: does a freshly opened agent know what was said this week?

Built from this box's own conversations (docs/decisions/20261113-memory-exam.md).
Four commands, each a stage with its output on disk under ``~/.shellteam/exam/``:

  generate   questions from the last 14 days of conversations, each with the
             sentence that supports its answer
  run        one fresh agent per question, started in the question's folder
             with the flags the cockpit passes, nothing saved
  grade      a model compares each answer with the key
  report     scores per kind and per agent, launch size, run time, notional cost

An *arm* is one way of launching the agent: which ShellTeam memory it gets and
whether the agent's own built-in memory is on. The exam never changes the
owner's files: agents under test cannot write, cannot reach a conversation
store (memory_exam_guard.py) and leave no session behind, and the exam's own
model calls run in a hidden folder the nightly job skips.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from api.services import dreaming, memory_exam_guard as guard
from api.services.memory import reading, search

log = logging.getLogger("shellteam.exam")

REPO = Path(__file__).resolve().parents[2]
AGENT_LAYER = REPO / "computer" / "ai-chat" / "lib" / "agent-layer.mjs"

EXAM_DAYS = 14
KIND_TARGETS = {"recent": 40, "changed": 25, "lookup": 25, "should_not_know": 10}
ANSWERED_KINDS = ("recent", "changed", "lookup")
MIN_OWNER_MESSAGES = 2          # fewer is a scheduled or one-shot run, not a conversation
CHUNK_CHARS = 45_000            # of a conversation shown to the question writer per call
MAX_CHUNKS = 10                 # per conversation, evenly spaced when it is longer
ANSWER_TIMEOUT_S = 420
STOP_AFTER_FAILURES = 5         # in a row: a usage limit or an outage, not hard questions
GRADE_BATCH = 10
HAND_CHECK = 20


@dataclass(frozen=True)
class Arm:
    """One way of launching the agent under test."""

    shellteam_memory: str   # "off" | "tree"
    own_memory: bool        # the agent's own built-in memory
    what: str


ARMS = {
    "off": Arm("off", False, "No memory"),
    "tree": Arm("tree", False, "Knowledge tree"),
    "tree+own": Arm("tree", True, "Knowledge tree + its own"),
}
# Claude Code keeps notes of its own; Codex's `memories` feature is off unless
# the owner turned it on, so a "+own" arm would measure nothing there.
# The old system's arms ("today", "today+own") were measured in the baseline
# of 2026-11-13 and are compared from its saved runs; that system is gone.
AGENT_ARMS = {"claude": ("off", "tree", "tree+own"),
              "codex": ("off", "tree")}
DEFAULT_MODELS = {"claude": "claude-opus-5-5", "codex": None}  # None: the CLI's own default


def exam_dir(home: Path) -> Path:
    return home / ".shellteam" / "exam"


def set_path(home: Path, name: str) -> Path:
    return exam_dir(home) / "sets" / f"{name}.json"


def run_dir(home: Path, run: str) -> Path:
    return exam_dir(home) / "runs" / run


def _scratch(home: Path, what: str) -> Path:
    d = exam_dir(home) / "work" / f"{what}-{datetime.now():%Y%m%d-%H%M%S}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _tilde(home: Path, folder: Path) -> str:
    return "~" if folder == home else f"~/{folder.relative_to(home)}"


def _folder(home: Path, tilde: str) -> Path:
    return home if tilde == "~" else home / tilde[2:]


# --- generate ------------------------------------------------------------------------

GENERATE_PROMPT = """\
You are writing questions for a recall exam. The exam checks whether an AI
coding agent that is opened fresh tomorrow, in the folder {folder}, still knows
what was said in the conversation below (it took place on {date}).

Write up to 6 questions. Each must be about something a good colleague would
be expected to remember next week:

- a decision the owner made, and why
- a preference or a correction ("do it this way", "never do that")
- where things stand now (a goal, an open thread, what was chosen)
- where something lives or how something is done here

Kinds:
  "recent"   a fact stated or decided in this conversation
  "changed"  the conversation shows that something that used to be true or
             decided is now different. Give the old answer in "old_answer".
             Only use this kind when the change is explicit in the text.
  "lookup"   a specific detail (a path, a number, a procedure, a name) that is
             true and useful but too minor to be in a one-page summary

Rules:
- The question must make sense on its own, to someone who never saw this
  conversation. Never write "in this conversation" or "earlier".
- The answer is short (one sentence) and is supported by one exact sentence
  from the conversation, copied into "support".
- Skip anything that is a secret (keys, tokens, passwords), anything about the
  exam itself, small talk, and anything a person could answer just by reading
  the code or the git log (which commit, which version, what a function does).
- Skip one-off requests ("make this one a PDF"): they are not knowledge.
- "about_project" is true when the answer is a detail of this project that an
  agent working on a different project should have no reason to know.
- Fewer good questions beat six weak ones. {{"questions": []}} is a fine answer.

Return ONLY a JSON object:
{{"questions": [{{"kind": "...", "question": "...", "answer": "...",
  "old_answer": "", "support": "...", "about_project": false}}]}}

--- BEGIN CONVERSATION (tool output removed; USER is the owner) ---
{transcript}
--- END CONVERSATION ---
"""

SELECT_PROMPT = """\
Below are candidate questions for a recall exam about one person's computer and
projects. Choose the best ones:

- {recent} of kind "recent", {changed} of kind "changed", {lookup} of kind "lookup"
- then {should_not_know} more, of any kind, where "about_project" is true: these
  will be asked from inside a different project to check nothing leaks across.

Prefer questions that are clear on their own, whose answer is one definite
fact, that matter beyond the day they were said, and that are spread across
folders. Drop near-duplicates (keep one), anything about a secret, anything
vague, and anything whose answer is obvious without having been told.
If a kind has fewer good candidates than asked, return fewer.

Return ONLY a JSON object:
{{"recent": ["id", ...], "changed": [...], "lookup": [...], "should_not_know": [...]}}

Candidates:
{candidates}
"""


def conversations(home: Path, days: int) -> list[reading.Conversation]:
    """Real conversations of the last ``days`` days, newest first: the owner
    spoke at least a few times, and it ran somewhere the nightly job reads."""
    found = reading.gather(home, {}, time.time() - days * 86400).conversations
    real = [c for c in found if sum(1 for m in c.messages if m.role == "owner") >= MIN_OWNER_MESSAGES]
    log.info("Exam: %d conversation(s) in the last %d days, %d with a real exchange",
             len(found), days, len(real))
    return sorted(real, key=lambda c: c.messages[-1].ts, reverse=True)


def ask_folder(home: Path, conv: reading.Conversation) -> Path:
    """The folder a question from this conversation is asked in: its project,
    or home for chats started in home, outside it, or in a scratch folder."""
    return home / conv.level if conv.level else home


def spread(convs: list[reading.Conversation], home: Path, limit: int) -> list[reading.Conversation]:
    """Up to ``limit`` conversations, taken in turn from each folder so one
    busy project cannot fill the exam."""
    by_folder: dict[Path, list[reading.Conversation]] = {}
    for c in convs:
        by_folder.setdefault(ask_folder(home, c), []).append(c)
    picked: list[reading.Conversation] = []
    while len(picked) < limit and any(by_folder.values()):
        for queue in by_folder.values():
            if queue and len(picked) < limit:
                picked.append(queue.pop(0))
    return picked


def chunks(conv: reading.Conversation) -> list[str]:
    """The conversation as pieces the question writer can read whole. A long
    working session is far bigger than one piece, so it gives several, evenly
    spaced: questions then come from its whole length, not only its end."""
    pieces, piece, size = [], [], 0
    for m in conv.messages:
        line = f"{'USER' if m.role == 'owner' else 'ASSISTANT'}: {m.text}"
        if piece and size + len(line) > CHUNK_CHARS:
            pieces.append("\n".join(piece))
            piece, size = [], 0
        piece.append(line)
        size += len(line) + 1
    if piece:
        pieces.append("\n".join(piece))
    if len(pieces) <= MAX_CHUNKS:
        return pieces
    step = (len(pieces) - 1) / (MAX_CHUNKS - 1)
    return [pieces[round(i * step)] for i in range(MAX_CHUNKS)]


def _questions_from(home: Path, session: reading.Conversation, transcript: str, work: Path,
                    n: int) -> list[dict]:
    folder = ask_folder(home, session)
    date = datetime.fromtimestamp(session.messages[-1].ts).strftime("%Y-%m-%d")
    prompt = GENERATE_PROMPT.format(
        folder=_tilde(home, folder), date=date, transcript=transcript)
    text, _ = dreaming.ask_engine(home, prompt, work, f"gen-{n:03d}")
    out = []
    for q in dreaming.parse_json_object(text).get("questions", []):
        if q.get("kind") not in ANSWERED_KINDS or not q.get("question") or not q.get("answer"):
            continue
        out.append({
            "kind": q["kind"], "question": q["question"].strip(), "answer": q["answer"].strip(),
            "old_answer": (q.get("old_answer") or "").strip(),
            "support": (q.get("support") or "").strip(),
            "about_project": bool(q.get("about_project")) and folder != home,
            "folder": _tilde(home, folder),
            "source": {"agent": session.source, "session": session.session_id,
                       "cwd": session.cwd, "date": date},
        })
    return out


def _other_project(home: Path, q: dict, projects: list[str], turn: int) -> str:
    """A project folder that is not the question's own, to ask it from."""
    others = [p for p in projects if p != q["folder"]]
    if not others:
        raise ValueError("A should-not-know question needs a second project with conversations")
    return others[turn % len(others)]


def generate(home: Path, name: str, *, days: int = EXAM_DAYS, max_sessions: int = 60,
             workers: int = 5) -> Path:
    """Write the question set ``name``. Refuses to replace an existing set:
    a frozen set is only useful if it never changes."""
    path = set_path(home, name)
    if path.exists():
        raise FileExistsError(f"Question set {name!r} already exists at {path}")
    work = _scratch(home, f"generate-{name}")
    sessions = spread(conversations(home, days), home, max_sessions)
    if not sessions:
        raise RuntimeError(f"No conversations in the last {days} days to write questions from")

    candidates: list[dict] = []
    failures = 0
    pieces = [(s, piece) for s in sessions for piece in chunks(s)]
    with ThreadPoolExecutor(workers) as pool:
        jobs = [pool.submit(_questions_from, home, s, piece, work, n)
                for n, (s, piece) in enumerate(pieces)]
        for n, job in enumerate(jobs):
            try:
                candidates.extend(job.result())
            except Exception:
                failures += 1
                log.exception("Exam generate: piece %d gave no questions", n)
    if failures > len(pieces) // 2:
        raise RuntimeError(f"Exam generate: {failures} of {len(pieces)} model calls failed")
    for n, q in enumerate(candidates):
        q["id"] = f"c{n:04d}"
    (work / "candidates.json").write_text(json.dumps(candidates, indent=2))
    log.info("Exam generate: %d candidate question(s) from %d conversation(s)",
             len(candidates), len(sessions))

    listing = "\n".join(
        json.dumps({k: q[k] for k in ("id", "kind", "folder", "about_project", "question", "answer")})
        for q in candidates)
    text, _ = dreaming.ask_engine(
        home, SELECT_PROMPT.format(candidates=listing, **KIND_TARGETS), work, "select")
    chosen = dreaming.parse_json_object(text)

    by_id = {q["id"]: q for q in candidates}
    projects = sorted({q["folder"] for q in candidates if q["folder"] != "~"})
    questions, used = [], set()
    for kind, target in KIND_TARGETS.items():
        picked = 0
        for cid in chosen.get(kind, []):
            q = by_id.get(cid)
            if q is None or cid in used or picked >= target:
                continue
            if kind == "should_not_know":
                if not q["about_project"]:
                    continue
                q = {**q, "asked_from": _other_project(home, q, projects, picked)}
            elif q["kind"] != kind:
                continue
            used.add(cid)
            picked += 1
            questions.append({**q, "kind": kind, "id": f"q{len(questions) + 1:03d}"})
        if picked < target:
            log.warning("Exam generate: only %d of %d %r question(s)", picked, target, kind)
    for q in questions:
        q.pop("about_project", None)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "name": name, "created": datetime.now().isoformat(timespec="seconds"), "days": days,
        "conversations_read": len(sessions), "candidates": len(candidates),
        "questions": questions,
    }, indent=2))
    log.info("Exam set %r written: %d question(s) at %s", name, len(questions), path)
    return path


def load_set(home: Path, name: str) -> dict:
    return json.loads(set_path(home, name).read_text())


# --- run -----------------------------------------------------------------------------

ASK = "{question}\n\nAnswer in a sentence or two. If you cannot tell, say that you do not know."

_LAYER_PROBE = """
import { claudeLayerArgs, codexLayerArgs, codexHarnessEnv, harnessPromptPath } from %s;
import { readFileSync } from "node:fs";
const cwd = process.argv[1];
const prompt = harnessPromptPath(cwd);
console.log(JSON.stringify({
  claude: claudeLayerArgs(cwd),
  codex: codexLayerArgs(cwd, {}),
  codexEnv: codexHarnessEnv({}),
  launchText: prompt ? readFileSync(prompt, "utf8") : "",
}));
"""


def launch_layer(folder: Path, arm: Arm) -> dict:
    """What the cockpit would pass an agent started in ``folder`` under this
    arm: the flags for each agent and the launch text they carry. Asked of the
    cockpit's own code, so the exam can never drift from a real launch."""
    env = {k: v for k, v in os.environ.items() if k != "SHELLTEAM_MEMORY"}
    if arm.shellteam_memory == "off":
        env["SHELLTEAM_MEMORY"] = "off"
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _LAYER_PROBE % json.dumps(str(AGENT_LAYER)),
         str(folder)],
        capture_output=True, text=True, env=env, timeout=60, check=True)
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _drop_flag_pairs(args: list[str], drop) -> list[str]:
    """``args`` without the (flag, value) pairs ``drop(flag, value)`` rejects."""
    out, i = [], 0
    while i < len(args):
        if i + 1 < len(args) and drop(args[i], args[i + 1]):
            i += 2
            continue
        out.append(args[i])
        i += 1
    return out


def _guard_env(arm: Arm) -> dict[str, str]:
    return {
        "EXAM_OWN_MEMORY": "1" if arm.own_memory else "0",
        "EXAM_SHELLTEAM_MEMORY": "0" if arm.shellteam_memory == "off" else "1",
    }


def claude_command(layer: dict, arm: Arm, model: str, home: Path) -> tuple[list[str], dict]:
    """The cockpit's Claude launch, in one-question form: same model flag,
    same layer flags, same launch text. MCP servers are left out (an exam
    question needs none, and none may be called)."""
    env, _ = dreaming.engine_env("claude", home)
    env.update(_guard_env(arm))
    # The arm decides, never the chat the exam was started from: a cockpit
    # chat with the agents' own memory off passes this variable down.
    env.pop("CLAUDE_CODE_DISABLE_AUTO_MEMORY", None)
    if not arm.own_memory:
        env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    hook = {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [
        {"type": "command", "command": f"{sys.executable} {guard.__file__}"}]}]}}
    argv = [
        "claude", "-p", "--output-format", "stream-json", "--verbose",
        "--dangerously-skip-permissions", "--model", model,
        "--no-session-persistence", "--strict-mcp-config",
        "--settings", json.dumps(hook),
        *_drop_flag_pairs(layer["claude"], lambda flag, _: flag == "--mcp-config"),
    ]
    return argv, env


def codex_command(layer: dict, arm: Arm, model: str | None, home: Path, folder: Path
                  ) -> tuple[list[str], dict]:
    """The cockpit's Codex launch, in one-question form: no approvals and no
    sandbox, as in the cockpit (Codex's read-only sandbox needs bubblewrap
    networking that many boxes, this one included, do not allow, and then no
    command runs at all). Codex has no tool hook, so its commands are audited
    afterwards (``_read_codex``)."""
    env, _ = dreaming.engine_env("codex", home)
    env.update(layer["codexEnv"])
    argv = [
        "codex", "exec", "--ephemeral", "--skip-git-repo-check", "--json",
        "--dangerously-bypass-approvals-and-sandbox", "-C", str(folder),
        *_drop_flag_pairs(layer["codex"], lambda flag, value: flag == "-c" and (
            value.startswith("mcp_servers.") or value.startswith("model_provider"))),
    ]
    if model:
        argv += ["-m", model]
    return argv, env


def _read_claude(stdout: str) -> dict:
    tools, refused, answer, meta = [], 0, "", {}
    for raw in stdout.splitlines():
        try:
            line = json.loads(raw)
        except json.JSONDecodeError:
            continue
        content = (line.get("message") or {}).get("content")
        if line.get("type") == "assistant" and isinstance(content, list):
            tools += [b.get("name", "") for b in content if b.get("type") == "tool_use"]
        elif line.get("type") == "user" and isinstance(content, list):
            refused += sum(
                1 for b in content
                if b.get("type") == "tool_result" and guard.REFUSAL in json.dumps(b.get("content")))
        elif line.get("type") == "result":
            answer = line.get("result") or ""
            meta = {"cost_usd": line.get("total_cost_usd"), "turns": line.get("num_turns"),
                    "failed": bool(line.get("is_error"))}
    return {"answer": answer, "tools": tools, "refused": refused, "contaminated": False, **meta}


def _read_codex(stdout: str, arm: Arm) -> dict:
    tools, answer, contaminated, tokens, error = [], "", False, None, ""
    for raw in stdout.splitlines():
        try:
            line = json.loads(raw)
        except json.JSONDecodeError:
            continue
        item = line.get("item") or {}
        if line.get("type") == "turn.completed":
            tokens = line.get("usage")
        if line.get("type") == "error":
            error = line.get("message") or ""
        if line.get("type") != "item.completed":
            continue
        if item.get("type") == "agent_message":
            answer = item.get("text") or answer
        elif item.get("type") == "command_execution":
            tools.append("shell")
            if guard.reason_blocked("shell", item.get("command") or "", _guard_env(arm)):
                contaminated = True
        elif item.get("type") not in ("reasoning", None):
            tools.append(item.get("type"))
    return {"answer": answer, "tools": tools, "refused": 0, "contaminated": contaminated,
            "cost_usd": None, "tokens": tokens, "turns": None, "failed": not answer,
            **({"error": error} if error else {})}


def ask(home: Path, agent: str, arm: Arm, model: str | None, layer: dict, q: dict,
        exclude: str = "") -> dict:
    """One question to one fresh agent. Never raises: a timeout or a crashed
    agent is a result too, and it is the system's, not the exam's, to explain.
    ``exclude``: the conversations the set's questions came from, which the
    memory search must not find (K13)."""
    folder = _folder(home, q.get("asked_from") or q["folder"])
    if agent == "claude":
        argv, env = claude_command(layer, arm, model, home)
    else:
        argv, env = codex_command(layer, arm, model, home, folder)
    env[search.EXCLUDE_ENV] = exclude
    started = time.time()
    try:
        proc = subprocess.run(
            argv, input=ASK.format(question=q["question"]), capture_output=True, text=True,
            timeout=ANSWER_TIMEOUT_S, cwd=folder, env=env)
        out = _read_claude(proc.stdout) if agent == "claude" else _read_codex(proc.stdout, arm)
        if not out["answer"]:
            out["failed"] = True
            out.setdefault("error", (proc.stderr or proc.stdout)[-400:])
    except subprocess.TimeoutExpired:
        out = {"answer": "", "tools": [], "refused": 0, "contaminated": False, "failed": True,
               "error": f"no answer in {ANSWER_TIMEOUT_S}s"}
    out.update(id=q["id"], seconds=round(time.time() - started, 1))
    if out.get("failed"):
        log.warning("Exam %s: question %s got no answer: %s", agent, q["id"], out.get("error", ""))
    return out


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def run(home: Path, set_name: str, run_name: str, agent: str, arm_name: str, *,
        model: str | None = None, workers: int = 4, limit: int | None = None,
        memory_root: Path | None = None) -> Path:
    """Ask every answered question of the set under one arm. Results are
    appended as they arrive, so a stopped run resumes where it was.
    ``memory_root`` points the launch at another knowledge tree (the size
    table: the same facts printed within other limits)."""
    if arm_name not in AGENT_ARMS[agent]:
        raise ValueError(f"Arm {arm_name!r} does not apply to {agent}")
    if memory_root:
        os.environ["SHELLTEAM_MEMORY_ROOT"] = str(memory_root)
    arm = ARMS[arm_name]
    model = model or DEFAULT_MODELS[agent]
    questions = load_set(home, set_name)["questions"]
    out_dir = run_dir(home, run_name)
    out_dir.mkdir(parents=True, exist_ok=True)

    folders = sorted({q.get("asked_from") or q["folder"] for q in questions})
    layers = {f: launch_layer(_folder(home, f), arm) for f in folders}
    arm_file = out_dir / f"{agent}--{arm_name}.arm.json"
    arm_file.write_text(json.dumps({
        "set": set_name, "agent": agent, "arm": arm_name, "what": arm.what,
        "shellteam_memory": arm.shellteam_memory, "own_memory": arm.own_memory,
        "model": model or "the CLI's default",
        "launch_text": {f: layer["launchText"] for f, layer in layers.items()},
    }, indent=2))

    answers = out_dir / f"{agent}--{arm_name}.answers.jsonl"
    done = {a["id"] for a in _read_jsonl(answers)}
    exclude = ",".join(sorted({q["source"]["session"] for q in questions if q.get("source")}))
    todo = [q for q in questions if q["kind"] in ANSWERED_KINDS and q["id"] not in done][:limit]
    log.info("Exam run %s: %s under %r, %d question(s) to ask (%d already answered)",
             run_name, agent, arm_name, len(todo), len(done))
    started = time.time()
    failed_in_a_row = 0
    with ThreadPoolExecutor(workers) as pool, answers.open("a") as f:
        jobs = [pool.submit(ask, home, agent, arm, model, layers[q["folder"]], q, exclude) for q in todo]
        for job in jobs:
            result = job.result()
            if result.get("failed"):
                failed_in_a_row += 1
                if failed_in_a_row >= STOP_AFTER_FAILURES:
                    for pending in jobs:
                        pending.cancel()
                    raise RuntimeError(
                        f"Exam run stopped: {failed_in_a_row} questions in a row got no answer "
                        f"(last: {result.get('error', '')[:200]}). Answers so far are kept; "
                        f"run the same command again to continue.")
                continue    # not recorded: the question is asked again on the next run
            failed_in_a_row = 0
            f.write(json.dumps(result) + "\n")
            f.flush()
    wall = out_dir / f"{agent}--{arm_name}.wall.json"
    spent = json.loads(wall.read_text())["seconds"] if wall.exists() else 0
    wall.write_text(json.dumps({"seconds": round(spent + time.time() - started)}))
    return answers


# --- grade ---------------------------------------------------------------------------

GRADE_PROMPT = """\
You are grading a recall exam. For each item compare the agent's answer with
the key. The key is what was actually said; "support" is the sentence it comes
from. For a "changed" item, "old_answer" is what used to be true: an answer
that gives the old state as current is WRONG.

Judge the answer against the QUESTION, not against everything in the key.
The key often carries more detail than was asked for (a reason, a figure, a
second point). Leaving that out is fine. Only what the question asks for
counts: if it asks "how long and how many", both are needed; if it asks
"why", the reason is needed; if it asks "what was decided", the decision is.

Verdicts:
  "right"    answers what the question asks, in line with the key (wording
             may differ; missing detail the question did not ask for is fine;
             extra correct detail is fine)
  "partly"   misses part of what the question asks for, or hedges between the
             right answer and another
  "wrong"    states something else as fact
  "unknown"  says it does not know, cannot tell, or gives no answer

Return ONLY a JSON object: {{"grades": [{{"id": "...", "verdict": "...", "note": "a few words"}}]}}

Items:
{items}
"""

LEAK_PROMPT = """\
Below is the text an AI agent is given when it starts work in the folder
{folder}, followed by facts that belong to OTHER projects. For each fact, say
whether the text states it (or enough of it to answer the question).

Return ONLY a JSON object: {{"grades": [{{"id": "...", "verdict": "leak" | "clean", "note": "a few words"}}]}}

Facts:
{items}

--- BEGIN LAUNCH TEXT ---
{launch_text}
--- END LAUNCH TEXT ---
"""


def _grade_batch(home: Path, work: Path, tag: str, prompt: str, ids: list[str],
                 verdicts: tuple[str, ...]) -> list[dict]:
    text, _ = dreaming.ask_engine(home, prompt, work, tag)
    grades = {g.get("id"): g for g in dreaming.parse_json_object(text).get("grades", [])}
    missing = [i for i in ids if grades.get(i, {}).get("verdict") not in verdicts]
    if missing:
        raise ValueError(f"Grader gave no usable verdict for {missing}")
    return [{"id": i, "verdict": grades[i]["verdict"], "note": grades[i].get("note", "")}
            for i in ids]


# Version 2 (owner, 2026-11-14): an answer that answers the question passes;
# detail the question did not ask for is not required. A grade file records
# its version; ``grade --again`` regrades older ones, keeping them aside.
GRADER = 2


def grade(home: Path, run_name: str, *, workers: int = 4, again: bool = False) -> None:
    """Grade every arm of a run that has answers and no grades yet. ``again``:
    also regrade arms graded by an older grader (their grades are kept as
    ``<arm>.grades-v<n>.json``)."""
    out_dir = run_dir(home, run_name)
    work = _scratch(home, f"grade-{run_name}")
    for arm_file in sorted(out_dir.glob("*.arm.json")):
        stem = arm_file.name.removesuffix(".arm.json")
        grades_file = out_dir / f"{stem}.grades.json"
        if grades_file.exists():
            version = _grader_of(out_dir, stem)
            if not again or version >= GRADER:
                continue
            grades_file.rename(out_dir / f"{stem}.grades-v{version}.json")
            log.info("Exam grade: %s regraded (was grader %d)", stem, version)
        arm = json.loads(arm_file.read_text())
        questions = {q["id"]: q for q in load_set(home, arm["set"])["questions"]}
        answers = {a["id"]: a for a in _read_jsonl(out_dir / f"{stem}.answers.jsonl")}
        grades: list[dict] = []
        batches: list[tuple[str, str, list[str], tuple[str, ...]]] = []

        to_grade = []
        for qid, a in answers.items():
            if a.get("contaminated"):
                grades.append({"id": qid, "verdict": "wrong", "note": "read a conversation store"})
            elif a.get("failed") or not a.get("answer"):
                grades.append({"id": qid, "verdict": "unknown", "note": "no answer"})
            else:
                to_grade.append(qid)
        for n in range(0, len(to_grade), GRADE_BATCH):
            ids = to_grade[n:n + GRADE_BATCH]
            items = "\n".join(json.dumps({
                "id": i, "kind": questions[i]["kind"], "question": questions[i]["question"],
                "key": questions[i]["answer"], "old_answer": questions[i]["old_answer"],
                "support": questions[i]["support"], "agent_answer": answers[i]["answer"][:1500],
            }) for i in ids)
            batches.append((f"{stem}-{n:03d}", GRADE_PROMPT.format(items=items), ids,
                            ("right", "partly", "wrong", "unknown")))

        leaks: dict[str, list[dict]] = {}
        for q in questions.values():
            if q["kind"] == "should_not_know":
                leaks.setdefault(q["asked_from"], []).append(q)
        for folder, qs in leaks.items():
            launch_text = arm["launch_text"].get(folder, "")
            if not launch_text.strip():
                grades += [{"id": q["id"], "verdict": "clean", "note": "no launch text"} for q in qs]
                continue
            items = "\n".join(json.dumps(
                {"id": q["id"], "question": q["question"], "fact": q["answer"]}) for q in qs)
            batches.append((f"{stem}-leak-{folder.strip('~/').replace('/', '-') or 'home'}",
                            LEAK_PROMPT.format(folder=folder, items=items, launch_text=launch_text),
                            [q["id"] for q in qs], ("leak", "clean")))

        with ThreadPoolExecutor(workers) as pool:
            for job in [pool.submit(_grade_batch, home, work, *b) for b in batches]:
                grades += job.result()
        grades_file.write_text(json.dumps(sorted(grades, key=lambda g: g["id"]), indent=2))
        (out_dir / f"{stem}.grader.json").write_text(json.dumps({"grader": GRADER}))
        log.info("Exam grade: %s graded (%d verdicts)", stem, len(grades))


def _grader_of(out_dir: Path, stem: str) -> int:
    """Which grader graded an arm: grades written before versions were kept are 1."""
    path = out_dir / f"{stem}.grader.json"
    return json.loads(path.read_text())["grader"] if path.exists() else 1


# --- report --------------------------------------------------------------------------

MARGIN_NOTE = ("With about 100 questions a score is good to roughly plus or minus 10 "
               "points. A difference inside that margin is not a result.")


def summarize(home: Path, run_name: str) -> dict:
    """Everything the report shows, as data: one entry per agent and arm."""
    out_dir = run_dir(home, run_name)
    arms = []
    for arm_file in sorted(out_dir.glob("*.arm.json")):
        stem = arm_file.name.removesuffix(".arm.json")
        arm = json.loads(arm_file.read_text())
        questions = {q["id"]: q for q in load_set(home, arm["set"])["questions"]}
        answers = {a["id"]: a for a in _read_jsonl(out_dir / f"{stem}.answers.jsonl")}
        grades_file = out_dir / f"{stem}.grades.json"
        grades = {g["id"]: g for g in json.loads(grades_file.read_text())} if grades_file.exists() else {}
        kinds: dict[str, dict] = {}
        for qid, g in grades.items():
            k = kinds.setdefault(questions[qid]["kind"], {"n": 0})
            k["n"] += 1
            k[g["verdict"]] = k.get(g["verdict"], 0) + 1
        answered = list(answers.values())
        wall = out_dir / f"{stem}.wall.json"
        costs = [a["cost_usd"] for a in answered if a.get("cost_usd") is not None]
        rng = random.Random(f"{run_name}/{stem}")
        graded = sorted(i for i in grades if i in answers)    # an arm still running has none yet
        sample = rng.sample(graded, min(HAND_CHECK, len(graded)))
        arms.append({
            **{k: arm[k] for k in ("agent", "arm", "what", "own_memory", "shellteam_memory", "model", "set")},
            "kinds": kinds,
            "launch_chars": {f: len(t) for f, t in arm["launch_text"].items()},
            "asked": len(answered),
            "to_ask": sum(1 for q in questions.values() if q["kind"] in ANSWERED_KINDS),
            "no_answer": sum(1 for a in answered if a.get("failed")),
            "contaminated": sum(1 for a in answered if a.get("contaminated")),
            "refused_calls": sum(a.get("refused", 0) for a in answered),
            "lookups_per_question": round(
                sum(len(a.get("tools", [])) for a in answered) / max(len(answered), 1), 1),
            "seconds_per_question": round(
                sum(a.get("seconds", 0) for a in answered) / max(len(answered), 1), 1),
            "wall_seconds": json.loads(wall.read_text())["seconds"] if wall.exists() else None,
            "notional_cost_usd": round(sum(costs), 2) if costs else None,
            "hand_check": [{
                "id": i, "kind": questions[i]["kind"], "folder": questions[i]["folder"],
                "question": questions[i]["question"], "key": questions[i]["answer"],
                "answer": answers[i].get("answer", ""), "verdict": grades[i]["verdict"],
                "note": grades[i].get("note", ""),
            } for i in sample],
        })
    summary = {"run": run_name, "written": datetime.now().isoformat(timespec="seconds"),
               "margin": MARGIN_NOTE, "arms": arms}
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    return summary


def score(kind: dict) -> float | None:
    """Share right, in percent. For "should not know" the right answer is that
    the launch text does not hold the fact."""
    if not kind or not kind.get("n"):
        return None
    good = kind.get("right", 0) + kind.get("clean", 0)
    return round(100 * good / kind["n"])


# --- when memory and the code disagree (K12) -----------------------------------------

CONFLICT_QUESTION = "Which port does this service listen on?"
CONFLICT_CODE_PORT, CONFLICT_MEMORY_PORT = "8417", "3000"


def conflict(home: Path, agent: str, *, trials: int = 10, model: str | None = None,
             workers: int = 5) -> dict:
    """A card line that contradicts the code: does the agent follow the code?

    A throwaway project whose code says one port and whose card says another
    is given to ``trials`` fresh agents through the normal launch. Passing is
    answering with the code's port. The project and its memory are removed
    afterwards; the owner's memory is never touched (the launch is pointed at
    a memory root of its own).
    """
    from api.services.memory import views
    from api.services.memory.store import Store

    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    project = home / "tmp" / f"memory-conflict-{stamp}"
    root = _scratch(home, f"conflict-{stamp}") / "memory"
    project.mkdir(parents=True)
    (project / "server.py").write_text(
        "from http.server import HTTPServer, SimpleHTTPRequestHandler\n\n"
        f"PORT = {CONFLICT_CODE_PORT}\n\n"
        'if __name__ == "__main__":\n'
        '    HTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler).serve_forever()\n')
    (project / "README.md").write_text("# Demo service\n\nRun `python server.py`.\n")
    store = Store(root)
    source = {"type": "conversation", "ref": "seeded for the K12 test"}
    level = str(project.relative_to(home))
    store.add(text="A small demo HTTP service.", kind="reference", folder=level, topic="product",
              source=source, on_card=True, part="what")
    store.add(text=f"The service listens on port {CONFLICT_MEMORY_PORT}.", kind="state",
              folder=level, topic="product", source=source, on_card=True)
    saved = {k: os.environ.get(k) for k in ("SHELLTEAM_MEMORY_ROOT",)}
    os.environ["SHELLTEAM_MEMORY_ROOT"] = str(root)
    try:
        views.print_views(store)
        # The card sits at the project's top folder for the launch to find it.
        arm = ARMS["tree"]
        layer = launch_layer(project, arm)
        if f"port {CONFLICT_MEMORY_PORT}" not in layer["launchText"]:
            raise RuntimeError("The seeded card did not reach the launch text; the test would prove nothing")
        q = {"id": "conflict", "folder": _tilde(home, project), "question": CONFLICT_QUESTION}
        with ThreadPoolExecutor(workers) as pool:
            answers = list(pool.map(
                lambda _: ask(home, agent, arm, model or DEFAULT_MODELS[agent], layer, q), range(trials)))
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        for f in project.iterdir():
            f.unlink()
        project.rmdir()
    followed_code = sum(
        1 for a in answers
        if CONFLICT_CODE_PORT in a["answer"] and not re.search(
            rf"listens on (?:port )?{CONFLICT_MEMORY_PORT}\b", a["answer"]))
    result = {
        "agent": agent, "trials": trials, "followed_the_code": followed_code,
        "passed": followed_code >= round(trials * 0.9),
        "answers": [a["answer"][:300] for a in answers],
    }
    (exam_dir(home) / f"conflict-{agent}-{stamp}.json").write_text(json.dumps(result, indent=2))
    log.info("Exam conflict test on %s: followed the code in %d of %d", agent, followed_code, trials)
    return result


# --- command line --------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description="ShellTeam recall exam")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="write a question set from recent conversations")
    g.add_argument("--name", required=True)
    g.add_argument("--days", type=int, default=EXAM_DAYS)
    g.add_argument("--max-sessions", type=int, default=60)
    r = sub.add_parser("run", help="ask a set's questions under one arm")
    r.add_argument("--set", required=True)
    r.add_argument("--run", required=True)
    r.add_argument("--agent", choices=sorted(AGENT_ARMS), required=True)
    r.add_argument("--arm", choices=sorted(ARMS), required=True)
    r.add_argument("--model")
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--limit", type=int)
    r.add_argument("--memory-root", type=Path)
    c = sub.add_parser("conflict", help="memory contradicts the code: which one wins?")
    c.add_argument("--agent", choices=sorted(AGENT_ARMS), required=True)
    c.add_argument("--trials", type=int, default=10)
    for name in ("grade", "report"):
        p = sub.add_parser(name)
        p.add_argument("--run", required=True)
        if name == "grade":
            p.add_argument("--again", action="store_true", help="regrade arms graded by an older grader")
    args = ap.parse_args(argv)
    home = Path.home()
    if args.cmd == "generate":
        print(generate(home, args.name, days=args.days, max_sessions=args.max_sessions))
    elif args.cmd == "run":
        print(run(home, args.set, args.run, args.agent, args.arm, model=args.model,
                  workers=args.workers, limit=args.limit, memory_root=args.memory_root))
    elif args.cmd == "conflict":
        print(json.dumps(conflict(home, args.agent, trials=args.trials), indent=2))
    elif args.cmd == "grade":
        grade(home, args.run, again=args.again)
    else:
        from api.services.memory_exam_report import write_report
        print(write_report(home, summarize(home, args.run)))


if __name__ == "__main__":
    main()

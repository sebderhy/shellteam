"""Shadow knowledge tree + deterministic apply engine (``dreaming`` module).

The knowledge a coding agent gets at spawn lives OUTSIDE the user's project
folders (footprint promise: ShellTeam writes only under ``~/.shellteam``):

    ~/.shellteam/knowledge/
      identity.md, preferences.md, feedback.md   user layer — injected everywhere
      projects.md, contacts.md                   root layer — root/manager scope only
      tree/<relpath>/index.md                    per-folder project node (the "AI
      tree/<relpath>/details/*.md                employee's" long-term memory)
      review-queue.jsonl                         non-high-confidence proposals
      changelog.jsonl                            every apply decision, forever

Write discipline (see docs/decisions/20260708-dreaming-v1.md): the LLM only
ever PROPOSES a JSON delta; this module is the single deterministic writer.
It enforces layer scope structurally (a node batch writes only its own node;
the user/root layer belongs to the OWNER pass alone; deletes don't exist as
an op), dedups, caps index size with overflow to details/, appends
corrections instead of overwriting, and logs every decision to the changelog.
A hallucinated op becomes a refused/no-op line in the log, never corrupted
knowledge.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("shellteam.knowledge")

USER_LAYER_FILES = ("identity.md", "preferences.md", "feedback.md")
ROOT_LAYER_FILES = ("projects.md", "contacts.md")

# Scratch top-level dirs never become project nodes: a "tmp project" is a
# fiction, and scratch sessions (research, QA runs) tend to carry facts about
# the OWNER, not a project. dreaming routes these sessions to the owner pass
# only (docs/decisions/20260710-dreaming-owner-pass.md).
SCRATCH_NODES = ("tmp",)

# Index files stay small on purpose: they are injected into system prompts.
MAX_INDEX_LINES = 120
# A fact is one crisp line. The extraction prompt asks for ≤200 chars; this is
# the hard ceiling at which an over-verbose fact is truncated (never dropped,
# never queued — the knowledge base must build without a human in the loop).
MAX_FACT_CHARS = 320
MAX_SECTION_CHARS = 80
MAX_DETAIL_CHARS = 8000

VALID_ACTIONS = ("add_fact", "update_state", "revise_fact", "add_detail")
VALID_CONFIDENCE = ("high", "medium", "low")

# Sections an op may target inside an index.md. Free-form sections are
# refused — a fixed vocabulary keeps indexes readable and injection-resistant.
INDEX_SECTIONS = (
    "What this is",
    "Current state",
    "Decisions",
    "Conventions & gotchas",
    "Key paths",
    "People",
    "Open questions",
    "Corrections",
)

_SAFE_DETAIL_RE = re.compile(r"^details/[a-z0-9][a-z0-9._-]{0,80}\.md$")
_NODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]*(/[A-Za-z0-9][A-Za-z0-9._ -]*)*$")

# Text that must never enter a file that lands in system prompts (hermes
# lesson: memory writes are an injection channel).
_INJECTION_MARKERS = ("<system-reminder", "</system", "IMPORTANT: ignore", "disregard previous")


def knowledge_dir(home: Path) -> Path:
    return home / ".shellteam" / "knowledge"


def tree_dir(home: Path) -> Path:
    return knowledge_dir(home) / "tree"


def node_dir(home: Path, node: str) -> Path:
    return tree_dir(home) / node


def changelog_path(home: Path) -> Path:
    return knowledge_dir(home) / "changelog.jsonl"


def review_queue_path(home: Path) -> Path:
    return knowledge_dir(home) / "review-queue.jsonl"


# --- node resolution -----------------------------------------------------------------


def node_for_cwd(cwd: str | Path, home: Path) -> str | None:
    """Which knowledge node a session working in ``cwd`` accrues to.

    * under a top-level folder of ``home`` → that folder's node (nearest
      EXISTING deeper node wins, so deliberately-split subtrees keep working);
    * ``home`` itself or outside it → ``""`` (the root/manager scope);
    * anywhere under a dot-directory (``~/.shellteam``, ``~/.claude`` …) →
      ``None``: structurally excluded, which is also the self-ingestion guard —
      dream extraction sessions run under ``~/.shellteam/dream/`` and can
      therefore never feed tomorrow's dream.
    """
    cwd = Path(os.path.normpath(str(cwd)))
    home = Path(os.path.normpath(str(home)))
    if cwd == home:
        return ""
    try:
        rel = cwd.relative_to(home)
    except ValueError:
        return ""  # sessions outside HOME still teach us about the user
    parts = rel.parts
    if any(p.startswith(".") for p in parts):
        return None
    # Nearest existing node under the full relpath chain, else the top segment.
    for depth in range(len(parts), 0, -1):
        candidate = "/".join(parts[:depth])
        if (node_dir(home, candidate) / "index.md").exists():
            return candidate
    return parts[0]


def list_nodes(home: Path) -> list[str]:
    """All node relpaths that have an index.md, sorted."""
    root = tree_dir(home)
    if not root.is_dir():
        return []
    return sorted(
        str(p.parent.relative_to(root)) for p in root.rglob("index.md")
    )


def ensure_node(home: Path, node: str) -> Path:
    """Create the node skeleton if missing; returns the index path."""
    _validate_node_name(node)
    d = node_dir(home, node)
    index = d / "index.md"
    if not index.exists():
        d.mkdir(parents=True, exist_ok=True)
        (d / "details").mkdir(exist_ok=True)
        title = node.split("/")[-1]
        lines = [f"# {title} — project knowledge", ""]
        lines.append(
            "> Maintained nightly by ShellTeam dreaming; agents spawned in "
            f"`~/{node}` read this at launch. Edit freely — your edits win."
        )
        for section in INDEX_SECTIONS:
            lines += ["", f"## {section}"]
        _atomic_write(index, "\n".join(lines) + "\n")
        log.info("Knowledge node created: %s", node)
    return index


def _validate_node_name(node: str) -> None:
    if not node or not _NODE_RE.match(node) or ".." in node:
        raise ValueError(f"Invalid knowledge node name: {node!r}")


# --- the apply engine ----------------------------------------------------------------


@dataclass
class ApplyResult:
    applied: list[dict] = field(default_factory=list)
    queued: list[dict] = field(default_factory=list)
    deduped: list[dict] = field(default_factory=list)
    refused: list[dict] = field(default_factory=list)

    def counts(self) -> dict:
        return {
            "applied": len(self.applied),
            "queued": len(self.queued),
            "deduped": len(self.deduped),
            "refused": len(self.refused),
        }


def apply_delta(
    home: Path, node: str, ops: list[dict], run: str, *, force: bool = False
) -> ApplyResult:
    """Apply one batch of proposed ops. The ONLY write path into knowledge.

    Scope rule (structural, not prompted): a batch for ``node`` may write ONLY
    that node's ``index``/``details/*``. The owner batch (``node == ""``) is
    the single writer of the user layer (identity/preferences/feedback) and
    the root layer (projects/contacts). Everything else is refused and logged.

    Confidence controls autonomy: high/medium apply immediately; only "low"
    facts wait in the OPTIONAL review queue. ``force=True`` (owner approval)
    applies a queued low-confidence fact, never bypassing scope/injection.
    Over-long facts are truncated at apply time, never queued or dropped.
    """
    result = ApplyResult()
    for op in ops:
        verdict, reason = _apply_one(home, node, op, run, force=force)
        getattr(result, verdict).append({**op, "reason": reason} if reason else op)
        _log_change(home, run, node, op, verdict, reason)
    log.info("Knowledge apply for node %r run %s: %s", node or "<root>", run, result.counts())
    return result


def _apply_one(
    home: Path, node: str, op: dict, run: str, *, force: bool
) -> tuple[str, str]:
    ok, reason = _validate_op(node, op)
    if not ok:
        return "refused", reason
    # The knowledge base builds itself: high AND medium confidence apply
    # automatically. Only genuinely-shaky "low" facts wait in the OPTIONAL
    # review queue — nothing the box learns depends on the owner working it
    # (docs/decisions/20260710-dreaming-autonomous-review.md).
    if not force and op.get("confidence") == "low":
        _queue_for_review(home, run, node, op)
        return "queued", "confidence=low"

    target = _resolve_target(home, node, op)
    text = _truncate_fact(op["text"].strip(), op["action"])

    if op["action"] == "add_detail":
        body = (
            f"\n\n## {op.get('section', 'Notes')} — {run}\n\n{text}\n"
        )
        existing = target.read_text() if target.exists() else f"# {target.stem}\n"
        if _normalize(text) in _normalize(existing):
            return "deduped", ""
        target.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(target, existing + body)
        return "applied", ""

    # Fact-shaped ops append one bullet under their section.
    if _is_index(node, op):
        ensure_node(home, node)
    elif not target.exists():
        knowledge_dir(home).mkdir(parents=True, exist_ok=True)
        _atomic_write(target, f"# {target.stem}\n")

    content = target.read_text()
    if _normalize(text) in _normalize(content):
        return "deduped", ""

    section = "Corrections" if op["action"] == "revise_fact" else op.get("section", "Current state")
    bullet = f"- {text}"
    if op["action"] == "revise_fact" and op.get("supersedes"):
        bullet += f" *(supersedes: {op['supersedes'].strip()})*"

    new_content = _append_under_section(content, section, bullet)

    # Index size cap: overflow the OLDEST "Current state" bullets to details/,
    # never the fresh fact — recency wins in the injected file.
    if _is_index(node, op) and len(new_content.splitlines()) > MAX_INDEX_LINES:
        new_content = _overflow_index(home, node, new_content, run)

    _atomic_write(target, new_content)
    return "applied", ""


def _truncate_fact(text: str, action: str) -> str:
    """Clamp an over-verbose fact to the ceiling at a word boundary + ellipsis.

    Length is never a reason to DROP or QUEUE a fact — the box must learn
    autonomously. The extraction prompt asks for succinct facts; this only
    catches the rare verbose one so it still lands, just trimmed. ``add_detail``
    bodies live in un-injected details files, so they keep the larger ceiling.
    """
    cap = MAX_DETAIL_CHARS if action == "add_detail" else MAX_FACT_CHARS
    if len(text) <= cap:
        return text
    clipped = text[: cap - 1]
    cut = clipped.rsplit(" ", 1)[0] if " " in clipped[-40:] else clipped
    log.info("Knowledge fact truncated from %d to %d chars", len(text), len(cut) + 1)
    return cut.rstrip(" ,;:") + "…"


def _string_hygiene(value, *, what: str, cap: int, multiline: bool = False) -> str:
    """Reason ``value`` may not enter a knowledge file, or "" when clean.

    EVERY op field written into a file (text, section, supersedes) passes
    through here — each ends up inside markdown injected into agent system
    prompts, so each is an injection channel. Length is NOT policed here: an
    over-long fact is truncated at apply time, not refused (see
    ``_truncate_fact``); section/supersedes get an explicit length refusal at
    their call site because an over-long one there means a malformed op.
    """
    if not isinstance(value, str) or not value.strip():
        return f"empty {what}"
    if not multiline and "\n" in value.strip():
        return f"{what} must be single-line"
    lowered = value.lower()
    if any(m.lower() in lowered for m in _INJECTION_MARKERS):
        return f"injection marker in {what}"
    return ""


def _validate_op(node: str, op: dict) -> tuple[bool, str]:
    action = op.get("action")
    if action not in VALID_ACTIONS:
        return False, f"unknown action {action!r}"
    if reason := _string_hygiene(
        op.get("text", ""), what="text", cap=MAX_FACT_CHARS,
        multiline=action == "add_detail",
    ):
        return False, reason
    if op.get("confidence") not in VALID_CONFIDENCE:
        return False, f"invalid confidence {op.get('confidence')!r}"
    # Over-length in the metadata fields (section header, supersedes note) is a
    # malformed op, not a verbose fact — refuse rather than truncate.
    section = op.get("section")
    if section is not None:
        if reason := _string_hygiene(section, what="section", cap=MAX_SECTION_CHARS):
            return False, reason
        if len(section) > MAX_SECTION_CHARS:
            return False, f"section exceeds {MAX_SECTION_CHARS} chars"
    supersedes = op.get("supersedes")
    if supersedes is not None:
        if reason := _string_hygiene(supersedes, what="supersedes", cap=MAX_FACT_CHARS):
            return False, reason
        if len(supersedes) > MAX_FACT_CHARS:
            return False, f"supersedes exceeds {MAX_FACT_CHARS} chars"

    file = op.get("file", "index")
    if file == "index":
        if not node:
            return False, "owner batch has no index; target a user/root-layer file"
        if section is not None and section not in INDEX_SECTIONS:
            return False, f"unknown index section {section!r}"
    elif _SAFE_DETAIL_RE.match(file or ""):
        if not node:
            return False, "owner batch cannot write node details"
        if action != "add_detail":
            return False, "details files only accept add_detail"
    else:
        stem = (file or "").removesuffix(".md") + ".md"
        if stem not in USER_LAYER_FILES + ROOT_LAYER_FILES:
            return False, f"target {file!r} outside batch scope"
        if node:
            return False, f"node batch may not write {stem} — the owner pass owns the user/root layer"
        if action == "add_detail":
            return False, "user/root layer accepts facts only"
    return True, ""


def _resolve_target(home: Path, node: str, op: dict) -> Path:
    file = op.get("file", "index")
    if file == "index":
        return node_dir(home, node) / "index.md"
    if _SAFE_DETAIL_RE.match(file or ""):
        return node_dir(home, node) / file
    stem = (file or "").removesuffix(".md") + ".md"
    return knowledge_dir(home) / stem


def _is_index(node: str, op: dict) -> bool:
    return bool(node) and op.get("file", "index") == "index"


def _append_under_section(content: str, section: str, bullet: str) -> str:
    lines = content.splitlines()
    header = f"## {section}"
    try:
        idx = lines.index(header)
    except ValueError:
        return content.rstrip("\n") + f"\n\n{header}\n{bullet}\n"
    # Insert after the last non-empty line of this section.
    end = len(lines)
    for j in range(idx + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    insert_at = end
    while insert_at > idx + 1 and not lines[insert_at - 1].strip():
        insert_at -= 1
    lines.insert(insert_at, bullet)
    return "\n".join(lines) + "\n"


def _overflow_index(home: Path, node: str, content: str, run: str) -> str:
    """Move the oldest 'Current state' bullets into details/archive.md until
    the index fits the cap. Nothing is ever deleted — only relocated."""
    lines = content.splitlines()
    archive = node_dir(home, node) / "details" / "archive.md"
    moved: list[str] = []
    try:
        start = lines.index("## Current state") + 1
    except ValueError:
        return content  # nothing safe to relocate; oversized beats destroyed
    while len(lines) > MAX_INDEX_LINES:
        victim = None
        for j in range(start, len(lines)):
            if lines[j].startswith("## "):
                break
            if lines[j].startswith("- "):
                victim = j
                break
        if victim is None:
            break
        moved.append(lines.pop(victim))
    if moved:
        archive.parent.mkdir(parents=True, exist_ok=True)
        prev = archive.read_text() if archive.exists() else "# archive\n"
        _atomic_write(
            archive, prev + f"\n## Archived from index — {run}\n" + "\n".join(moved) + "\n"
        )
        pointer = "- Older state notes: see `details/archive.md`"
        if pointer not in lines:
            lines.insert(start, pointer)
        log.info("Knowledge index %s over cap: archived %d bullets", node, len(moved))
    return "\n".join(lines) + "\n"


# --- review queue --------------------------------------------------------------------


def _queue_for_review(home: Path, run: str, node: str, op: dict) -> None:
    entry = {
        "id": uuid.uuid4().hex[:12],
        "ts": _now_iso(),
        "run": run,
        "node": node,
        "op": op,
    }
    path = review_queue_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def list_review_queue(home: Path) -> list[dict]:
    path = review_queue_path(home)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def resolve_review(home: Path, entry_id: str, approve: bool) -> dict:
    """Approve (apply with force) or dismiss one queued proposal."""
    entries = list_review_queue(home)
    keep, match = [], None
    for e in entries:
        if e["id"] == entry_id:
            match = e
        else:
            keep.append(e)
    if match is None:
        raise KeyError(f"No review entry {entry_id!r}")
    _atomic_write(
        review_queue_path(home), "".join(json.dumps(e) + "\n" for e in keep)
    )
    if approve:
        result = apply_delta(home, match["node"], [match["op"]], match["run"], force=True)
        log.info("Review %s approved: %s", entry_id, result.counts())
        return {"resolved": "approved", **result.counts()}
    _log_change(home, match["run"], match["node"], match["op"], "dismissed", "owner dismissed")
    log.info("Review %s dismissed by owner", entry_id)
    return {"resolved": "dismissed"}


# --- plumbing ------------------------------------------------------------------------


def _log_change(home: Path, run: str, node: str, op: dict, verdict: str, reason: str) -> None:
    path = changelog_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps({
            "ts": _now_iso(),
            "run": run,
            "node": node,
            "verdict": verdict,
            "reason": reason,
            "action": op.get("action"),
            "file": op.get("file", "index"),
            "hash": hashlib.sha1(
                f"{node}|{op.get('action')}|{op.get('file')}|{op.get('text','')}".encode()
            ).hexdigest()[:16],
            "text": (op.get("text") or "")[:200],
        }) + "\n")


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _atomic_write(path: Path, content: str) -> None:
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(content)
    tmp.replace(path)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")

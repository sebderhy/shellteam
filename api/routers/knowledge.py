"""Knowledge tab API (``dreaming`` module) — owner-gated.

Read/edit what the box knows (``~/.shellteam/knowledge/``), work the review
queue, and trigger/inspect dream runs. Everything is path-jailed to the
knowledge dir and 404s when the module is off — the tab simply doesn't exist
on a box that doesn't dream.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api import config
from api.dependencies import get_current_user
from api.services import dreaming
from api.services import knowledge_tree as kt

log = logging.getLogger("shellteam.knowledge")

router = APIRouter(prefix="/api/knowledge")

_dream_task: asyncio.Task | None = None


def _require_dreaming() -> None:
    # Attribute access (not a value import) so the gate follows config.MODULES
    # at call time — same reason the tests can flip it per-case.
    if "dreaming" not in config.MODULES:
        raise HTTPException(status_code=404, detail="dreaming module not enabled")


def _home() -> Path:
    return Path(config.HOME_DIR)


def _jail(rel: str) -> Path:
    """Resolve a knowledge-relative path, refusing escapes and non-markdown."""
    if ".." in Path(rel).parts or Path(rel).is_absolute():
        raise HTTPException(status_code=400, detail="path traversal not allowed")
    base = kt.knowledge_dir(_home()).resolve()
    p = (base / rel).resolve()
    if not str(p).startswith(str(base) + "/") and p != base:
        raise HTTPException(status_code=400, detail="path escapes the knowledge dir")
    if p.suffix != ".md":
        raise HTTPException(status_code=400, detail="only .md files are editable here")
    return p


@router.get("/tree")
async def tree(user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    home = _home()
    kdir = kt.knowledge_dir(home)

    def entry(rel: str) -> dict:
        p = kdir / rel
        return {"path": rel, "exists": p.exists(),
                "size": p.stat().st_size if p.exists() else 0}

    nodes = []
    for node in kt.list_nodes(home):
        details = sorted(
            p.name for p in (kt.node_dir(home, node) / "details").glob("*.md")
        ) if (kt.node_dir(home, node) / "details").is_dir() else []
        nodes.append({
            "node": node,
            "index": f"tree/{node}/index.md",
            "details": [f"tree/{node}/details/{d}" for d in details],
        })
    return {
        "user_layer": [entry(f) for f in kt.USER_LAYER_FILES],
        "root_layer": [entry(f) for f in kt.ROOT_LAYER_FILES],
        "nodes": nodes,
        "review_count": len(kt.list_review_queue(home)),
    }


@router.get("/file")
async def read_file(
    path: str, user: dict = Depends(get_current_user), _=Depends(_require_dreaming)
):
    p = _jail(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"{path} does not exist")
    return {"path": path, "content": p.read_text()}


class FileWrite(BaseModel):
    path: str
    content: str


@router.put("/file")
async def write_file(
    body: FileWrite, user: dict = Depends(get_current_user), _=Depends(_require_dreaming)
):
    p = _jail(body.path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content)
    log.info("Knowledge file edited by owner: %s (%d bytes)", body.path, len(body.content))
    return {"saved": body.path, "bytes": len(body.content)}


@router.get("/review")
async def review_queue(user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    return {"entries": kt.list_review_queue(_home())}


class ReviewDecision(BaseModel):
    approve: bool


@router.post("/review/{entry_id}")
async def review_decide(
    entry_id: str, body: ReviewDecision,
    user: dict = Depends(get_current_user), _=Depends(_require_dreaming),
):
    try:
        return kt.resolve_review(_home(), entry_id, body.approve)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no review entry {entry_id}") from None


@router.post("/dream/run")
async def dream_run(user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    """Owner 'dream now'. Runs the sweep in a worker thread; the flock inside
    run_dream() makes a concurrent timer/manual overlap a clean error."""
    global _dream_task
    if (_dream_task and not _dream_task.done()) or dreaming.is_dream_running(_home()):
        raise HTTPException(status_code=409, detail="a dream run is already in progress")
    log.info("Owner triggered a dream run from the Knowledge tab")
    _dream_task = asyncio.create_task(asyncio.to_thread(dreaming.run_dream, _home()))
    return {"started": True}


@router.get("/dream/status")
async def dream_status(user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    home = _home()
    state = dreaming._load_state(home)
    # The flock probe also sees the nightly systemd-timer run (a different
    # process) — _dream_task alone only knows about API-started runs.
    running = bool(_dream_task and not _dream_task.done()) or dreaming.is_dream_running(home)
    error = None
    if _dream_task and _dream_task.done() and _dream_task.exception():
        error = str(_dream_task.exception())[:300]
    report_name = state.get("last_report")
    if not report_name:
        # Boxes that dreamed before last_report existed in state: glob once as
        # a fallback (fragile — any stray dream-*.html shadows the real one).
        reports = sorted((home / "reports").glob("dream-*.html")) if (home / "reports").is_dir() else []
        report_name = reports[-1].name if reports else None
    return {
        "running": running,
        "error": error,
        "state": state,
        "latest_report": f"/reports/{report_name}" if report_name else None,
    }

"""Knowledge tab API (``dreaming`` module), owner-gated.

The tree with how full each level is, what a chat was told, a night's
changes with undo, the owner's edits of memory's printed views
(``~/.shellteam/memory/views``), and starting or inspecting a night. Everything is path-jailed to the views and 404s
when the module is off: the tab does not exist on a box that does not dream.
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
from api.services.memory import nightly as memory_nightly
from api.services.memory import overview as memory_overview
from api.services.memory import switch as memory_switch
from api.services.memory import told as memory_told
from api.services.memory import views as memory_views
from api.services.memory.store import Store, memory_root

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
    """Resolve a views-relative path, refusing escapes and non-markdown."""
    if ".." in Path(rel).parts or Path(rel).is_absolute():
        raise HTTPException(status_code=400, detail="path traversal not allowed")
    base = memory_views.views_dir(memory_root(_home())).resolve()
    p = (base / rel).resolve()
    if not str(p).startswith(str(base) + "/") and p != base:
        raise HTTPException(status_code=400, detail="path escapes the knowledge dir")
    if p.suffix != ".md":
        raise HTTPException(status_code=400, detail="only .md files are editable here")
    return p


@router.get("/overview")
async def overview(user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    """The tree with how full each level is, the latest nights, the cockpit's
    chats with the level each stands at (K17b)."""
    home = _home()
    chats = [{"id": t["id"], "title": t.get("title") or f"Chat {t['id']}", "cwd": t.get("cwd") or str(home),
              "key": memory_told.launch_key(home, t.get("cwd") or str(home)),
              "last_used": (t.get("lastUsedAt") or 0) / 1000}
             for t in memory_told.cockpit_chats(home)]
    return {"levels": memory_overview.levels(home), "nights": memory_overview.nights(home),
            "chats": sorted(chats, key=lambda c: -c["last_used"])}


@router.get("/told")
async def told(chat: int | None = None, folder: str | None = None,
               user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    """K16: the exact launch text a cockpit chat started with, or the last
    one given in a folder."""
    if folder and (".." in Path(folder).parts or Path(folder).is_absolute()):
        raise HTTPException(status_code=400, detail="folder must be relative to home")
    try:
        return memory_told.told(_home(), chat=chat, folder=folder)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


@router.get("/night/{run}")
async def night(run: str, user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    try:
        return memory_overview.night(_home(), run)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


def _no_night_running() -> None:
    if (_dream_task and not _dream_task.done()) or dreaming.is_dream_running(_home()):
        raise HTTPException(status_code=409, detail="the nightly job is running; try again when it is done")


@router.post("/night/{run}/undo")
async def undo_night(run: str, user: dict = Depends(get_current_user), _=Depends(_require_dreaming)):
    """Every level back to how it was before that night (K7, K17b)."""
    try:
        memory_overview.night(_home(), run)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None
    _no_night_running()
    undone = memory_nightly.undo_night(_home(), run)
    log.info("Owner undid the night %s from the Knowledge tab (%d level change(s))", run, undone)
    return {"undone": undone}


@router.post("/night/{run}/undo-split/{folder:path}")
async def undo_split(run: str, folder: str, user: dict = Depends(get_current_user),
                     _=Depends(_require_dreaming)):
    """A sub-area's card taken back: its facts return to the level above (K18)."""
    _no_night_running()
    if not memory_nightly.undo_split(_home(), run, folder):
        raise HTTPException(status_code=404, detail=f"no split of {folder} to undo in night {run}")
    log.info("Owner undid the split of %s of night %s from the Knowledge tab", folder, run)
    return {"undone": True}


@router.post("/night/{run}/undo/{fact_id}")
async def undo_change(run: str, fact_id: str, user: dict = Depends(get_current_user),
                      _=Depends(_require_dreaming)):
    """One change of a night put back: a wrong merge, a wrong replace."""
    _no_night_running()
    if not memory_nightly.undo_change(_home(), run, fact_id):
        raise HTTPException(status_code=404, detail=f"no change to undo for {fact_id} in night {run}")
    log.info("Owner undid one change of night %s from the Knowledge tab (%s)", run, fact_id)
    return {"undone": True}


@router.get("/file")
async def read_file(
    path: str, user: dict = Depends(get_current_user), _=Depends(_require_dreaming),
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
    """An owner edit of a printed view (K17a). The file is a print of the fact
    list, so the edit is read back as facts at once: a changed line becomes a
    pinned owner fact, a deleted line is removed for good, a new line is a
    pinned fact at that level. Then the views are printed again."""
    p = _jail(body.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"{body.path} is not a printed view")
    home = _home()
    p.write_text(body.content)
    store = Store(memory_root(home))
    report = memory_views.print_views(store, clock_start=memory_switch.live_since(home))
    log.info("Memory view edited by owner: %s (%d change(s) taken in)", body.path,
             len(report.owner_edits))
    return {"saved": body.path, "bytes": len(body.content), "taken_in": report.owner_edits,
            "content": p.read_text() if p.exists() else ""}


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
    return {
        "running": running,
        "error": error,
        "state": state,
        "latest_report": f"/reports/{report_name}" if report_name else None,
    }

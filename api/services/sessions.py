"""Owner login sessions: the value the browser cookie carries (SHE-136).

Before SHE-136 the dashboard cookie WAS the master ``OWNER_TOKEN``: whoever read
one browser's cookie jar (on 2026-11-03, a container on the default Docker
bridge reading the agent browser through its CDP port) held a never-expiring
credential for the terminal, the files and the agents.

Now ``OWNER_TOKEN`` only bootstraps a login (dashboard login, one-time
enrollment link, ``GET /?token=``) and stays valid as a Bearer header for
in-box tooling. Every login mints a random session here:

  - cookie value ``s1.<id>.<secret>``; the store keeps ``sha256(secret)`` only
    (a copied store file logs nobody in);
  - the read-only files credential is ``f1.<id>.<HMAC(master, id)>``, so it
    lives and dies with its session;
  - sessions expire (``SESSION_TTL_DAYS``, default 14) and can be revoked one
    by one (log out) or all at once (log out everywhere);
  - the store is bound to the current master by an HMAC "epoch": rotating
    ``OWNER_TOKEN`` revokes every session on the next lookup.

This module is the single owner of ``DATA_DIR/<owner>/sessions.json`` (0600).
The OSS control plane is one uvicorn process; a process lock serialises
writes, and the file is re-read when its mtime changes so an out-of-process
revocation (another tool rewriting the file) still applies.
"""

import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from api.config import DATA_DIR, OWNER_ID

log = logging.getLogger(__name__)

SESSION_TTL = int(float(os.environ.get("SESSION_TTL_DAYS", "14")) * 86400)

_TOKEN_PREFIX = "s1"
_FILES_PREFIX = "f1"
_lock = threading.Lock()
_cache: dict = {"mtime": None, "data": None}


@dataclass(frozen=True)
class Minted:
    id: str
    token: str
    files_cred: str
    expires: int


def _master() -> str:
    # Read at call time from the auth module (the one place the rest of the app
    # reads OWNER_TOKEN from), so a rotation is seen without a re-import.
    from api.services import auth

    return auth.OWNER_TOKEN


def _hmac(purpose: str) -> str:
    return hmac.new(_master().encode(), purpose.encode(), hashlib.sha256).hexdigest()


def _epoch() -> str:
    return _hmac("sessions-epoch-v1")


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8", "ignore")).hexdigest()


def store_path() -> Path:
    return DATA_DIR / OWNER_ID / "sessions.json"


def _empty() -> dict:
    return {"version": 1, "epoch": _epoch(), "sessions": {}}


def _read() -> dict:
    """The store, re-read from disk only when it changed. Caller holds _lock."""
    path = store_path()
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        if _cache["data"] is None or _cache["mtime"] is not None:
            _cache.update(mtime=None, data=_empty())
        return _cache["data"]
    if _cache["mtime"] != mtime or _cache["data"] is None:
        _cache.update(mtime=mtime, data=json.loads(path.read_text()))
    return _cache["data"]


def _write(data: dict) -> None:
    """Atomic 0600 write. Caller holds _lock."""
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    _cache.update(mtime=path.stat().st_mtime_ns, data=data)


def _live() -> dict:
    """The current store with expired sessions dropped and, when OWNER_TOKEN
    was rotated since the store was written, EVERY session dropped. Caller holds
    _lock."""
    data = _read()
    now = time.time()
    changed = False
    if not hmac.compare_digest(str(data.get("epoch", "")), _epoch()):
        n = len(data.get("sessions", {}))
        if n:
            log.warning("OWNER_TOKEN changed since the sessions were issued: revoked %d session(s)", n)
        if data.get("epoch"):  # a previous token existed: this is a change, not a first start
            from api.services import security_watch
            security_watch.note_token_changed(n)
        data = _empty()
        changed = True
    expired = [sid for sid, s in data["sessions"].items() if s["expires"] <= now]
    for sid in expired:
        del data["sessions"][sid]
        changed = True
    if changed:
        _write(data)
    return data


def files_cred_for(sid: str) -> str:
    """The read-only files credential bound to one session."""
    return f"{_FILES_PREFIX}.{sid}.{_hmac(f'files-v2|{sid}')}"


def mint(
    kind: str, ip: str | None = None, ua: str | None = None, parent: dict | None = None,
) -> Minted:
    """Create a session.

    ``parent`` is the session that minted an enrollment link (SHE-147): the new
    device inherits its end date and dies with it, so a stolen cookie can't
    launder itself into a longer-lived, unrevocable one.
    """
    if not _master():
        raise RuntimeError("sessions need OWNER_TOKEN (localhost-trust mode has no logins)")
    sid = secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    now = int(time.time())
    record = {
        "hash": _hash(secret),
        "kind": kind,
        "created": now,
        "expires": now + SESSION_TTL,
        "ip": (ip or "")[:64],
        "ua": (ua or "")[:200],
    }
    if parent is not None:
        record["expires"] = min(record["expires"], int(parent["expires"]))
        record["parent"] = parent["id"]
    with _lock:
        data = _live()
        data["sessions"][sid] = record
        _write(data)
    log.info("Session %s minted (kind=%s, ip=%s, ttl=%ds)", sid, kind, record["ip"] or "?", SESSION_TTL)
    from api.services import security_watch
    security_watch.note_signin(kind, record["ip"], ua)
    return Minted(sid, f"{_TOKEN_PREFIX}.{sid}.{secret}", files_cred_for(sid), record["expires"])


def _split(value: str | None, prefix: str) -> tuple[str, str] | None:
    if not isinstance(value, str) or not value:
        return None
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != prefix or not parts[1] or not parts[2]:
        return None
    return parts[1], parts[2]


def lookup(token: str | None) -> dict | None:
    """The live session record (with ``id``) for a session token, else None."""
    if not _master():
        return None
    parsed = _split(token, _TOKEN_PREFIX)
    if parsed is None:
        return None
    sid, secret = parsed
    with _lock:
        rec = _live()["sessions"].get(sid)
    if rec is None or not hmac.compare_digest(rec["hash"], _hash(secret)):
        return None
    return {"id": sid, **rec}


def lookup_id(sid: str) -> dict | None:
    """The live session record for an id (no secret: internal use only)."""
    with _lock:
        rec = _live()["sessions"].get(sid)
    return None if rec is None else {"id": sid, **rec}


def lookup_files_cred(cred: str | None) -> dict | None:
    """The live session a files credential belongs to, else None."""
    if not _master():
        return None
    parsed = _split(cred, _FILES_PREFIX)
    if parsed is None:
        return None
    sid, _sig = parsed
    if not hmac.compare_digest(cred.encode("utf-8", "ignore"), files_cred_for(sid).encode()):
        return None
    with _lock:
        rec = _live()["sessions"].get(sid)
    return None if rec is None else {"id": sid, **rec}


def revoke(sid: str) -> bool:
    """Revoke a session and every device it enrolled (and theirs)."""
    with _lock:
        data = _live()
        doomed, frontier = set(), {sid}
        while frontier:
            doomed |= frontier
            frontier = {k for k, r in data["sessions"].items() if r.get("parent") in frontier} - doomed
        gone = [k for k in doomed if data["sessions"].pop(k, None) is not None]
        if gone:
            _write(data)
    log.info("Session %s revoked (existed=%s, enrolled devices also revoked: %d)",
             sid, sid in gone, max(0, len(gone) - (sid in gone)))
    return sid in gone


def revoke_all() -> int:
    """Log out everywhere. Returns how many sessions were revoked."""
    with _lock:
        data = _live()
        n = len(data["sessions"])
        _write(_empty())
    if n:
        log.warning("All %d session(s) revoked (log out everywhere)", n)
    from api.services import security_watch
    security_watch.note_signout_all(n)
    return n


def list_sessions() -> list[dict]:
    """Metadata of the live sessions (never the hashes)."""
    with _lock:
        items = list(_live()["sessions"].items())
    return [
        {k: v for k, v in {"id": sid, **rec}.items() if k != "hash"}
        for sid, rec in sorted(items, key=lambda kv: kv[1]["created"], reverse=True)
    ]

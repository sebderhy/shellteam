"""Forward in-product feedback (bug reports + feature requests) to the ShellTeam
maintainer relay.

The OSS box holds **no maintainer secret** — it is open source, so anything
shipped in it is readable by whoever installs it and would be extracted and
abused under our quota. So the box never talks to Linear/our DB directly; it
POSTs the report to a thin public relay we operate (``feedback.shellteam.sh``),
which holds *our* Linear key and files the issue.

A hashcash-style proof-of-work header gates that public, no-secret endpoint
against spam without any shared secret: the box spends a fraction of a second
finding a nonce; the relay re-verifies in a single hash.
"""

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid

import httpx

from api.config import HOME_DIR

log = logging.getLogger(__name__)

# Where the box ships reports. Overridable so a self-hoster can point at their
# own relay/webhook (or a dev relay) without code changes.
RELAY_URL = os.environ.get("FEEDBACK_RELAY_URL", "https://feedback.shellteam.sh/report")
# PoW difficulty in leading zero bits of sha256(install_id:ts:nonce). Must be
# >= the relay's required minimum (kept in lockstep; both default to 18 — about
# a quarter-million hashes, well under a second). Raise the box first if changed.
POW_BITS = int(os.environ.get("FEEDBACK_POW_BITS", "18"))

# Stable anonymous per-box id, persisted once. Lets the relay dedup/rate-limit a
# box without identifying the owner.
INSTALL_ID_FILE = HOME_DIR / ".shellteam" / "feedback-install-id"


def install_id() -> str:
    """Return this box's stable anonymous feedback id, minting it on first use."""
    if INSTALL_ID_FILE.exists():
        return INSTALL_ID_FILE.read_text().strip()
    new_id = uuid.uuid4().hex
    INSTALL_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
    INSTALL_ID_FILE.write_text(new_id)
    log.info("Minted feedback install id %s", new_id)
    return new_id


def _leading_zero_bits(digest: bytes) -> int:
    """Number of leading zero *bits* in a digest (the PoW difficulty metric)."""
    bits = 0
    for byte in digest:
        if byte:
            return bits + (8 - byte.bit_length())
        bits += 8
    return bits


def solve_pow(iid: str, ts: int, bits: int = POW_BITS) -> int:
    """Find a nonce so sha256(``iid:ts:nonce``) has ``bits`` leading zero bits.

    Synchronous and CPU-bound (~2^bits hashes); call via ``asyncio.to_thread``
    so it never blocks the event loop. The relay re-checks it in one hash.
    """
    prefix = f"{iid}:{ts}:".encode()
    nonce = 0
    while _leading_zero_bits(hashlib.sha256(prefix + str(nonce).encode()).digest()) < bits:
        nonce += 1
    return nonce


async def forward(
    *,
    kind: str,
    description: str,
    transcript: str,
    meta: dict,
    screenshots: list[tuple[str, bytes, str]],
) -> dict:
    """POST a report to the relay and return its JSON (``{ok, issue_url?}``).

    Raises ``RuntimeError`` on a non-200 from the relay so the route surfaces a
    real error to the user — never a silent drop.
    """
    iid = install_id()
    ts = int(time.time())
    nonce = await asyncio.to_thread(solve_pow, iid, ts)
    headers = {
        "X-Feedback-Install": iid,
        "X-Feedback-Pow": f"{ts}:{nonce}",
    }
    data = {
        "kind": kind,
        "description": description,
        "transcript": transcript,
        "meta": json.dumps(meta),
    }
    files = [("screenshots", (name, content, ctype)) for name, content, ctype in screenshots]

    log.info(
        "Forwarding feedback to relay %s: kind=%s shots=%d transcript=%dchars",
        RELAY_URL, kind, len(screenshots), len(transcript),
    )
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(RELAY_URL, headers=headers, data=data, files=files or None)

    if resp.status_code != 200:
        log.warning("Feedback relay rejected report: %s %s", resp.status_code, resp.text[:300])
        raise RuntimeError(f"Feedback service error (HTTP {resp.status_code})")

    body = resp.json()
    log.info("Feedback delivered: kind=%s issue=%s", kind, body.get("issue_url"))
    return body

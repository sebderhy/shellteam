"""Inline same-subtree image references into content-sandboxed HTML.

Documents served through the main-host file catch-all carry
``Content-Security-Policy: sandbox`` without ``allow-same-origin``
(docs/decisions/20260717-served-content-sandbox.md), so they run at an opaque
origin. From an opaque origin the browser treats *every* subresource request as
cross-origin: the file server sends no ``Access-Control-Allow-Origin``, so a
report's ``<img src="assets/chart.png">`` is CORS-blocked and renders broken in
a plain browser tab (it only worked inside the cockpit panel, whose iframe is
granted same-origin).

The fix is to rewrite, at serve time, relative ``<img src>`` references that
resolve INSIDE the document's own directory subtree into ``data:`` URIs.
This deliberately does NOT touch the sandbox itself:

- The document's origin stays opaque; the master-cookie isolation the sandbox
  exists for is unchanged.
- No new network grant is minted. Adding ``Access-Control-Allow-Origin`` to
  asset responses was rejected because a signed share link (``?sig=&exp=``)
  authorizes only the HTML path — sibling image requests would still be denied,
  so shared private reports would stay broken. Inlining rides the single grant
  the HTML request already passed.
- What CAN be embedded is tightly bounded: relative refs only (no absolute
  paths, no schemes), resolved strictly under the document's own directory,
  dotfiles denied, image extensions only, per-asset and per-document size caps.

Every skipped reference is logged so a half-rendered report is diagnosable
from ``journalctl`` alone.
"""

from __future__ import annotations

import base64
import logging
import posixpath
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

log = logging.getLogger("shellteam.content_inline")

_IMG_TAG_RE = re.compile(rb"<img\b[^>]*>", re.IGNORECASE)
_SRC_ATTR_RE = re.compile(
    rb"""\bsrc\s*=\s*(?P<q>["'])(?P<url>[^"']*)(?P=q)""", re.IGNORECASE
)

# Extension allowlist doubles as the mime map — anything else is not inlined.
_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
}

MAX_ASSET_BYTES = 8 * 1024 * 1024  # one oversized asset must not balloon the page
MAX_TOTAL_BYTES = 24 * 1024 * 1024  # hard ceiling per document


def _resolve_local_image(src: str, doc_dir: Path, home_dir: Path) -> Path | None:
    """Map a raw ``src`` value to a safe on-disk path, or None to leave it alone.

    Only plain relative references qualify. The resolved target must stay
    inside the document's own directory subtree AND inside the owner home, and
    may not traverse any dotfile segment — mirroring serve_owner_file's gates.
    """
    src = src.strip()
    if not src or src.startswith(("data:", "#", "/")):
        return None
    split = urlsplit(src)
    if split.scheme or split.netloc:
        return None
    rel = unquote(split.path)
    if not rel:
        return None
    candidate = (doc_dir / rel).resolve()
    doc_root = doc_dir.resolve()
    if not candidate.is_relative_to(doc_root):
        log.warning("Not inlining %r — escapes the document directory", src)
        return None
    try:
        home_rel = candidate.relative_to(home_dir.resolve())
    except ValueError:
        log.warning("Not inlining %r — resolves outside the owner home", src)
        return None
    if any(part.startswith(".") for part in home_rel.parts):
        log.warning("Not inlining %r — dotfile path segment", src)
        return None
    if candidate.suffix.lower() not in _MIME_BY_EXT:
        log.info("Not inlining %r — extension not in the image allowlist", src)
        return None
    return candidate


def inline_local_images(html: bytes, doc_relpath: str, home_dir: Path) -> bytes:
    """Rewrite qualifying ``<img src>`` refs in ``html`` to ``data:`` URIs.

    ``doc_relpath`` is the served document's home-relative path (as
    serve_owner_file sees it). Returns the original bytes object unchanged when
    nothing qualifies, so callers can cheaply detect a no-op.
    """
    doc_dir = home_dir / posixpath.dirname(doc_relpath.strip("/"))
    cache: dict[Path, bytes | None] = {}
    budget = {"total": 0, "inlined": 0}

    def _data_uri_for(target: Path, src: str) -> bytes | None:
        if target in cache:
            return cache[target]
        result: bytes | None = None
        try:
            if not target.is_file():
                log.info("Not inlining %r — no such file", src)
            elif (size := target.stat().st_size) > MAX_ASSET_BYTES:
                log.warning(
                    "Not inlining %r — %d bytes exceeds the %d per-asset cap",
                    src, size, MAX_ASSET_BYTES,
                )
            elif budget["total"] + size > MAX_TOTAL_BYTES:
                log.warning(
                    "Not inlining %r — document inline budget (%d bytes) exhausted",
                    src, MAX_TOTAL_BYTES,
                )
            else:
                mime = _MIME_BY_EXT[target.suffix.lower()]
                encoded = base64.b64encode(target.read_bytes())
                budget["total"] += size
                result = b"data:" + mime.encode() + b";base64," + encoded
        except OSError as e:
            # Serving the page with the original (broken) ref beats a 500 —
            # the report is still readable and the cause is in the journal.
            log.warning("Not inlining %r — %s", src, e)
        cache[target] = result
        return result

    def _rewrite_tag(tag_match: re.Match[bytes]) -> bytes:
        def _rewrite_src(src_match: re.Match[bytes]) -> bytes:
            src = src_match.group("url").decode("utf-8", "replace")
            target = _resolve_local_image(src, doc_dir, home_dir)
            if target is None:
                return src_match.group(0)
            data_uri = _data_uri_for(target, src)
            if data_uri is None:
                return src_match.group(0)
            budget["inlined"] += 1
            quote = src_match.group("q")
            return b"src=" + quote + data_uri + quote

        return _SRC_ATTR_RE.sub(_rewrite_src, tag_match.group(0), count=1)

    rewritten = _IMG_TAG_RE.sub(_rewrite_tag, html)
    if budget["inlined"]:
        log.info(
            "Inlined %d image(s) (%d bytes) into sandboxed document /%s",
            budget["inlined"], budget["total"], doc_relpath,
        )
        return rewritten
    return html

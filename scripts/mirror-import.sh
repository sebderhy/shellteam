#!/usr/bin/env bash
# mirror-import.sh — guided "move into your ShellTeam box" wizard.
#
# Run it on your laptop (macOS / Linux / WSL) — your box serves this script
# itself at the exact version it runs (Settings → Import your laptop mints the
# full command):
#   bash <(curl -fsSL https://your-box.example.com/api/mirror/mirror-import.sh) \
#       https://your-box.example.com
#
# Both arguments are optional — your box's Settings page generates the exact
# command with them filled in. Without them you can paste your box link in the
# wizard, or just save a tarball to upload by hand.
#
# What it does:
#   0. Asks which folder to scan — your home by default; on WSL it also offers
#      your Windows profile (C:\Users\<you>), where the real setup usually
#      lives. MIRROR_SCAN_HOME=<dir> skips the question.
#   1. Inventories that folder read-only (scripts/mirror-inventory.sh).
#   2. Opens a local browser UI (127.0.0.1 only) where YOU tick what moves:
#      packages, dotfiles, repos, agent setup, agent logins + authenticated
#      MCPs, chat history, shell history.
#   3. Uploads your selection over TLS directly to YOUR box, which starts the
#      migration automatically.
#
# Privacy model: the default tarball never contains secrets. Credentials and
# chat history ("secure" sections) are opt-in checkboxes and only ever travel
# on a direct TLS upload to your own box — never into a saved, shareable file.
set -euo pipefail

BOX_ARG="${1:-}"
# The import credential comes through the ENVIRONMENT, never a positional
# argument: argv is world-readable in /proc/<pid>/cmdline, so on a shared
# machine any other user could read it while the wizard runs. The box's
# Settings tab mints the command in this shape.
CRED_ARG="${SHELLTEAM_MIRROR_CRED:-}"
export SHELLTEAM_MIRROR_CRED=""
# Where to fetch the inventory engine if this isn't a repo checkout. Prefer the
# BOX: it serves the scripts at exactly its own installed version, so the pair
# can never skew — and no third party (or moved git ref) sits in the path of
# code that reads this laptop. GitHub is only the boxless fallback, and it is
# pinned to a release TAG, never a mutable ref: this code reads your dotfiles,
# so whoever can move a branch must not be able to change what runs here.
# Bump MIRROR_FALLBACK_REF when tagging a release (docs/release-qa.md).
MIRROR_FALLBACK_REF="v0.1.21"
if [ -n "${MIRROR_RAW_BASE:-}" ]; then
    RAW_BASE="$MIRROR_RAW_BASE"
elif [ -n "$BOX_ARG" ]; then
    RAW_BASE="${BOX_ARG%/}/api/mirror"
else
    RAW_BASE="https://raw.githubusercontent.com/sebderhy/shellteam/${MIRROR_FALLBACK_REF}/scripts"
fi

say() { printf '%s\n' "$*"; }

command -v python3 >/dev/null 2>&1 || {
    say "python3 is required (on Ubuntu/WSL: sudo apt install python3)"; exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/shellteam-import.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Find the inventory engine: sibling file in a repo checkout, else download.
INVENTORY=""
if [ -f "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/mirror-inventory.sh" ]; then
    INVENTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mirror-inventory.sh"
else
    INVENTORY="$WORK/mirror-inventory.sh"
    curl -fsSL "$RAW_BASE/mirror-inventory.sh" -o "$INVENTORY"
fi

say "ShellTeam import wizard"
say ""

# ── Step 0: choose the folder this import scans ───────────────────────────────
# The whole inventory is home-relative, so the choice of root decides what the
# wizard sees. On WSL the interesting profile is usually the Windows one
# (C:\Users\<name>), not the often-empty Linux home (learned live on a user's
# machine whose entire setup was on the Windows side).
SCAN_HOME="${MIRROR_SCAN_HOME:-$HOME}"
SCAN_HOME="${SCAN_HOME%/}"
[ -d "$SCAN_HOME" ] || { say "MIRROR_SCAN_HOME is not a folder: $SCAN_HOME"; exit 2; }
WIN_HOME=""
if grep -qi microsoft /proc/version 2>/dev/null && command -v wslpath >/dev/null 2>&1; then
    # cd to a Windows-backed dir first so cmd.exe doesn't warn about a UNC cwd.
    WIN_PROFILE="$(cd /mnt/c 2>/dev/null && cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')" || true
    [ -n "$WIN_PROFILE" ] && WIN_HOME="$(wslpath "$WIN_PROFILE" 2>/dev/null)" || true
    [ -d "$WIN_HOME" ] || WIN_HOME=""
fi
if [ -z "${MIRROR_SCAN_HOME:-}" ] && [ -t 0 ]; then
    say "Which folder should the import scan?"
    say "  1) $HOME  (this ${WIN_HOME:+Linux/WSL }home)"
    OTHER=2
    if [ -n "$WIN_HOME" ]; then
        say "  2) $WIN_HOME  (your Windows profile)"
        OTHER=3
    fi
    say "  $OTHER) another folder (type a path)"
    read -r -p "Choice [1]: " CHOICE
    CHOICE="${CHOICE:-1}"
    if [ "$CHOICE" = "2" ] && [ -n "$WIN_HOME" ]; then
        SCAN_HOME="$WIN_HOME"
    elif [ "$CHOICE" != "1" ]; then
        read -r -p "Folder to scan: " SCAN_HOME
        SCAN_HOME="${SCAN_HOME/#\~/$HOME}"
        SCAN_HOME="${SCAN_HOME%/}"
        [ -d "$SCAN_HOME" ] || { say "Not a folder: $SCAN_HOME"; exit 2; }
    fi
    say ""
elif [ -z "${MIRROR_SCAN_HOME:-}" ] && [ ! -t 0 ]; then
    say "(no terminal to ask on — scanning $HOME; set MIRROR_SCAN_HOME=<dir> to choose)"
fi

say "Step 1/2: inventorying $SCAN_HOME (read-only)…"
STAGE="$WORK/stage"
bash "$INVENTORY" --stage "$STAGE" --home "$SCAN_HOME"
say ""
say "Step 2/2: opening the wizard in your browser…"

export MIRROR_STAGE="$STAGE"
export MIRROR_INVENTORY="$INVENTORY"
export MIRROR_BOX="$BOX_ARG"
export MIRROR_CRED="$CRED_ARG"

python3 - <<'PYEOF'
import http.server
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit, parse_qs

STAGE = os.environ["MIRROR_STAGE"]
INVENTORY = os.environ["MIRROR_INVENTORY"]
HOME = os.path.expanduser("~")
NONCE = secrets.token_hex(16)

SAFE_SECTIONS = ["packages", "dotfiles", "repos", "agents"]
SECURE_SECTIONS = ["logins", "history", "env", "shell-history"]

with open(os.path.join(STAGE, "summary.json")) as fh:
    SUMMARY = json.load(fh)
with open(os.path.join(STAGE, "manifest.json")) as fh:
    MANIFEST = json.load(fh)


def parse_box_link(raw_box, raw_cred=""):
    """Accept a bare box URL, a welcome link with ?token=..., or URL + cred.

    Refuses a cleartext scheme. This upload can carry agent OAuth credentials,
    MCP tokens and full chat history, and the UI promises TLS in so many words —
    silently honouring a pasted http:// link would put all of it on the wire in
    the clear while the page said otherwise.
    """
    box, cred = (raw_box or "").strip(), (raw_cred or "").strip()
    if not box:
        return "", cred
    if "://" not in box:
        box = "https://" + box
    if not box.lower().startswith("https://"):
        raise ValueError(
            "Your box link must start with https:// because this upload carries "
            "credentials and chat history and will not be sent unencrypted."
        )
    parts = urlsplit(box)
    qs = parse_qs(parts.query)
    if not cred and qs.get("token"):
        cred = qs["token"][0]
    return f"{parts.scheme}://{parts.netloc}", cred


INITIAL_BOX, INITIAL_CRED = parse_box_link(os.environ.get("MIRROR_BOX", ""),
                                           os.environ.get("MIRROR_CRED", ""))

STATE = {"phase": "idle", "detail": "", "pct": 0, "open_url": "", "saved": ""}
STATE_LOCK = threading.Lock()


def set_state(**kw):
    with STATE_LOCK:
        STATE.update(kw)


class ProgressFile:
    """File wrapper reporting upload progress into STATE."""

    def __init__(self, path):
        self.fh = open(path, "rb")
        self.total = os.path.getsize(path)
        self.sent = 0

    def read(self, n=-1):
        chunk = self.fh.read(n)
        self.sent += len(chunk)
        if self.total:
            set_state(pct=int(self.sent * 100 / self.total))
        return chunk

    def __len__(self):
        return self.total


def pack(sections, out):
    subprocess.run(
        ["bash", INVENTORY, "--pack", STAGE, "--sections", ",".join(sections), "--out", out],
        check=True, capture_output=True, text=True,
    )


class _NoCredentialLeakRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the Authorization header to a different host on a redirect.

    CPython's default redirect handler strips only Content-Length/Content-Type,
    so a 301/302 from the box URL would hand the import credential — or the
    master OWNER_TOKEN, when the user pasted a welcome link — straight to
    whatever host the redirect names.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urlsplit(newurl).netloc != urlsplit(req.full_url).netloc:
            new.remove_header("Authorization")
        return new


_UPLOAD_OPENER = urllib.request.build_opener(_NoCredentialLeakRedirect)


def run_import(sections, box, cred):
    try:
        set_state(phase="packing", detail="Packing your selection…", pct=0)
        tarball = os.path.join(os.path.dirname(STAGE), "shellteam-mirror-upload.tar.gz")
        pack(sections, tarball)
        size_mb = os.path.getsize(tarball) / (1024 * 1024)
        set_state(phase="uploading", detail=f"Uploading {size_mb:.1f}MB to {box} over TLS…", pct=0)
        body = ProgressFile(tarball)
        req = urllib.request.Request(
            box + "/api/mirror/upload", data=body, method="POST",
            headers={
                "Authorization": f"Bearer {cred}",
                "Content-Type": "application/gzip",
                "Content-Length": str(len(body)),
            },
        )
        try:
            with _UPLOAD_OPENER.open(req, timeout=1800) as resp:
                result = json.loads(resp.read().decode() or "{}")
        finally:
            body.fh.close()
            os.remove(tarball)  # credentials never linger on the laptop
        open_url = box + (f"/?token={cred}" if len(cred) > 40 and not cred.startswith("mirror-v1.") else "")
        started = result.get("migration_started", False)
        set_state(
            phase="done", pct=100, open_url=open_url,
            detail="Your box is setting everything up right now."
            if started else
            "Uploaded. Open your box and tell the agent: “mirror my laptop from the tarball in mirror-inbox”.",
        )
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            msg = "The box refused the upload (link expired or wrong credential). Copy a fresh import command from your box's Settings."
        elif exc.code == 413:
            msg = ("Your selection is bigger than the box accepts (512MB unless raised). "
                   "Untick the heaviest sections — chat history is the usual one — and try again, "
                   "or raise MIRROR_MAX_UPLOAD_MB in the box's .env.")
        else:
            msg = f"The box answered HTTP {exc.code}."
        set_state(phase="error", detail=msg)
    except Exception as exc:  # noqa: BLE001 — every failure must reach the UI
        set_state(phase="error", detail=f"{type(exc).__name__}: {exc}")


def run_save(sections):
    try:
        set_state(phase="packing", detail="Packing a secret-free file…", pct=0)
        safe = [s for s in sections if s in SAFE_SECTIONS]
        stamp = MANIFEST.get("created", "now")
        out = os.path.join(HOME, f"shellteam-mirror-{stamp}.tar.gz")
        pack(safe, out)
        set_state(phase="saved", saved=out,
                  detail=f"Saved {out}. Upload it to your box's Files tab, then ask the agent to run the migrate skill.")
    except Exception as exc:  # noqa: BLE001
        set_state(phase="error", detail=f"{type(exc).__name__}: {exc}")


PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Move into your ShellTeam box</title>
<style>
:root{--bg:#110f0d;--panel:#1a1713;--line:#2c2721;--amber:#f59e0b;--amber-dim:#b97907;
--text:#ede5d8;--dim:#9a8f7d;--faint:#6b6254;--ok:#4ade80;--err:#f87171;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:16px/1.55 "Space Grotesk",system-ui,sans-serif;
min-height:100vh;display:flex;justify-content:center;padding:40px 20px}
.wrap{width:100%;max-width:640px}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
h1{font-size:26px;font-weight:600;letter-spacing:-.02em}
h1 em{color:var(--amber);font-style:normal}
.sub{color:var(--dim);margin:8px 0 28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;margin-bottom:14px}
label.row{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border-radius:8px;cursor:pointer}
label.row:hover{background:#211d17}
label.row.off{opacity:.45;cursor:default}
label.row.off:hover{background:none}
input[type=checkbox]{appearance:none;width:20px;height:20px;flex:none;margin-top:2px;border:1.5px solid var(--faint);
border-radius:5px;cursor:pointer;position:relative;transition:all .12s}
input[type=checkbox]:checked{background:var(--amber);border-color:var(--amber)}
input[type=checkbox]:checked::after{content:"";position:absolute;left:6px;top:2px;width:5px;height:10px;
border:solid #110f0d;border-width:0 2.5px 2.5px 0;transform:rotate(45deg)}
.t{font-weight:600}.d{color:var(--dim);font-size:13.5px;margin-top:2px}
.n{color:var(--amber);font-size:12.5px;margin-left:8px;font-weight:500}
.badge{display:inline-block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--amber);
border:1px solid var(--amber-dim);border-radius:99px;padding:1px 9px;margin-left:8px;vertical-align:2px}
.never{border:1px dashed var(--line);border-radius:12px;padding:14px 18px;color:var(--dim);font-size:13.5px;margin-bottom:22px}
.never b{color:var(--text)}
.boxrow{margin:6px 0 16px}
.boxrow input{width:100%;background:#0c0a08;border:1px solid var(--line);border-radius:9px;color:var(--text);
padding:12px 14px;font-size:14px}
.boxrow input:focus{outline:none;border-color:var(--amber-dim)}
.connected{color:var(--ok);font-size:14px;margin:6px 0 16px}
.btns{display:flex;gap:12px;align-items:center;margin-top:6px}
button{border:0;border-radius:9px;padding:13px 22px;font:600 15px "Space Grotesk",system-ui,sans-serif;cursor:pointer}
#go{background:var(--amber);color:#161006;flex:1}
#go:hover{background:#ffb327}
#go:disabled{background:#4d4234;color:#8a7c66;cursor:default}
#save{background:none;color:var(--dim);border:1px solid var(--line)}
#save:hover{color:var(--text)}
.hint{color:var(--faint);font-size:12.5px;margin-top:14px}
#status{display:none;text-align:center;padding:46px 12px}
.bar{height:6px;background:#0c0a08;border-radius:99px;overflow:hidden;margin:26px 0 12px}
.bar i{display:block;height:100%;width:0;background:var(--amber);transition:width .3s}
#stTitle{font-size:21px;font-weight:600}
#stDetail{color:var(--dim);margin-top:10px;font-size:14.5px}
#openBox{display:none;margin-top:26px;background:var(--amber);color:#161006;text-decoration:none;
border-radius:9px;padding:13px 26px;font-weight:600;display:none}
.spin{width:26px;height:26px;border:3px solid var(--line);border-top-color:var(--amber);border-radius:50%;
margin:0 auto 22px;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
.errc{color:var(--err)}
a{color:var(--amber)}
</style></head><body><div class="wrap">
<div id="pick">
<h1>Move into your <em>ShellTeam box</em></h1>
<div class="sub">Scanned <span class="mono">__HOSTNAME__</span>. Tick what moves in. Nothing leaves this laptop until you click.</div>
<div class="card" id="sections"></div>
<div class="never">Never travels, no matter what: <b>SSH private keys</b> (your box generates fresh
ones), passwords, and cloud credential files (.aws, .npmrc, and the like). Your box's
agent lists where those live and helps you re-add only what you still need.</div>
<div id="boxarea"></div>
<div class="btns">
<button id="go">Send to my box</button>
<button id="save">Just save a file</button>
</div>
<div class="hint">Sections marked <span class="badge" style="vertical-align:0">direct only</span> contain
credentials or chat history: they upload straight to your box over TLS and are never written into a saved file.</div>
</div>
<div id="status">
<div class="spin" id="spin"></div>
<div id="stTitle"></div>
<div class="bar" id="barwrap"><i id="bar"></i></div>
<div id="stDetail"></div>
<a id="openBox" href="#">Open my box &rarr;</a>
</div>
</div>
<script>
const SUMMARY = __SUMMARY__;
const INITIAL_BOX = __BOX__;
const HAS_CRED = __HAS_CRED__;
const API = location.pathname.replace(/\\/$/, "");
const fmt = kb => kb > 1024 ? (kb/1024).toFixed(1) + "MB" : kb < 1 ? "<1KB" : kb + "KB";
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const s = SUMMARY.sections;
const DEFS = [
 {id:"packages", t:"Packages & tools", d:"brew / apt / npm / pipx / uv / cargo installs, editor extensions",
  n: plural(s.packages.files, "list"), on:true, has:s.packages.present},
 {id:"dotfiles", t:"Shell & dotfiles", d:"aliases, prompt, git config, editor and terminal setup",
  n: plural(s.dotfiles.files, "file"), on:true, has:s.dotfiles.present},
 {id:"repos", t:"Git repositories", d:"re-cloned fresh from their remotes; code never uploads",
  n: plural(s.repos.count||0, "repo"), on:true, has:s.repos.present && s.repos.count>0},
 {id:"agents", t:"Agent setup", d:"Claude Code + Codex config, skills, memory, MCP definitions",
  n: plural(s.agents.files, "file"), on:true, has:s.agents.present},
 {id:"logins", t:"Agent logins & connected MCPs", d:"skip re-login on the box: " +
   [s.logins.claude?"Claude":null, s.logins.codex?"Codex":null, s.logins.mcp?"MCP auth":null].filter(Boolean).join(" + "),
  n:"", on:true, has:s.logins.present, secure:true},
 {id:"history", t:"Chat history", d:"your Claude and Codex conversations, resumable on the box",
  n:plural(s.history.claude_files + s.history.codex_files, "session") + ", " + fmt(s.history.kb), on:true,
  has:s.history.present, secure:true},
 {id:"env", t:"Project .env files", d:"your API keys, placed back in each project. Moved over TLS, never pasted to an agent",
  n:plural((s.env&&s.env.files)||0, "file"), on:true, has:!!(s.env&&s.env.present), secure:true},
 {id:"shell-history", t:"Shell history", d:"your command history (off by default)",
  n:fmt(s["shell-history"].kb), on:false, has:s["shell-history"].present, secure:true},
];
document.getElementById("sections").innerHTML = DEFS.map(x => `
 <label class="row ${x.has?"":"off"}">
  <input type="checkbox" data-id="${x.id}" ${x.has&&x.on?"checked":""} ${x.has?"":"disabled"}>
  <span><span class="t">${x.t}</span>${x.has&&x.n?`<span class="n">${x.n}</span>`:""}${x.secure?'<span class="badge">direct only</span>':""}
  <div class="d">${x.has?x.d:"nothing found on this machine"}</div></span>
 </label>`).join("");

const boxarea = document.getElementById("boxarea");
if (INITIAL_BOX && HAS_CRED) {
  boxarea.innerHTML = `<div class="connected">&#10003; Connected to <b>${INITIAL_BOX.replace(/^https?:\\/\\//,"")}</b></div>`;
} else {
  boxarea.innerHTML = `<div class="boxrow"><input id="boxlink" placeholder="Paste your box link (from your welcome email or your box's Settings page)"
   value="${INITIAL_BOX||""}"></div>`;
}
const picked = () => [...document.querySelectorAll("input[type=checkbox]:checked")].map(c=>c.dataset.id);
const show = id => { document.getElementById("pick").style.display = id==="pick"?"":"none";
                     document.getElementById("status").style.display = id==="status"?"":"none"; };
async function poll() {
  const st = await (await fetch(API + "/api/status")).json();
  const T = document.getElementById("stTitle"), D = document.getElementById("stDetail");
  document.getElementById("bar").style.width = st.pct + "%";
  D.textContent = st.detail; D.className = "";
  if (st.phase === "packing")   T.textContent = "Packing your selection…";
  if (st.phase === "uploading") T.textContent = "Uploading to your box…";
  if (st.phase === "done" || st.phase === "saved") {
    T.textContent = st.phase === "done" ? "You're in. ✨" : "File saved";
    document.getElementById("spin").style.display = "none";
    document.getElementById("barwrap").style.display = "none";
    if (st.open_url) { const a = document.getElementById("openBox"); a.href = st.open_url; a.style.display = "inline-block"; }
    return;
  }
  if (st.phase === "error") {
    T.textContent = "That didn't work"; D.className = "errc";
    document.getElementById("spin").style.display = "none";
    document.getElementById("barwrap").style.display = "none";
    setTimeout(() => show("pick"), 6000);
    return;
  }
  setTimeout(poll, 700);
}
async function start(kind) {
  const body = { sections: picked(), kind };
  if (kind === "import") body.box = document.getElementById("boxlink")?.value || "";
  const r = await (await fetch(API + "/api/start", { method:"POST",
    headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) })).json();
  if (r.error) { alert(r.error); return; }
  show("status"); document.getElementById("spin").style.display = "";
  document.getElementById("barwrap").style.display = ""; poll();
}
document.getElementById("go").onclick = () => start("import");
document.getElementById("save").onclick = () => start("save");
</script></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the terminal clean
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == f"/{NONCE}":
            page = (PAGE
                    .replace("__HOSTNAME__", MANIFEST.get("hostname", "this machine"))
                    .replace("__SUMMARY__", json.dumps(SUMMARY))
                    .replace("__BOX__", json.dumps(INITIAL_BOX))
                    .replace("__HAS_CRED__", json.dumps(bool(INITIAL_CRED))))
            body = page.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == f"/{NONCE}/api/status":
            with STATE_LOCK:
                self._json(200, dict(STATE))
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        # The random nonce path is the CSRF boundary: no other browser origin
        # can learn it, so no web page can drive this wizard.
        if self.path != f"/{NONCE}/api/start":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length) or b"{}")
        sections = [x for x in req.get("sections", []) if x in SAFE_SECTIONS + SECURE_SECTIONS]
        if not sections:
            self._json(400, {"error": "Pick at least one section."})
            return
        if req.get("kind") == "import":
            # A box supplied on the command line is PINNED: the request body may
            # not redirect an upload carrying credentials and chat history to
            # some other host. The body's box is only consulted when the wizard
            # was started without one (the paste-your-link flow).
            try:
                box, cred = parse_box_link(INITIAL_BOX or req.get("box", ""), INITIAL_CRED)
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
                return
            if not box:
                self._json(400, {"error": "Paste your box link first (it's in your welcome email, or your box's Settings page)."})
                return
            if not cred:
                self._json(400, {"error": "That link has no credential. Copy the full import command from your box's Settings page, or paste your welcome link (it contains ?token=...)."})
                return
            threading.Thread(target=run_import, args=(sections, box, cred), daemon=True).start()
        else:
            threading.Thread(target=run_save, args=(sections,), daemon=True).start()
        self._json(200, {"ok": True})


# --- Run ---
# Everything below binds the socket, opens a browser and blocks. Everything
# above is definitions only, so tests/test_mirror_wizard.py can load the half
# above this marker and exercise the real filters (which sections may reach a
# saved file, which box URLs are allowed) without starting a server.
server = None
for port in range(8737, 8787):
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        break
    except OSError:
        continue
if server is None:
    sys.exit("no free local port between 8737 and 8787")

# flush=True throughout: stdout is often piped (curl | bash, logs) and the
# URL must be visible NOW, not when the buffer fills.
url = f"http://127.0.0.1:{server.server_address[1]}/{NONCE}/"
print(f"\nWizard running at:  {url}", flush=True)
print("(open that link if your browser doesn't pop up)\n", flush=True)

opened = False
for opener in (["wslview", url],
               ["powershell.exe", "-NoProfile", "-Command", f"Start-Process '{url}'"],
               ["xdg-open", url], ["open", url]):
    if shutil.which(opener[0]):
        try:
            subprocess.run(opener, check=True, capture_output=True, timeout=20)
            opened = True
            break
        except Exception:  # noqa: BLE001 — fall through to the next opener
            continue
if not opened:
    print("Could not open a browser automatically. Open the link above yourself.", flush=True)

threading.Thread(target=server.serve_forever, daemon=True).start()
phase, saved = "idle", ""
try:
    while True:
        time.sleep(0.5)
        with STATE_LOCK:
            phase, saved = STATE["phase"], STATE["saved"]
        if phase in ("done", "saved"):
            time.sleep(30)  # leave the success screen up, then exit clean
            break
except KeyboardInterrupt:
    pass
server.shutdown()
if phase == "done":
    print("Done. Your box is setting everything up. Open it whenever you like.", flush=True)
elif phase == "saved":
    print(f"Saved: {saved}", flush=True)
PYEOF

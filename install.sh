#!/usr/bin/env bash
#
# ShellTeam — native self-host installer (Ubuntu/Debian).
#
# Provisions dependencies, writes .env (auto-generating the HMAC secret), and
# installs + starts the systemd --user services for the cockpit. Idempotent:
# safe to re-run after pulling updates.
#
# Usage:
#   ./install.sh                 # PURE CORE (default): api + ai-chat + nginx on
#   ./install.sh --minimal       #   localhost. Cockpit agents get ZERO ShellTeam
#                                #   injection — bit-identical to hand-run CLIs.
#                                #   (--minimal is an explicit alias for the default.)
#                                # A FIRST run at a terminal asks two questions:
#                                #   how you'll access the box (localhost / Tailscale /
#                                #   free HTTPS URL / own domain) and which install
#                                #   (pure core / full harness). Non-interactive runs
#                                #   and re-runs never prompt (localhost + pure core
#                                #   unless --remote/--domain/--full say otherwise).
#   ./install.sh --full          # the full experience: persona + browser + dreaming
#   ./install.sh --no-start      # install units but don't start them
#   sudo ./install.sh --create-owner shellteam
#                                # ROOT bootstrap for fresh cloud boxes: create a
#                                #   non-root owner (passwordless sudo + linger),
#                                #   copy the repo to their home, and re-exec the
#                                #   installer as them. Any OTHER flags are
#                                #   forwarded to that run (e.g. … --remote).
#   ./install.sh --remote        # ALSO reach it from anywhere via an HTTPS URL,
#                                #   no domain needed — free wildcard DNS
#                                #   (<dashed-ip>.sslip.io) + Caddy TLS. The URL is
#                                #   gated by a strong auto-generated OWNER_TOKEN
#                                #   (a login wall, NOT open access).
#   ./install.sh --domain x.com  # same, but at your own domain (needs A + *.A
#                                #   records pointing at this box) + Caddy TLS.
#
# Modules are recorded in .env (MODULES=…); re-runs preserve them and --full
# only ADDS. Granular control (e.g. composio/linear, or dropping one module):
# edit MODULES in .env and re-run — that is the one knob.
#
# Security: a public bind has no container isolation (see SECURITY.md). For
# private remote access with no public URL at all, prefer Tailscale — see
# INSTALL.md "Giving ShellTeam a URL". --remote/--domain always set a strong
# OWNER_TOKEN, so the URL is a token-gated login wall, not open access.
#
# Designed to be run by a human OR handed to a coding agent ("install yourself").
# Run as the non-root user that will own the box — NOT as root (it uses sudo only
# for the few steps that need it). On a fresh root-only cloud box with no such user
# yet, `sudo ./install.sh --create-owner <name>` makes one and re-runs as them.

set -euo pipefail

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_ARGS=("$@")           # verbatim args, so --create-owner can re-exec the rest
CREATE_OWNER=""           # non-empty → root bootstrap: create this user, then re-exec
WITH_BROWSER=0          # v1 default: pure core — the browser container is opt-in
START_SERVICES=1
PUBLIC_MODE=none          # none | sslip | domain
PUBLIC_DOMAIN=""
REQUESTED_MODULES=""      # comma-separated modules from --full / the interactive chooser (additive)
EXPLICIT_LOCAL=0          # --minimal / --no-start = a deliberate "just the core, no questions" choice
TAILSCALE_HINT=0          # print the Tailscale next-steps at the end

add_module() {
    case ",$REQUESTED_MODULES," in
        *",$1,"*) ;;
        *) REQUESTED_MODULES="${REQUESTED_MODULES:+$REQUESTED_MODULES,}$1" ;;
    esac
}

while [ $# -gt 0 ]; do
    case "$1" in
        --minimal)       EXPLICIT_LOCAL=1 ;;   # pure core (no modules) — the default; explicit alias for clarity
        --create-owner)  shift; CREATE_OWNER="${1:-}"
                         [ -n "$CREATE_OWNER" ] || { echo "--create-owner requires a username, e.g. sudo ./install.sh --create-owner shellteam" >&2; exit 1; } ;;
        --create-owner=*) CREATE_OWNER="${1#*=}"
                         [ -n "$CREATE_OWNER" ] || { echo "--create-owner requires a username" >&2; exit 1; } ;;
        --full)          add_module persona; add_module browser; add_module dreaming; WITH_BROWSER=1 ;;
        --no-start)      START_SERVICES=0; EXPLICIT_LOCAL=1 ;;
        --remote)        PUBLIC_MODE=sslip ;;
        --public)        PUBLIC_MODE=sslip; PUBLIC_FLAG_DEPRECATED=1 ;;   # warn once helpers exist (below)
        --domain)       shift; PUBLIC_DOMAIN="${1:-}"; PUBLIC_MODE=domain
                        [ -n "$PUBLIC_DOMAIN" ] || { echo "--domain requires a value, e.g. --domain example.com" >&2; exit 1; } ;;
        --domain=*)     PUBLIC_DOMAIN="${1#*=}"; PUBLIC_MODE=domain ;;
        # Print only the contiguous header comment block (usage) — not every
        # full-line comment in the script; ORG- marker lines are noise, skip them.
        -h|--help)      awk 'NR>1 { if (!/^#/) exit; if (/^# ?ORG-/) next; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

# --public is the old name for --remote; accept it but nudge toward the new flag.
[ "${PUBLIC_FLAG_DEPRECATED:-0}" = 1 ] && warn "--public is deprecated — use --remote (identical behavior): a remote HTTPS URL gated by your OWNER_TOKEN, not open access."

# --create-owner <user>: the fresh-root-VPS bootstrap. Cloud images (DigitalOcean,
# Hetzner, OVH…) log you in as root, but ShellTeam runs as `systemd --user` under
# one non-root owner. Rather than make the operator hand-run the adduser / sudoers
# / linger / chown dance from the root-guard message below, do it here — as root,
# deliberately — and re-exec the installer as that user. Refuse-root stays the
# default for every OTHER invocation.
bootstrap_owner() {
    local user="$1" home leaf dest user_uid dest_uid fwd="" i=0 a
    printf '%s' "$user" | grep -qE '^[a-z_][a-z0-9_-]{0,31}$' \
        || die "Invalid owner username '$user' — use lowercase letters, digits, '-' and '_' (max 32 chars)."
    command -v adduser >/dev/null 2>&1 || die "--create-owner needs the 'adduser' command (Debian/Ubuntu)."
    if id "$user" >/dev/null 2>&1; then
        log "Owner user '$user' already exists — reusing it."
    else
        log "Creating owner user '$user'…"
        adduser --disabled-password --gecos "" "$user" >/dev/null || die "adduser '$user' failed."
    fi
    home="$(getent passwd "$user" | cut -d: -f6)"; home="${home:-/home/$user}"
    log "Granting '$user' passwordless sudo (/etc/sudoers.d/$user)…"
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$user" > "/etc/sudoers.d/$user"
    chmod 0440 "/etc/sudoers.d/$user"
    leaf="$(basename "$REPO")"; dest="$home/$leaf"
    if [ "$REPO" != "$dest" ]; then
        if [ -e "$dest" ]; then
            # NEVER delete or overwrite an existing destination: a repeat of this
            # bootstrap must not become a data-loss operation (it would wipe the
            # live install's .env, rotate its secrets, and destroy any owner work
            # inside the checkout). Reuse only a recognizable ShellTeam tree,
            # untouched — updates are `git pull` + re-run THERE, not a re-copy —
            # and fail closed on an unrelated collision or foreign ownership.
            [ -f "$dest/install.sh" ] && [ -f "$dest/pyproject.toml" ] \
                && [ -f "$dest/frontend/dashboard.html" ] \
                || die "$dest already exists and is not a recognizable ShellTeam checkout — move it aside, or bootstrap a different owner name."
            user_uid="$(id -u "$user")"
            dest_uid="$(stat -c '%u' "$dest")"
            [ "$dest_uid" = "$user_uid" ] \
                || die "$dest already exists but is not owned by '$user'. Refusing to chown a live checkout recursively; fix its ownership explicitly, then re-run."
            log "Existing ShellTeam checkout at $dest — reusing it untouched (nothing copied, deleted, or chown'd)."
        else
            log "Copying ShellTeam → $dest…"
            cp -a "$REPO" "$dest"
            chown -R "$user:$user" "$dest"
        fi
    else
        # Root cloned straight into the owner's home (rare). Transfer an
        # initial root-owned clone once; a re-run over the owner's live
        # checkout must be a no-op, just like the copied-checkout path.
        user_uid="$(id -u "$user")"
        dest_uid="$(stat -c '%u' "$dest")"
        if [ "$dest_uid" = "$user_uid" ]; then
            log "Existing owner checkout at $dest — leaving ownership untouched."
        elif [ "$dest_uid" = "0" ]; then
            log "Transferring the initial root-owned checkout to '$user'…"
            chown -R "$user:$user" "$dest"
        else
            die "$dest is owned by uid $dest_uid, not root or '$user'. Refusing to change a live checkout recursively."
        fi
    fi
    log "Enabling linger for '$user' (user services survive logout / start at boot)…"
    loginctl enable-linger "$user" >/dev/null 2>&1 \
        || warn "could not enable linger for '$user' — run: sudo loginctl enable-linger $user"
    # Add the owner to the docker group BEFORE the `su -` below, so the re-exec'd
    # login session inherits it. On a fresh cloud box (the case --create-owner
    # targets) Docker is very often present, and --full's Steel browser pull runs
    # `docker …` as this user — without the group that step fails with a
    # permission-denied on the daemon socket. Do it whenever a docker group exists
    # (harmless otherwise); adding it here, pre-session, avoids the classic
    # "group added but current shell doesn't have it yet" second-run.
    if getent group docker >/dev/null 2>&1; then
        log "Adding '$user' to the docker group (for the browser module's Steel container)…"
        usermod -aG docker "$user" >/dev/null 2>&1 \
            || warn "could not add '$user' to the docker group — the browser module may need: sudo usermod -aG docker $user"
    fi
    # Forward every flag EXCEPT the --create-owner pair to the real (non-root) run.
    while [ $i -lt ${#RAW_ARGS[@]} ]; do
        a="${RAW_ARGS[$i]}"
        case "$a" in
            --create-owner)   i=$((i + 1)) ;;                 # skip the flag AND its value
            --create-owner=*) ;;                              # skip (value is inline)
            *) fwd+="$(printf '%q ' "$a")" ;;
        esac
        i=$((i + 1))
    done
    log "Re-running the installer as '$user'…"
    if [ "$REPO" != "$dest" ]; then
        warn "The live install is now $dest (owned by '$user'). Edit .env and pull updates THERE — the original $REPO checkout is a stale copy."
    fi
    # `su -` starts a login session so `systemctl --user` has a runtime dir + bus.
    exec su - "$user" -c "cd $(printf '%q' "$dest") && exec ./install.sh $fwd"
}
if [ -n "$CREATE_OWNER" ]; then
    [ "$(id -u)" -eq 0 ] || die "--create-owner must be run as root (it creates the owner account): sudo ./install.sh --create-owner $CREATE_OWNER"
    bootstrap_owner "$CREATE_OWNER"   # creates the user + re-execs the installer as them, then exits
fi

# Discover this box's public IP (for sslip.io DNS + the dashboard host check).
public_ip() {
    curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null \
        || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null \
        || hostname -I | awk '{print $1}'
}
gen_token() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# Idempotent in-place set of KEY=VALUE in .env (hex token / dotted domain safe).
set_env() {
    if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
    else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}

if [ "$(id -u)" -eq 0 ]; then
    # Many cloud VPS images (DigitalOcean, OVH, Hetzner…) log you in as root by
    # default. ShellTeam runs as `systemd --user` services owned by one non-root
    # user, so it refuses root — but don't leave you stranded: show how to make
    # the owner account and re-run in one line.
    printf '\033[1;31mxx \033[0m %s\n' "Run ShellTeam as a normal (non-root) user, not root." >&2
    cat >&2 <<EOF

   ShellTeam's services run as \`systemd --user\`, owned by one non-root user.
   On a fresh root-only cloud box, let the installer create that user for you —
   it makes the account (with passwordless sudo + linger) and re-runs itself as
   them. Any other flags you pass are forwarded to that run:

     sudo ./install.sh --create-owner shellteam            # + --remote, --full, …

   (Pick any username in place of \`shellteam\`.)
EOF
    exit 1
fi
command -v sudo >/dev/null 2>&1 || die "sudo is required."
command -v systemctl >/dev/null 2>&1 || die "systemd is required (no systemctl found)."

# Package installs must never prompt: on a pristine box, tzdata's "Geographic
# area" dialog would hang the install at a real TTY (and garbage /etc/timezone
# on a piped one) — TZ=Etc/UTC gives it a valid answer outright. Exported so the
# piped NodeSource/Caddy setup scripts (run via `sudo -E`) inherit them; apt_get
# re-asserts both via `sudo env` because plain sudo's env policy may drop them.
export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC
apt_get() { sudo env DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get "$@"; }

# ── 0. First-run questions (interactive human installs only) ──────────────────
# A first run at a terminal (TTY, no --minimal/--no-start, no .env yet) gets
# asked the two things that shape the install — how the box will be reached,
# and pure core vs the full harness — instead of silently defaulting and
# burying the options in the docs. Each answer maps to an existing flag
# (--remote/--domain, --full), so non-interactive runs — CI, coding agents
# piping stdin, and every re-run (.env exists) — behave exactly as before.
# A question is skipped when its flag already answered it.
choose_access_mode() {
    printf '\n'
    log "How will you access this ShellTeam box?  (Enter = 1; details: INSTALL.md §4)"
    cat <<'EOF'
     1) Private — this machine, plus my own devices via Tailscale  (default)
     2) From anywhere via a free HTTPS URL — no domain needed  (sslip.io + Caddy)
     3) At my own domain — needs A + *.A DNS records pointing at this box
EOF
    local choice
    read -r -p "   Choice [1-3]: " choice
    case "${choice:-1}" in
        1) TAILSCALE_HINT=1
           log "Private install — reachable on this box now; the two-step Tailscale bridge for your other devices is printed at the end." ;;
        2) PUBLIC_MODE=sslip
           log "Remote mode: free wildcard HTTPS URL (sslip.io + Caddy), gated by a strong auto-generated OWNER_TOKEN." ;;
        3) read -r -p "   Your domain (A + *.A records must already point at this box), e.g. example.com: " PUBLIC_DOMAIN
           [ -n "$PUBLIC_DOMAIN" ] || die "No domain entered — re-run and enter one, or use: ./install.sh --domain example.com"
           PUBLIC_MODE=domain ;;
        *) die "Invalid choice '$choice' — re-run and pick 1-3 (or pass --remote / --domain x.com / nothing for localhost)." ;;
    esac
}
choose_install_depth() {
    printf '\n'
    log "Which install?  (Enter = 1)"
    cat <<'EOF'
     1) Pure core — cockpit + terminal + file server. Agents spawn bit-identical
        to hand-run CLIs, zero injection. (Add the harness later: ./install.sh --full)
     2) Full harness — agents that know the box: system prompt + skills (live
        URLs, HTML reports, self-verification), a shared browser they can drive
        (needs Docker), and nightly knowledge consolidation.

     Both are additive: ShellTeam never modifies your existing agent setup
     (~/.claude, ~/.codex, …). The harness is composed at launch and applies
     only to agents run THROUGH ShellTeam — a CLI you run by hand in your own
     shell behaves exactly as before, whichever you pick.
EOF
    local choice
    read -r -p "   Choice [1-2]: " choice
    case "${choice:-1}" in
        1) ;;
        2) add_module persona; add_module browser; add_module dreaming; WITH_BROWSER=1 ;;
        *) die "Invalid choice '$choice' — re-run and pick 1-2 (or pass --full / --minimal)." ;;
    esac
}
if [ -t 0 ] && [ "$EXPLICIT_LOCAL" -eq 0 ] && [ ! -f "$REPO/.env" ]; then
    [ "$PUBLIC_MODE" = none ] && choose_access_mode
    [ -z "$REQUESTED_MODULES" ] && choose_install_depth
fi

# `systemctl --user` needs THIS user's systemd instance + its D-Bus session bus.
# In a normal login session both are already up. But the standard fresh-cloud-VPS
# path — create the owner account, then `su - owner` to install (exactly what our
# root-guard message tells you to do) — has NO active session: XDG_RUNTIME_DIR is
# unset and user@UID.service isn't running, so every `systemctl --user` call dies
# with "Failed to connect to bus: No medium found". Bootstrap it once, up front:
# enable lingering (which starts user@UID.service), point the env at the runtime
# dir, and wait for the bus socket to actually appear before we rely on it.
ensure_user_bus() {
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    # Always enable lingering: it keeps user services running after logout / starts
    # them at boot, AND on a session-less install (`su - owner`) it's what brings
    # user@UID.service — and thus the bus — up in the first place.
    sudo loginctl enable-linger "$(id -un)" >/dev/null 2>&1 \
        || warn "Could not enable linger — services will stop when you log out."
    systemctl --user show-environment >/dev/null 2>&1 && return 0
    log "Waiting for your user systemd instance to come up…"
    for _ in $(seq 1 40); do
        systemctl --user show-environment >/dev/null 2>&1 && return 0
        sleep 0.25
    done
    die "Your user systemd instance never came up (no bus at $XDG_RUNTIME_DIR/bus).
   If you installed via 'su', either log in as this user directly
   (ssh $(id -un)@<host>) and re-run, or run:
       sudo loginctl enable-linger $(id -un)
   then re-run ./install.sh."
}

# ── 1. System packages ────────────────────────────────────────────────────────
# We run nginx as our own systemd --user instance (custom config, FILE_PORT).
# On a box with no nginx yet, apt's post-install hook would auto-start the
# system nginx.service and grab :80 — mask it BEFORE apt so the only nginx
# running is ours. But an nginx the operator already runs (or has enabled) is
# THEIR web server — the additive guarantee says never touch it; our file
# server simply auto-picks a free port next to it.
if systemctl is-active --quiet nginx.service 2>/dev/null \
   || systemctl is-enabled --quiet nginx.service 2>/dev/null; then
    log "Existing system nginx detected — leaving it untouched (ShellTeam runs its own --user nginx on FILE_PORT)."
else
    log "Masking system nginx.service (we run nginx as a --user instance)…"
    sudo systemctl mask nginx.service >/dev/null 2>&1 || true
fi

log "Installing system packages (apt)…"
apt_get update -qq
# build-essential: node-pty (the cockpit's terminal) ships no linux prebuilds and
# compiles from source at npm-install time — a fresh box without make/g++ dies there.
PKGS=(curl ca-certificates git nginx libcap2-bin python3 python3-venv build-essential)
apt_get install -y -qq "${PKGS[@]}"

# ── 2. Node.js (20+) ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
    log "Installing Node.js 22.x…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    apt_get install -y -qq nodejs
fi
NODE="$(command -v node)"
log "node: $NODE ($(node -v))"

# Third-party installers (uv, Antigravity) like to append PATH lines to shell
# profiles — but the additive guarantee (docs/FOOTPRINT.md) says ShellTeam never
# edits the owner's dotfiles. Their binaries land in ~/.local/bin, which the
# cockpit's rendered PATH already includes, so those edits are unnecessary here.
# Snapshot the common profile files around such an installer and restore any it
# touched — loudly, never silently.
PROFILE_FILES=("$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile"
               "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.config/fish/conf.d")
run_preserving_dotfiles() {
    local desc="$1"; shift
    local snap rc=0 i f
    snap="$(mktemp -d)"
    for i in "${!PROFILE_FILES[@]}"; do
        f="${PROFILE_FILES[$i]}"
        [ -e "$f" ] && cp -a "$f" "$snap/$i"
    done
    "$@" || rc=$?
    for i in "${!PROFILE_FILES[@]}"; do
        f="${PROFILE_FILES[$i]}"
        if [ -e "$snap/$i" ]; then
            if ! diff -rq "$snap/$i" "$f" >/dev/null 2>&1; then
                warn "$desc modified $f — restoring it (ShellTeam never edits shell dotfiles; see docs/FOOTPRINT.md)."
                rm -rf "$f" && cp -a "$snap/$i" "$f"
            fi
        elif [ -e "$f" ]; then
            warn "$desc created $f — removing it (ShellTeam never edits shell dotfiles; see docs/FOOTPRINT.md)."
            rm -rf "$f"
        fi
    done
    rm -rf "$snap"
    return $rc
}

# ── 3. uv (Python package manager) ────────────────────────────────────────────
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
    log "Installing uv…"
    # UV_NO_MODIFY_PATH: uv's installer otherwise appends to ~/.profile &
    # friends and drops a fish conf.d file. The wrapper is belt-and-suspenders.
    run_preserving_dotfiles "The uv installer" \
        sh -c 'curl -fsSL https://astral.sh/uv/install.sh | UV_NO_MODIFY_PATH=1 sh'
fi
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
[ -x "$UV" ] || die "uv install failed."
log "uv: $UV"

# ── 4. Python deps ────────────────────────────────────────────────────────────
# --frozen: install exactly the committed uv.lock — a release must be
# reproducible from its commit, so there is no live re-resolution and no
# fallback to a different dependency set. Failure is a hard stop.
log "Syncing Python dependencies (locked)…"
if ! ( cd "$REPO" && "$UV" sync --frozen 2>&1 | tee /tmp/shellteam-uv-sync.log >/dev/null ); then
    warn "uv sync --frozen failed — last lines:"
    tail -20 /tmp/shellteam-uv-sync.log >&2 || true
    die "Python dependency sync failed (full log: /tmp/shellteam-uv-sync.log). The lockfile pins the exact release set — fix the error rather than installing something else."
fi

# ── 5. ai-chat Node deps ──────────────────────────────────────────────────────
if [ -f "$REPO/computer/ai-chat/package.json" ]; then
    log "Installing ai-chat dependencies…"
    ( cd "$REPO/computer/ai-chat" && npm ci --omit=dev --no-audit --no-fund )
fi

# ── 6. Coding-agent CLIs and shared-harness tools ─────────────────────────────
log "Installing coding-agent CLIs and shared-harness tools (npm -g)…"
FAILED_TOOLS=()
# Best-effort version string for a CLI, for the install log — support questions
# almost always start with "which version of the agent CLI is this box running?".
#
# The probe runs against a DISPOSABLE home: even `--version` is side-effectful
# on some of these CLIs (codex populates CODEX_HOME, opencode initializes every
# XDG directory), and letting that hit the owner's real dotfiles would break the
# footprint guarantee that ShellTeam never writes ~/.codex, ~/.config/opencode,
# etc. Redirecting HOME plus each specific override the CLIs honor keeps the
# probe read-only from the owner's point of view.
cli_version() {
    local v tmp
    tmp="$(mktemp -d /tmp/shellteam-cliver.XXXXXX)" || { printf 'unknown'; return; }
    v="$(HOME="$tmp" CODEX_HOME="$tmp/codex" \
         XDG_CONFIG_HOME="$tmp/config" XDG_CACHE_HOME="$tmp/cache" \
         XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state" \
         "$1" --version 2>/dev/null | head -1 | tr -d '\r' \
         | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)" || v=""
    rm -rf "$tmp"
    printf '%s' "${v:-unknown}"
}

install_cli() {
    local bin="$1" pkg="$2"
    if command -v "$bin" >/dev/null 2>&1; then
        # Existing user-managed CLIs win: ShellTeam is additive and never
        # replaces them. Coding-agent CLIs are deliberately installed at
        # latest, not pinned — new models need new CLIs
        # (docs/decisions/20260719-release-qa-hardening.md).
        #
        # But "install latest" only helps a FRESH box: here the CLI predates
        # ShellTeam and may be old enough that new models 4xx. We must not
        # upgrade it (that would be mutating the user's tooling), so say how
        # — an unexplained model error is a much worse first run.
        log "  $bin already installed at $(command -v "$bin") — version $(cli_version "$bin"), leaving it untouched"
        log "    (if a model is rejected as unknown, this CLI is likely too old: sudo npm install -g $pkg@latest)"
    else
        if sudo npm install -g "$pkg" 2>&1 | tee "/tmp/shellteam-npm-$bin.log" >/dev/null; then
            log "  installed $pkg"
        else
            warn "  failed to install $pkg — last lines:"
            tail -3 "/tmp/shellteam-npm-$bin.log" >&2 || true
            FAILED_TOOLS+=("$bin ($pkg)")
        fi
    fi
}

# Antigravity is a native binary, not an npm package. Its official installer
# places `agy` in ~/.local/bin, which is already part of the cockpit service's
# rendered PATH (AGENT_PATH below). Keep this separate from install_cli so a
# fresh native box gets the CLI the registry actually launches.
install_agy() {
    if command -v agy >/dev/null 2>&1 || [ -x "$HOME/.local/bin/agy" ]; then
        log "  agy already installed"
    elif run_preserving_dotfiles "The Antigravity installer" \
            bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash >/tmp/shellteam-agy-install.log 2>&1'; then
        if [ -x "$HOME/.local/bin/agy" ]; then
            log "  installed Antigravity CLI (agy)"
        else
            warn "  Antigravity installer completed but $HOME/.local/bin/agy is missing"
            FAILED_TOOLS+=("agy (https://antigravity.google/cli/install.sh)")
        fi
    else
        warn "  failed to install Antigravity CLI — last lines:"
        tail -3 "/tmp/shellteam-agy-install.log" >&2 || true
        FAILED_TOOLS+=("agy (https://antigravity.google/cli/install.sh)")
    fi
}

# GitHub CLI — powers the 1-click GitHub connect (device flow) in onboarding /
# Settings so every coding agent pushes, pulls, and opens PRs as the owner. Not an
# npm package: try the distro repo first (recent Ubuntu universe has it), then
# GitHub's official apt repo (Debian / older Ubuntu). Non-fatal — the core stack
# runs without it; only the GitHub connect card needs it. Without this, a fresh
# box's connect flow failed with "bash: gh: command not found" (SHE-78).
install_gh() {
    if command -v gh >/dev/null 2>&1; then
        log "  gh already installed ($(command -v gh))"
        return
    fi
    log "Installing GitHub CLI (gh)…"
    if apt_get install -y -qq gh >/tmp/shellteam-gh.log 2>&1 && command -v gh >/dev/null 2>&1; then
        log "  installed gh from the distro repo"
        return
    fi
    sudo mkdir -p -m 755 /etc/apt/keyrings
    if curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
        && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
        && apt_get update -qq \
        && apt_get install -y -qq gh; then
        log "  installed gh from cli.github.com"
    else
        warn "  could not install gh — the GitHub connect card won't work until you install it (https://github.com/cli/cli#installation)."
        FAILED_TOOLS+=("gh")
    fi
}

install_cli claude   "@anthropic-ai/claude-code"
install_cli codex    "@openai/codex"
install_agy
install_cli opencode "opencode-ai"
install_gh
# The shared Context7 MCP is part of the harness every cockpit agent receives.
# Keeping the executable installed on native boxes makes the same MCP entry
# functional for Claude, Codex, Antigravity, and OpenCode.
install_cli context7-mcp "@upstash/context7-mcp"

# ── 7. .env (generate + auto-fill secret) ─────────────────────────────────────
ENV_FILE="$REPO/.env"
if [ ! -f "$ENV_FILE" ]; then
    log "Creating .env from .env.example…"
    cp "$REPO/.env.example" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

# Read one KEY= value from .env. The `|| true` is load-bearing under
# `set -euo pipefail`: grep exits 1 when the key is absent, which pipefail would
# turn into a script-killing failure of the whole command substitution — before
# any `${x:-default}` on the same line could run. So a hand-written .env missing
# a key must not abort the install; it falls through to the caller's default.
env_val() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

# systemd EnvironmentFile= does NOT strip inline comments — `KEY=   # note`
# gives the service a garbage non-empty value (silent auth failures). Strip the
# pattern from existing .env files that copied the old template.
if grep -qE '^[A-Z_]+=[[:space:]]*#' "$ENV_FILE"; then
    warn "Stripping inline comments from .env assignments (systemd would read them as values):"
    grep -E '^[A-Z_]+=[[:space:]]*#' "$ENV_FILE" | cut -d= -f1 | sed 's/^/    /' >&2
    sed -i -E 's/^([A-Z_]+=)[[:space:]]*#.*$/\1/' "$ENV_FILE"
fi

# Merge the requested modules (--full / the interactive chooser) into .env
# MODULES (additive; re-runs preserve what is already enabled — granular
# control, e.g. composio/linear or dropping a module, is editing MODULES in
# .env and re-running). The final value also drives the Steel container: a box
# whose .env says "browser" keeps getting its container re-provisioned on
# plain re-runs.
CUR_MODULES="$(env_val MODULES)"
for m in $(printf '%s' "$REQUESTED_MODULES" | tr ',' ' '); do
    case ",$CUR_MODULES," in
        *",$m,"*) ;;
        *) CUR_MODULES="${CUR_MODULES:+$CUR_MODULES,}$m" ;;
    esac
done
if [ -n "$REQUESTED_MODULES" ] || ! grep -q '^MODULES=' "$ENV_FILE"; then
    set_env MODULES "$CUR_MODULES"
fi
if [ -n "$CUR_MODULES" ]; then
    log "Modules enabled: $CUR_MODULES"
else
    log "Pure core (no modules): cockpit agents get zero ShellTeam injection."
    log "  Add the full harness anytime: ./install.sh --full"
fi
case ",$CUR_MODULES," in
    *,browser,*)
        if [ "$WITH_BROWSER" -eq 0 ]; then
            WITH_BROWSER=1; log "browser module in .env — provisioning the Steel container."
        fi ;;
esac

# Control-plane state (report/port visibility, profile) lives under
# ~/.local/state/shellteam/data by default. Migrate the owner's state if an
# older install left it at the Cloud-era default /data/users/<OWNER_ID>.
OWNER_ID_EARLY="$(env_val OWNER_ID)"; OWNER_ID_EARLY="${OWNER_ID_EARLY:-owner}"
NEW_STATE_DATA="$HOME/.local/state/shellteam/data"
if ! grep -q '^DATA_DIR=' "$ENV_FILE" \
    && [ -d "/data/users/$OWNER_ID_EARLY" ] \
    && [ ! -d "$NEW_STATE_DATA/$OWNER_ID_EARLY" ]; then
    log "Migrating control-plane state /data/users/$OWNER_ID_EARLY → $NEW_STATE_DATA (old DATA_DIR default)…"
    mkdir -p "$NEW_STATE_DATA"
    cp -a "/data/users/$OWNER_ID_EARLY" "$NEW_STATE_DATA/" \
        || warn "state migration copy failed — check /data/users/$OWNER_ID_EARLY manually"
fi
mkdir -p "$NEW_STATE_DATA"

# Auto-generate SHELLTEAM_AI_TOKEN if blank.
if ! grep -q '^SHELLTEAM_AI_TOKEN=.\+' "$ENV_FILE"; then
    TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    sed -i "s|^SHELLTEAM_AI_TOKEN=.*|SHELLTEAM_AI_TOKEN=${TOKEN}|" "$ENV_FILE"
    log "Generated SHELLTEAM_AI_TOKEN."
fi

# ── 7b. Public bind: domain + IP + strong token (optional) ────────────────────
# --public  → free wildcard DNS at <dashed-ip>.sslip.io (no domain needed).
# --domain  → your own domain (needs A + *.A records at this box).
# Either way: set APP_DOMAIN/VPS_IP, force a strong OWNER_TOKEN (the whole auth
# boundary on a public bind), and free :80/:443 for Caddy by moving the file
# server off :80. The actual Caddy install happens after services start (§12).
PUBLIC_TOKEN=""   # non-empty only when we generated one to show the human
if [ "$PUBLIC_MODE" != none ]; then
    IP="$(public_ip)"
    [ -n "$IP" ] || die "Could not determine this box's public IP (needed for a public URL)."
    if [ "$PUBLIC_MODE" = sslip ]; then
        PUBLIC_DOMAIN="${IP//./-}.sslip.io"   # dashed form = one clean DNS label
        log "No domain given — using free wildcard DNS: $PUBLIC_DOMAIN"
    else
        log "Public domain: $PUBLIC_DOMAIN (IP $IP)"
        if command -v dig >/dev/null 2>&1; then
            for h in "$PUBLIC_DOMAIN" "dnsprobe.$PUBLIC_DOMAIN"; do
                got="$(dig +short "$h" 2>/dev/null | tail -1)"
                if [ "$got" != "$IP" ]; then
                    if [ "${SKIP_DNS_CHECK:-0}" = "1" ]; then
                        warn "DNS: $h → '${got:-nothing}', expected $IP (continuing: SKIP_DNS_CHECK=1)."
                    else
                        die "DNS: $h resolves to '${got:-nothing}', expected $IP.
    Point  A $PUBLIC_DOMAIN  and  A *.$PUBLIC_DOMAIN  at $IP, wait for propagation, then re-run.
    (Caddy cannot issue a cert until DNS is right. Override with SKIP_DNS_CHECK=1 if your DNS is genuinely correct but weird.)"
                    fi
                fi
            done
        else
            warn "dig not found — skipping DNS pre-check. Ensure  A $PUBLIC_DOMAIN  and  A *.$PUBLIC_DOMAIN  point at $IP."
        fi
    fi
    set_env APP_DOMAIN "$PUBLIC_DOMAIN"
    set_env VPS_IP "$IP"
    # Caddy owns :80/:443 on a public bind — keep the file server off :80.
    CUR_FILE_PORT="$(env_val FILE_PORT)"
    if [ "${CUR_FILE_PORT:-80}" -lt 1024 ]; then
        set_env FILE_PORT 8080
        log "Moved file server to FILE_PORT=8080 so Caddy can bind :80/:443."
    fi
    # OWNER_TOKEN is the whole auth boundary on a public bind, so it MUST be
    # strong. Keep an existing token only if it clears a length floor (the
    # 64-hex token gen_token produces always does, so re-running --public is
    # idempotent); otherwise — including a short/memorable one set while
    # experimenting locally — regenerate so we never expose the box with a weak
    # secret. Override with KEEP_WEAK_TOKEN=1 if you really mean to.
    CUR_TOKEN="$(env_val OWNER_TOKEN)"
    if [ "${#CUR_TOKEN}" -ge 32 ]; then
        log "Keeping existing strong OWNER_TOKEN (${#CUR_TOKEN} chars)."
    elif [ -n "$CUR_TOKEN" ] && [ "${KEEP_WEAK_TOKEN:-0}" = "1" ]; then
        warn "Keeping a weak OWNER_TOKEN (${#CUR_TOKEN} chars) because KEEP_WEAK_TOKEN=1 — this box is only as safe as that token."
    else
        [ -n "$CUR_TOKEN" ] && warn "Existing OWNER_TOKEN is weak (${#CUR_TOKEN} chars) — regenerating a strong one for the public bind (set KEEP_WEAK_TOKEN=1 to keep it)."
        PUBLIC_TOKEN="$(gen_token)"
        set_env OWNER_TOKEN "$PUBLIC_TOKEN"
        log "Generated a strong OWNER_TOKEN for the public bind."
    fi
fi

# ── 7c. Fit alongside whatever else the box already runs ──────────────────────
# ShellTeam is an additive layer, not a landgrab. If a default loopback port is
# already taken (a production app on :8000, a site on :80, …), move OUR service
# to the next free port and record it in .env — never fight for a port or make
# the operator hand-edit config to install. A port that's free, or already served
# by our own unit (an idempotent re-run), is left untouched. The re-run check
# needs the user bus, so bring it up first (idempotent; the systemd step re-uses
# it). Caddy's :80/:443 are handled separately in §12, not here.
ensure_user_bus
port_in_use() { ss -ltn "( sport = :$1 )" 2>/dev/null | grep -q LISTEN; }
autopick_port() {  # autopick_port ENV_KEY DEFAULT OUR_UNIT
    local key="$1" def="$2" unit="$3" cur next
    cur="$(env_val "$key")"; cur="${cur:-$def}"
    if ! port_in_use "$cur" || systemctl --user is-active --quiet "$unit" 2>/dev/null; then
        return
    fi
    # Relocating off a PRIVILEGED default (e.g. FILE_PORT :80)? Jump straight to
    # unprivileged space (>=1024) instead of probing :81, :82, … — a neighbouring
    # privileged port is just as likely contested AND would still need a setcap
    # grant (defeating the point of moving). Mirrors the API's 8000→8003 landing.
    if [ "$cur" -lt 1024 ]; then next=8080; else next=$((cur + 1)); fi
    while port_in_use "$next"; do next=$((next + 1)); done
    set_env "$key" "$next"
    warn "Port :$cur is already in use — moving $key to :$next (override in $ENV_FILE)."
}
autopick_port API_PORT     8000 shellteam-api
autopick_port AI_CHAT_PORT 3456 shellteam-ai-chat
autopick_port FILE_PORT    80   shellteam-nginx

# ── 8. nginx: allow bind to the file-server port ──────────────────────────────
# Read FILE_PORT from .env (default 80). A privileged port (<1024) needs the
# cap_net_bind_service capability for a --user unit to bind it; an unprivileged
# port (>=1024) does not, so we skip setcap and avoid a needless sudo.
# On Debian, nginx lands in /usr/sbin which is NOT in a normal user's PATH
# (Ubuntu puts sbin on PATH) — a bare `command -v nginx` comes back empty and,
# under `set -e`, killed the install here with no message at all.
NGINX="$(command -v nginx || true)"
if [ -z "$NGINX" ]; then
    for cand in /usr/sbin/nginx /usr/local/sbin/nginx /sbin/nginx; do
        [ -x "$cand" ] && NGINX="$cand" && break
    done
fi
[ -n "$NGINX" ] || die "nginx binary not found after apt install (looked in PATH and /usr/sbin) — check the apt step above."
FILE_PORT="$(env_val FILE_PORT)"; FILE_PORT="${FILE_PORT:-80}"
if [ "$FILE_PORT" -lt 1024 ]; then
    log "Granting nginx cap_net_bind_service (bind privileged port :$FILE_PORT as your user)…"
    sudo setcap cap_net_bind_service=+ep "$(readlink -f "$NGINX")" || \
        warn "setcap failed — the file server may not bind :$FILE_PORT as a --user service."
else
    log "FILE_PORT=$FILE_PORT is unprivileged (>=1024) — no setcap needed."
fi
MIME="/etc/nginx/mime.types"

# ── 9. State dirs ─────────────────────────────────────────────────────────────
STATE="$HOME/.local/state/shellteam"
mkdir -p "$STATE"/{body,proxy,fastcgi,uwsgi,scgi} "$HOME/public"

# ── 10. Render configs + systemd units ────────────────────────────────────────
# systemd Environment= does not expand ${}, so values that the ai-chat unit
# injects are read from .env here (via the env_val helper defined above) and
# substituted literally.
OWNER_USERNAME_V="$(env_val OWNER_USERNAME)"; OWNER_USERNAME_V="${OWNER_USERNAME_V:-owner}"
OWNER_ID_V="$(env_val OWNER_ID)"; OWNER_ID_V="${OWNER_ID_V:-owner}"
AI_CHAT_PORT_V="$(env_val AI_CHAT_PORT)"; AI_CHAT_PORT_V="${AI_CHAT_PORT_V:-3456}"
# PATH for the cockpit unit. systemd --user gives services a bare PATH that omits
# ~/.local/bin (claude, codex, …), so spawning agents fails with ENOENT. Bake in
# ~/.local/bin, the resolved node dir, and the installer's own PATH (where the
# user actually has their tools). Dedup is unnecessary — PATH tolerates repeats.
AGENT_PATH="$HOME/.local/bin:$(dirname "$NODE"):$PATH"

render() { # render <src> <dst>
    sed -e "s|@REPO@|$REPO|g" \
        -e "s|@UV@|$UV|g" \
        -e "s|@NODE@|$NODE|g" \
        -e "s|@NGINX@|$NGINX|g" \
        -e "s|@HOME@|$HOME|g" \
        -e "s|@STATE@|$STATE|g" \
        -e "s|@MIME@|$MIME|g" \
        -e "s|@FILE_PORT@|$FILE_PORT|g" \
        -e "s|@OWNER_USERNAME@|$OWNER_USERNAME_V|g" \
        -e "s|@OWNER_ID@|$OWNER_ID_V|g" \
        -e "s|@AI_CHAT_PORT@|$AI_CHAT_PORT_V|g" \
        -e "s|@AGENT_PATH@|$AGENT_PATH|g" \
        "$1" > "$2"
}

log "Rendering nginx config…"
render "$REPO/deploy/nginx/shellteam.conf" "$STATE/nginx.conf"

# Stage the Monaco file-editor SPA where nginx serves it (the /_editor/ location
# aliases $STATE/file-editor/). Native equivalent of the Docker COPY to
# /opt/file-editor; refreshed on every install so editor updates ship.
log "Staging file editor…"
install -D -m 0644 "$REPO/computer/file-editor.html" "$STATE/file-editor/index.html"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
UNITS=(shellteam-api shellteam-ai-chat shellteam-nginx)

# nginx unit must point at the *rendered* config in $STATE, not the template.
# Make sure `systemctl --user` can reach this user's bus before we use it —
# critical when installing on a freshly-created user via `su` (no login session).
ensure_user_bus

log "Installing systemd --user units…"
for u in "${UNITS[@]}"; do
    render "$REPO/deploy/systemd/$u.service" "$UNIT_DIR/$u.service"
done
# Repoint the nginx unit at the rendered config.
sed -i "s|$REPO/deploy/nginx/shellteam.conf|$STATE/nginx.conf|g" "$UNIT_DIR/shellteam-nginx.service"

# Self-update timer: always installed (unlike the module-gated dreaming timer)
# because AUTO_UPDATE is core config, not a module — the service reads
# AUTO_UPDATE from .env on every tick and exits instantly when it's off, so the
# Settings toggle works without any systemctl choreography.
render "$REPO/deploy/systemd/shellteam-update.service" "$UNIT_DIR/shellteam-update.service"
render "$REPO/deploy/systemd/shellteam-update.timer"   "$UNIT_DIR/shellteam-update.timer"

# Dreaming module: the nightly sweep is a oneshot service + timer, installed and
# enabled ONLY when the module is on — and torn down when it isn't, so dropping
# the module from .env fully retires the schedule on the next install run.
case ",$CUR_MODULES," in
    *,dreaming,*)
        log "Installing dreaming timer (nightly knowledge sweep at 03:30)…"
        render "$REPO/deploy/systemd/shellteam-dream.service" "$UNIT_DIR/shellteam-dream.service"
        render "$REPO/deploy/systemd/shellteam-dream.timer"   "$UNIT_DIR/shellteam-dream.timer"
        ;;
    *)
        if [ -f "$UNIT_DIR/shellteam-dream.timer" ]; then
            log "dreaming module not enabled — removing its timer."
            systemctl --user disable --now shellteam-dream.timer >/dev/null 2>&1 || true
            rm -f "$UNIT_DIR/shellteam-dream.timer" "$UNIT_DIR/shellteam-dream.service"
        fi
        ;;
esac

# Linger is already enabled by ensure_user_bus above (so user services keep
# running after logout / start at boot), and the bus is confirmed reachable.
systemctl --user daemon-reload
for u in "${UNITS[@]}"; do
    systemctl --user enable "$u" >/dev/null 2>&1 || true
done
# --no-start must hold for the timers too: enable always, start only with the rest.
UPDATE_NOW=""; [ "$START_SERVICES" -eq 1 ] && UPDATE_NOW="--now"
systemctl --user enable $UPDATE_NOW shellteam-update.timer >/dev/null 2>&1 || \
    warn "could not enable shellteam-update.timer"
case ",$CUR_MODULES," in
    *,dreaming,*)
        DREAM_NOW=""; [ "$START_SERVICES" -eq 1 ] && DREAM_NOW="--now"
        systemctl --user enable $DREAM_NOW shellteam-dream.timer >/dev/null 2>&1 || \
            warn "could not enable shellteam-dream.timer"
        ;;
esac

# Build ShellTeam's additive agent layer (skills/hooks/MCP/persona under
# ~/.shellteam) so the cockpit has it before the first chat. This NEVER touches
# the user's coding-agent dotfiles — see docs/design/vps-footprint.md.
log "Building agent layer…"
# shellcheck source=/dev/null
( cd "$REPO" && set -a && . "$ENV_FILE" && set +a && \
  "$UV" run python -c "from api.config import OWNER_USERNAME, OWNER_EMAIL; from api.services import processes; processes._materialize_config(OWNER_USERNAME, OWNER_EMAIL)" ) \
  || warn "agent-layer build failed — it will be built on first dashboard load."

# sed, not grep: grep exits 1 when .env carries no API_PORT line (a hand-written
# minimal .env — the Cloud cloud-init path), and under set -e that killed the
# whole install silently, right here, before any service existed.
API_PORT="$(sed -n 's/^API_PORT=//p' "$ENV_FILE" | tail -1 | tr -d '[:space:]')"; API_PORT="${API_PORT:-8000}"

# A port already bound by something that is NOT our own unit means the service
# will crash on boot — and systemd Type=simple would still report "started".
# Catch it before starting instead of shipping a dead stack.
preflight_ports() {
    local label port unit clash=0
    for spec in "api:$API_PORT:shellteam-api" "cockpit:$AI_CHAT_PORT_V:shellteam-ai-chat" "files:$FILE_PORT:shellteam-nginx"; do
        label="${spec%%:*}"; port="$(echo "$spec" | cut -d: -f2)"; unit="${spec##*:}"
        if ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then
            # Bound by our own unit (re-run) is fine — restart handles it.
            if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
                continue
            fi
            warn "Port :$port ($label) is already in use by something that isn't $unit:"
            ss -ltnp "( sport = :$port )" 2>/dev/null | sed 's/^/    /' >&2 || true
            clash=1
        fi
    done
    [ "$clash" -eq 0 ] || die "Free the port(s) above or change API_PORT/AI_CHAT_PORT/FILE_PORT in $ENV_FILE, then re-run."
}

# The real "did it work": services are Type=simple, so systemctl restart
# succeeds even when the process crashes on boot. Probe each service and fail
# loudly with its journal tail instead of printing a success banner over a
# dead stack.
verify_stack() {
    local ok=1
    log "Verifying services…"
    if ! curl -fsS --retry 10 --retry-delay 1 --retry-all-errors --max-time 3 \
            "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
        warn "API did not answer on :${API_PORT}/health. Last log lines:"
        journalctl --user -u shellteam-api -n 15 --no-pager >&2 || true
        ok=0
    fi
    # Any HTTP response (even 401 from the auth gate) proves the service is up —
    # only a connection failure means it's dead. So no -f here.
    if ! curl -sS --retry 10 --retry-delay 1 --retry-connrefused --max-time 3 \
            -o /dev/null "http://127.0.0.1:${AI_CHAT_PORT_V}/" 2>/dev/null; then
        warn "Cockpit (ai-chat) did not answer on :${AI_CHAT_PORT_V}. Last log lines:"
        journalctl --user -u shellteam-ai-chat -n 15 --no-pager >&2 || true
        ok=0
    fi
    if ! curl -sS --retry 5 --retry-delay 1 --retry-connrefused --max-time 3 \
            -o /dev/null "http://127.0.0.1:${FILE_PORT}/" 2>/dev/null; then
        warn "File server (nginx) did not answer on :${FILE_PORT}. Last log lines:"
        journalctl --user -u shellteam-nginx -n 15 --no-pager >&2 || true
        ok=0
    fi
    [ "$ok" -eq 1 ] || die "One or more services failed to come up — see the log excerpts above. Fix and re-run."
    log "All services verified (api :${API_PORT}, cockpit :${AI_CHAT_PORT_V}, files :${FILE_PORT})."
}

if [ "$START_SERVICES" -eq 1 ]; then
    preflight_ports
    log "Starting services…"
    for u in "${UNITS[@]}"; do
        systemctl --user restart "$u" || warn "failed to start $u"
    done
    verify_stack
fi

# ── 11b. Browser (Steel + Chromium) — provisioned when the browser module is on ─
# The browser MCP and the dashboard's Browser tab talk to Steel's CDP/screencast
# on 127.0.0.1:3000 (the subdomain proxy forwards <user>-3000.<domain> there). The
# core stack is Docker-free, but Steel ships as a turnkey image bundling its own
# pinned Chromium — building it natively is impractical — so the optional browser
# runs as a loopback-only container. Idempotent: re-creates the container each run.
# Pinned by digest: `:latest` is mutable, and a release must provision the same
# (tested) browser runtime every time. Bump deliberately: pull the new digest,
# run the session-launch QA below against it, then update this pin. (The
# 2026-07 upstream index sha256:1c988dc8… passes /v1/health but cannot launch
# Chromium — exactly why bumps must be QA'd, not taken from `:latest`.)
STEEL_IMAGE="ghcr.io/steel-dev/steel-browser:latest@sha256:995a31d75d3270bc27db3bee788107af78d3378a61f9e162c2813860c21884c9"
STEEL_CONTAINER="shellteam-steel"
provision_browser() {
    if ! command -v docker >/dev/null 2>&1; then
        warn "Browser tab needs Docker (Steel ships as a container) — Docker not found, skipping."
        warn "  Install Docker and re-run, or remove 'browser' from MODULES in .env to silence this. Rest of the stack is unaffected."
        return
    fi
    log "Pulling the pinned Steel browser image (first run downloads ~2 GB; allow ~6 GB free disk)…"
    # The browser is an optional module — a Docker hiccup (daemon down, no
    # docker-group membership) must never abort an install whose core stack
    # is already up. warn + skip, never die.
    if ! docker pull -q "$STEEL_IMAGE" >/dev/null; then
        warn "Failed to pull $STEEL_IMAGE (is the Docker daemon running & are you in the docker group?)."
        warn "  Browser tab skipped — rest of the stack is unaffected. Fix Docker and re-run, or remove 'browser' from MODULES in .env."
        return
    fi
    docker rm -f "$STEEL_CONTAINER" >/dev/null 2>&1 || true
    log "Starting Steel browser container (loopback 127.0.0.1:3000)…"
    if ! docker run -d --name "$STEEL_CONTAINER" --restart unless-stopped \
        --shm-size=1g -p 127.0.0.1:3000:3000 "$STEEL_IMAGE" >/dev/null; then
        warn "Failed to start $STEEL_CONTAINER — browser tab skipped. Check 'docker logs $STEEL_CONTAINER'."
        return
    fi
    # /v1/health can return 200 while Chromium itself cannot launch (verified on
    # a real upstream image) — certify readiness with a real browser session,
    # retried inside the warm-up window, then release it.
    local response session_id
    for _ in $(seq 1 45); do
        if curl -fsS --max-time 3 http://127.0.0.1:3000/v1/health >/dev/null 2>&1; then
            response="$(curl -fsS --max-time 30 -X POST \
                -H 'Content-Type: application/json' -d '{}' \
                http://127.0.0.1:3000/v1/sessions 2>/dev/null || true)"
            session_id="$(printf '%s' "$response" | python3 -c \
                'import json,sys; print(json.load(sys.stdin).get("id", ""))' 2>/dev/null || true)"
            if [ -n "$session_id" ]; then
                curl -fsS --max-time 10 -X POST http://127.0.0.1:3000/v1/sessions/release \
                    -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
                log "  Steel is up on :3000 (Chromium session launch verified)"
                return
            fi
        fi
        sleep 1
    done
    warn "Steel started but could not launch a Chromium session — the Browser tab will not work. Container logs:"
    docker logs --tail 30 "$STEEL_CONTAINER" >&2 || true
    warn "Removing the broken container. Fix the cause (see logs above) and re-run the installer, or remove 'browser' from MODULES in .env."
    docker rm -f "$STEEL_CONTAINER" >/dev/null 2>&1 || true
}
if [ "$WITH_BROWSER" -eq 1 ]; then
    if [ "$START_SERVICES" -eq 1 ]; then
        provision_browser
    else
        # --no-start means NOTHING starts — including the Steel container.
        log "--no-start: skipping Steel browser provisioning (re-run without --no-start to start it)."
    fi
fi

# ── 12. Caddy (public bind only) ──────────────────────────────────────────────
# Caddy terminates TLS on :80/:443 and reverse-proxies to the control plane on
# :API_PORT (which serves the dashboard, cockpit, and subdomain proxy). on-demand
# TLS mints a per-host Let's Encrypt cert on first request — no DNS-API token and
# no wildcard cert needed. Idempotent: re-renders + reloads on every run.
install_caddy() {
    if command -v caddy >/dev/null 2>&1; then log "caddy already installed"; return; fi
    log "Installing Caddy (official apt repo)…"
    apt_get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt_get update -qq && apt_get install -y -qq caddy
}
# Refuse to bind :80/:443 out from under an existing web server / reverse proxy.
# ShellTeam won't fight a production stack for those ports — the operator should
# put ShellTeam behind their own proxy instead (it stays on 127.0.0.1:API_PORT).
preflight_tls_ports() {
    local p held=0
    for p in 80 443; do
        if port_in_use "$p" && ! systemctl is-active --quiet caddy 2>/dev/null; then
            warn "Port :$p (needed for TLS) is already in use by:"
            ss -ltnp "( sport = :$p )" 2>/dev/null | sed 's/^/    /' >&2 || true
            held=1
        fi
    done
    [ "$held" -eq 0 ] || die "Something other than Caddy already serves :80/:443 (your own
   web server or reverse proxy?). ShellTeam won't take those ports from it.
   Install WITHOUT --remote/--domain — ShellTeam stays on 127.0.0.1:${API_PORT} —
   then put it behind your existing proxy: INSTALL.md §4.5 has the exact vhost
   config and the OWNER_TOKEN step (required — do not skip it)."
}
# The caddy .deb ships /etc/caddy/Caddyfile as a dpkg conffile and records the
# original's md5 — so "still the packaged default, never edited" is provable.
# Without this, ShellTeam's own `apt install caddy` plants a default Caddyfile
# that the operator-config guard below then refuses to touch: a fresh cloud box
# could never complete a --domain/--remote install.
caddyfile_is_pristine_default() {
    local cf="$1" recorded actual
    recorded="$(dpkg-query -W -f='${Conffiles}\n' caddy 2>/dev/null \
        | awk -v f="$cf" '$1 == f {print $2}')"
    [ -n "$recorded" ] || return 1
    actual="$(md5sum "$cf" 2>/dev/null | awk '{print $1}')"
    [ "$actual" = "$recorded" ]
}
configure_caddy() {
    local domain="$1" cf="/etc/caddy/Caddyfile"
    # NEVER clobber an operator's own Caddyfile — overwriting it could take their
    # site down. Only a file we wrote (carrying the ShellTeam-managed marker) or
    # the never-edited package default is safe to regenerate; anything else is
    # backed up and we stop with guidance.
    if [ -f "$cf" ] && ! grep -q "ShellTeam-managed" "$cf" 2>/dev/null \
        && ! caddyfile_is_pristine_default "$cf"; then
        local backup
        backup="$cf.pre-shellteam.$(date +%Y%m%d%H%M%S)"
        sudo cp -a "$cf" "$backup"
        die "Refusing to overwrite the existing /etc/caddy/Caddyfile — it isn't
   ShellTeam-managed, so it's almost certainly your own site config, and
   replacing it would take that site down. (Backed it up to $backup.)
   Put ShellTeam behind your Caddy instead: add a site block that reverse-proxies
   your hostname to 127.0.0.1:${API_PORT}, and install without --remote.
   Or move the file aside and re-run to let ShellTeam manage Caddy."
    fi
    log "Rendering /etc/caddy/Caddyfile for $domain → 127.0.0.1:${API_PORT}…"
    sed -e "s/example\.com/${domain}/g" \
        -e "s|127.0.0.1:8000|127.0.0.1:${API_PORT}|g" \
        "$REPO/Caddyfile.example" | sudo tee /etc/caddy/Caddyfile >/dev/null
    sudo caddy validate --config /etc/caddy/Caddyfile || die "Caddyfile failed validation."
    sudo systemctl enable --now caddy >/dev/null 2>&1 || true
    sudo systemctl restart caddy
    log "Caddy reloaded (TLS on :80/:443)."
}
PUBLIC_URL_VERIFIED=0
verify_public_url() {
    local domain="$1"
    log "Verifying https://$domain (cert issuance can take up to ~60s on first run)…"
    for i in $(seq 1 12); do
        if curl -fsS --max-time 5 "https://$domain/health" >/dev/null 2>&1; then
            PUBLIC_URL_VERIFIED=1
            log "  https://$domain answers."
            return
        fi
        sleep 5
    done
    warn "https://$domain did not answer within 60s. Common causes:"
    warn "  - ports 80/443 blocked by the cloud provider's firewall / security group"
    warn "  - DNS not propagated yet (re-run in a few minutes)"
    warn "  Check:  sudo journalctl -u caddy -n 30 --no-pager"
}

if [ "$PUBLIC_MODE" != none ] && [ "$START_SERVICES" -eq 1 ]; then
    preflight_tls_ports
    install_caddy
    configure_caddy "$PUBLIC_DOMAIN"
    verify_public_url "$PUBLIC_DOMAIN"
fi

cat <<EOF

$(log "ShellTeam installed.")
  Dashboard (local):    http://127.0.0.1:${API_PORT}   (tabbed shell; the Agents tab is the ai-chat cockpit on :${AI_CHAT_PORT_V})
  Web terminal:         http://127.0.0.1:${API_PORT}/terminal
  File server (nginx):  http://127.0.0.1:${FILE_PORT}   (serves \$HOME; change via FILE_PORT in .env)
  Edit settings:        $ENV_FILE   (add your LLM keys, then: systemctl --user restart shellteam-api shellteam-ai-chat)
  Logs:                 journalctl --user -u shellteam-ai-chat -f
EOF

# The most common first run is "SSH'd into a fresh VPS, picked localhost":
# a 127.0.0.1 URL is unreachable from the laptop, so say how to bridge it.
if [ "$PUBLIC_MODE" = none ] && [ "$TAILSCALE_HINT" -eq 0 ]; then
cat <<EOF
  Remote box?           These URLs work only on this machine. From your laptop:
                          ssh -N -L ${API_PORT}:127.0.0.1:${API_PORT} $(id -un)@<this-box>
                        then open http://127.0.0.1:${API_PORT} — or re-run
                        ./install.sh --remote for a real HTTPS URL.
EOF
fi

if [ "$PUBLIC_MODE" != none ] && [ "$START_SERVICES" -eq 1 ] && [ "$PUBLIC_URL_VERIFIED" -eq 1 ]; then
cat <<EOF

$(log "Remote URL is live (HTTPS via Caddy — verified). It's a token-gated login wall, not open access.")
  URL:                  https://${PUBLIC_DOMAIN}
  Owner subdomains:     https://${OWNER_USERNAME_V}.${PUBLIC_DOMAIN}  (files)  ·  https://${OWNER_USERNAME_V}-<port>.${PUBLIC_DOMAIN}  (apps)
EOF
    if [ -n "$PUBLIC_TOKEN" ]; then
        # Only echo the raw token to an interactive terminal. When stdout isn't a
        # TTY (piped, a coding-agent runner, CI), printing it would persist the
        # sole public-auth credential in transcripts/logs/scrollback — point at
        # the 0600 .env instead (M6).
        if [ -t 1 ]; then
            echo "  OWNER_TOKEN:          ${PUBLIC_TOKEN}"
            echo "                        ^ SAVE THIS — it's required to log in (also in $ENV_FILE)."
        else
            echo "  OWNER_TOKEN:          (newly generated — see $ENV_FILE; not printed to a non-interactive stdout)"
        fi
    else
        echo "  OWNER_TOKEN:          (kept your existing value in $ENV_FILE)"
    fi
    if [ "$PUBLIC_MODE" = sslip ]; then
        echo "  Note: <ip>.sslip.io is free public DNS. If a cert is rate-limited, swap"
        echo "        sslip.io→nip.io in .env APP_DOMAIN + the Caddyfile, then re-run."
    fi
    echo "  Safer option: for private access without exposing the box, use Tailscale —"
    echo "        see INSTALL.md \"Giving ShellTeam a URL\"."
elif [ "$PUBLIC_MODE" != none ] && [ "$START_SERVICES" -eq 1 ]; then
cat <<EOF

$(warn "Remote URL is configured but NOT yet reachable (see the verification warnings above).")
  Once DNS/firewall are fixed:  curl https://${PUBLIC_DOMAIN}/health   should return {"status":"ok"}
  Your OWNER_TOKEN is in $ENV_FILE${PUBLIC_TOKEN:+ (newly generated — save it)}.
EOF
elif [ "$PUBLIC_MODE" != none ]; then
cat <<EOF

$(log "Remote config written to .env, but NOT started (--no-start).")
  APP_DOMAIN=${PUBLIC_DOMAIN} and a strong OWNER_TOKEN are set, but Caddy was not
  installed/configured and services are not running, so HTTPS is NOT live yet.
  Re-run without --no-start to bring it up:  ./install.sh $([ "$PUBLIC_MODE" = sslip ] && echo --remote || echo "--domain ${PUBLIC_DOMAIN}")
EOF
fi

if [ "$TAILSCALE_HINT" -eq 1 ]; then
cat <<EOF

$(log "Reaching it from your other devices — recommended: Tailscale (stays private). Two steps:")
  1. Put the box on your tailnet:
       curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
  2. Bridge the dashboard + cockpit ports onto the tailnet and register the IP —
     copy-paste block in INSTALL.md §4.1 ("Tailscale — private, recommended").
  Then open  http://<tailnet-ip>:${API_PORT}  from any of your devices.
  (Quick one-off from a laptop instead:  ssh -N -L ${API_PORT}:127.0.0.1:${API_PORT} $(id -un)@<this-box>)
EOF
fi

if [ "${#FAILED_TOOLS[@]}" -gt 0 ]; then
    warn "These coding-agent CLIs or harness tools FAILED to install: ${FAILED_TOOLS[*]}"
    warn "  The cockpit can't use them until you install them manually (sudo npm install -g <pkg>)."
fi

# Signing in to the agents is the LAST step, and the recommended path is a
# subscription login from the dashboard — NOT an API key. So we never frame the
# box as broken for lacking a key: if a subscription/key is already present we
# confirm it, otherwise we point at the dashboard sign-in (keys stay optional).
has_llm_auth() {
    for k in ANTHROPIC_API_KEY OPENAI_API_KEY FIREWORKS_API_KEY; do
        [ -n "$(env_val "$k")" ] && return 0
    done
    # Subscription (OAuth) logins count too — the preferred mode.
    [ -f "$HOME/.claude/.credentials.json" ] && return 0
    [ -f "$HOME/.codex/auth.json" ] && return 0
    return 1
}
if has_llm_auth; then
    echo
    echo "LLM credentials detected — open the dashboard and start chatting."
else
    echo
    echo "Next: open the dashboard → Settings and sign in with your Claude or Codex"
    echo "subscription (the recommended way to run the agents — no API key needed)."
    echo "  Prefer API keys? They're optional — handy for headless/CI. Add"
    echo "  ANTHROPIC_API_KEY / OPENAI_API_KEY / FIREWORKS_API_KEY to $ENV_FILE, then:"
    echo "    systemctl --user restart shellteam-api shellteam-ai-chat"
fi

#!/usr/bin/env bash
#
# ShellTeam — native uninstaller. Removes everything install.sh added to this box,
# scoped to ShellTeam's own footprint. It does NOT touch anything you did *through*
# ShellTeam (your files, repos, deploys) — that's yours.
#
# Usage:
#   ./uninstall.sh            # remove ShellTeam's services, state, and browser
#   ./uninstall.sh --purge    # ALSO remove ~/.shellteam (incl. your knowledge layer)
#                             #   and stop keeping user services alive after logout
#
# What it removes:
#   - the three systemd --user units (api, ai-chat, nginx)
#   - the runtime state dir (~/.local/state/shellteam) and the agent layer
#   - the Steel browser container and its ~1.5 GB image
#   - the nginx cap_net_bind_service capability (when install.sh granted it)
#   - unmasks the system nginx.service that install.sh masked
#
# What it deliberately leaves (tier-3, shared, or yours — see docs/FOOTPRINT.md):
#   - apt packages (nginx, nodejs) and the global coding-agent CLIs
#   - Caddy and /etc/caddy/Caddyfile (a shared reverse proxy)
#   - the repo + its .env (your config/secrets)
#   - your coding-agent dotfiles (~/.claude, ~/.codex, … — ShellTeam never owned them)
#   - ~/.shellteam/knowledge (your accumulated memory) unless --purge

set -euo pipefail

PURGE=0
case "${1:-}" in
    "")          ;;
    --purge)     PURGE=1 ;;
    -h|--help)   awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    # Anything else must NOT fall through to a destructive uninstall.
    *)           echo "Unknown option: $1 (use --purge, or no arguments; --help for details)" >&2; exit 1 ;;
esac

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

UNIT_DIR="$HOME/.config/systemd/user"
STATE="$HOME/.local/state/shellteam"
UNITS=(shellteam-api shellteam-ai-chat shellteam-nginx)
STEEL_CONTAINER="shellteam-steel"

# `systemctl --user` needs this user's systemd bus. A noninteractive login
# (cron, `su` without a session) has no XDG_RUNTIME_DIR, and every systemctl
# call dies with "Failed to connect to bus" — which the old blanket `|| true`
# swallowed, so the script deleted unit files and state while every service
# kept running, then printed "ShellTeam removed." Fail CLOSED instead: nothing
# is deleted unless we can actually stop the services and prove they stopped.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user show-environment >/dev/null 2>&1 \
    || die "Cannot reach your user systemd instance (no bus at \$XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR).
   Uninstalling now would delete unit files while the services keep running.
   Log in as this user directly (ssh $(id -un)@<host>) and re-run ./uninstall.sh."

# is-active without set -e tripping; distinguishes "running" from gone/failed.
unit_state() { systemctl --user is-active "$1" 2>/dev/null || true; }

log "Stopping systemd --user units…"
systemctl --user disable --now shellteam-dream.timer >/dev/null 2>&1 || true
systemctl --user disable --now shellteam-update.timer >/dev/null 2>&1 || true
# The timers' oneshots may be mid-run right now — stop them too, or they keep
# working (writing knowledge / restarting services) after the uninstall.
systemctl --user stop shellteam-dream.service >/dev/null 2>&1 || true
systemctl --user stop shellteam-update.service >/dev/null 2>&1 || true
for u in "${UNITS[@]}"; do
    # stop errors only for reasons we must not ignore (bus loss mid-run); a
    # unit that was never installed reports inactive below and passes.
    if ! systemctl --user stop "$u" >/dev/null 2>&1; then
        if [ "$(unit_state "$u")" = "active" ]; then
            die "Could not stop $u and it is still active — aborting before deleting anything."
        fi
    fi
    systemctl --user disable "$u" >/dev/null 2>&1 || true
done

# Prove every unit is down BEFORE removing any file. Deleting unit files out
# from under live processes leaves orphans systemd can no longer manage.
for u in "${UNITS[@]}" shellteam-dream.timer shellteam-dream.service shellteam-update.timer shellteam-update.service; do
    state="$(unit_state "$u")"
    if [ "$state" = "active" ] || [ "$state" = "activating" ]; then
        die "$u is still $state after stop — aborting before deleting anything."
    fi
done
log "All units stopped — removing unit files…"
rm -f "$UNIT_DIR/shellteam-dream.timer" "$UNIT_DIR/shellteam-dream.service"
rm -f "$UNIT_DIR/shellteam-update.timer" "$UNIT_DIR/shellteam-update.service"
for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u.service"; done
systemctl --user daemon-reload
# A unit that was stopping when its file vanished lingers as "not-found failed"
# in `systemctl --user list-units` — clear it so removal leaves no red entries.
systemctl --user reset-failed 'shellteam-*' >/dev/null 2>&1 || true

log "Removing the Steel browser container + image…"
if command -v docker >/dev/null 2>&1; then
    docker rm -f "$STEEL_CONTAINER" >/dev/null 2>&1 || true
    # The pulled image is ~1.5 GB — removing the container alone leaves it behind.
    docker rmi ghcr.io/steel-dev/steel-browser:latest >/dev/null 2>&1 || true
fi

log "Removing runtime state ($STATE)…"
rm -rf "$STATE"

log "Removing the agent layer (~/.shellteam/agent-layer)…"
rm -rf "$HOME/.shellteam/agent-layer"

# install.sh granted nginx cap_net_bind_service when FILE_PORT < 1024 —
# revert the out-of-namespace capability change. Resolve nginx the same
# PATH-independent way install.sh grants it: on Debian (and any user whose
# PATH omits sbin) `command -v nginx` is empty, and gating the whole block on
# it silently skipped the reversal — a "successful" uninstall left the
# capability in place (round-6 audit P1-02).
NGINX="$(command -v nginx || true)"
if [ -z "$NGINX" ]; then
    for cand in /usr/sbin/nginx /usr/local/sbin/nginx /sbin/nginx; do
        [ -x "$cand" ] && NGINX="$cand" && break
    done
fi
if [ -n "$NGINX" ] && command -v getcap >/dev/null 2>&1; then
    NGINX_BIN="$(readlink -f "$NGINX")"
    if getcap "$NGINX_BIN" 2>/dev/null | grep -q cap_net_bind_service; then
        log "Reverting nginx cap_net_bind_service capability…"
        sudo setcap -r "$NGINX_BIN" || true
        # Trust the observed state, not setcap's exit code: a capability we
        # know was granted must be verified gone, or the user must hear it.
        if getcap "$NGINX_BIN" 2>/dev/null | grep -q cap_net_bind_service; then
            warn "cap_net_bind_service is STILL set on $NGINX_BIN — remove it manually: sudo setcap -r $NGINX_BIN"
        fi
    fi
elif [ -z "$NGINX" ]; then
    log "nginx binary not found (already removed) — no capability to revert."
else
    warn "getcap not available — cannot verify/revert nginx's cap_net_bind_service. If nginx keeps it, run: sudo setcap -r $(readlink -f "$NGINX")"
fi

log "Unmasking system nginx.service (install.sh masked it)…"
sudo systemctl unmask nginx.service >/dev/null 2>&1 || \
    warn "Could not unmask nginx.service — do it manually if you want the distro nginx back."

if [ "$PURGE" -eq 1 ]; then
    log "Purging ~/.shellteam (including your knowledge layer)…"
    rm -rf "$HOME/.shellteam"
    log "Disabling linger (user services no longer start at boot)…"
    sudo loginctl disable-linger "$USER" >/dev/null 2>&1 || true
fi

# Final verification — "removed" must mean verified-down, not hoped-down.
# `|| true`: after --purge disables linger, systemd may tear the user bus down
# right here (no other sessions) — a dead user manager IS proof nothing runs,
# and without the guard set -e turns that success into exit 1 after a fully
# successful removal.
LEFT="$(systemctl --user list-units 'shellteam-*' --state=active,activating --plain --no-legend 2>/dev/null | awk '{print $1}' || true)"
[ -z "$LEFT" ] || die "Unit(s) still running after removal: $LEFT — uninstall is INCOMPLETE."
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
    for var in API_PORT AI_CHAT_PORT; do
        # sed, not grep: grep exits 1 when the var is absent (a minimal .env)
        # and set -e would kill the script; fall back to the install defaults
        # so the ports still get checked.
        port="$(sed -n "s/^$var=//p" "$ENV_FILE" | tail -1 | tr -d '[:space:]')"
        if [ -z "$port" ]; then
            case "$var" in API_PORT) port=8000 ;; AI_CHAT_PORT) port=3456 ;; esac
        fi
        if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null; then
            die "Something still answers on port $port ($var) — uninstall is INCOMPLETE."
        fi
    done
fi

echo
log "ShellTeam removed."
echo "  Left in place (yours / shared): the repo + .env, your coding-agent dotfiles,"
echo "  apt packages (nginx, nodejs), the coding-agent CLIs, Caddy, ~/public (your"
echo "  files), and portable-session lineage under ~/.shellteam/sessions (removed"
echo "  by --purge)."
# if-form: a bare `[ ] && echo` as the last line makes a --purge run exit 1
# under set -e even though everything succeeded.
if [ "$PURGE" -eq 0 ]; then
    echo "  Kept your knowledge layer at ~/.shellteam/knowledge (use --purge to remove)."
fi
echo "  See docs/FOOTPRINT.md for the full list of what ShellTeam touches."

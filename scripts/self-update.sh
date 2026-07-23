#!/usr/bin/env bash
# ShellTeam self-update — fast-forward the checkout to the latest release tag.
#
# Runs from shellteam-update.timer (daily tick). Whether it acts is decided
# HERE, from `AUTO_UPDATE` in .env (off | daily | weekly, default off), so the
# Settings toggle is a plain .env edit with no systemctl side effects — the
# next tick simply picks the new value up.
#
# Safety posture (docs/decisions/20260723-auto-update-timer.md):
#   - tracks the latest `v*` RELEASE TAG, never the main branch tip;
#   - refuses to touch a dirty working tree or a checkout that has diverged
#     from the release lineage (local commits are never clobbered);
#   - fast-forward only, then the canonical `./install.sh` apply step;
#   - health-checks the API afterwards and ROLLS BACK to the previous ref
#     (re-running install.sh) if the update does not come up healthy;
#   - every outcome lands in the journal AND in update-state.json, which the
#     dashboard Settings card displays. Failures exit non-zero so the oneshot
#     unit goes visibly red — never a silent skip.
#
# Overrides (tests / unusual layouts): SHELLTEAM_REPO, SHELLTEAM_ENV_FILE,
# SHELLTEAM_STATE_DIR, SHELLTEAM_UPDATE_INSTALL (command run instead of
# install.sh), SHELLTEAM_UPDATE_HEALTH_URL (curl'd instead of /health).
set -euo pipefail

REPO="${SHELLTEAM_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The update replaces this very file mid-run and bash reads scripts
# incrementally — so hand off to a temp copy before anything else.
if [ -z "${SHELLTEAM_UPDATE_REEXEC:-}" ]; then
    tmp="$(mktemp /tmp/shellteam-self-update.XXXXXX.sh)"
    cp "${BASH_SOURCE[0]}" "$tmp"
    SHELLTEAM_UPDATE_REEXEC="$tmp" SHELLTEAM_REPO="$REPO" exec bash "$tmp" "$@"
fi
trap 'rm -f "$SHELLTEAM_UPDATE_REEXEC"' EXIT

ENV_FILE="${SHELLTEAM_ENV_FILE:-$REPO/.env}"
STATE_DIR="${SHELLTEAM_STATE_DIR:-$HOME/.local/state/shellteam}"
STATE_FILE="$STATE_DIR/update-state.json"

log()  { echo "[self-update] $*"; }
env_val() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

FROM=""; TO=""
write_state() { # <status> <detail> — detail must stay quote-free
    mkdir -p "$STATE_DIR"
    printf '{"status":"%s","detail":"%s","from":"%s","to":"%s","checked_at":"%s","epoch":%s}\n' \
        "$1" "$2" "$FROM" "$TO" "$(date -u +%FT%TZ)" "$(date +%s)" > "$STATE_FILE"
}
fail() {
    log "ERROR: $1" >&2
    write_state error "$1"
    exit 1
}

MODE="$(env_val AUTO_UPDATE)"; MODE="${MODE:-off}"
case "$MODE" in
    off)
        log "AUTO_UPDATE=off — nothing to do."
        write_state off "auto-update is off"
        exit 0 ;;
    daily) ;;
    weekly)
        last_epoch="$(grep -o '"epoch":[0-9]*' "$STATE_FILE" 2>/dev/null | cut -d: -f2 || true)"
        if [ -n "$last_epoch" ] && [ $(( $(date +%s) - last_epoch )) -lt $(( 6 * 86400 )) ]; then
            log "AUTO_UPDATE=weekly — last check under 6 days ago, skipping this tick."
            exit 0
        fi ;;
    *) fail "invalid AUTO_UPDATE=$MODE (expected off, daily or weekly)" ;;
esac

cd "$REPO"
[ -d .git ] || fail "$REPO is not a git checkout"
[ -z "$(git status --porcelain)" ] || \
    fail "working tree has local changes - refusing to update (commit or stash them)"
git fetch --tags --quiet origin || fail "git fetch failed (network or remote problem)"

TAG="$(git tag -l 'v*' --sort=-version:refname | head -1)"
[ -n "$TAG" ] || fail "no v* release tags found on the remote"
TARGET="$(git rev-parse "${TAG}^{commit}")"
FROM="$(git rev-parse HEAD)"; TO="$TAG"

if [ "$FROM" = "$TARGET" ]; then
    log "Already at $TAG — up to date."
    write_state ok "up to date at $TAG"
    exit 0
fi
if ! git merge-base --is-ancestor "$FROM" "$TARGET"; then
    fail "checkout is not an ancestor of $TAG (local commits or a dev branch) - update manually with git"
fi

BRANCH="$(git symbolic-ref --short -q HEAD || true)"
log "Updating $FROM -> $TAG…"
if [ -n "$BRANCH" ]; then
    git merge --ff-only --quiet "$TARGET" || fail "fast-forward to $TAG failed"
else
    git checkout --detach --quiet "$TARGET" || fail "checkout of $TAG failed"
fi

INSTALL_CMD="${SHELLTEAM_UPDATE_INSTALL:-$REPO/install.sh}"
API_PORT_V="$(env_val API_PORT)"; API_PORT_V="${API_PORT_V:-8000}"
HEALTH_URL="${SHELLTEAM_UPDATE_HEALTH_URL:-http://127.0.0.1:${API_PORT_V}/health}"

rollback() { # <reason>
    log "ERROR: $1 - rolling back to $FROM" >&2
    if [ -n "$BRANCH" ]; then
        git reset --hard --quiet "$FROM"
    else
        git checkout --detach --quiet "$FROM"
    fi
    # Re-apply the previous version's install so services run the code that
    # was healthy before. If even this fails, the red unit + journal say so.
    $INSTALL_CMD </dev/null || log "ERROR: rollback install.sh failed - box needs manual attention" >&2
    write_state rolled-back "update to $TAG failed ($1) - rolled back to previous version"
    exit 1
}

# install.sh is the canonical idempotent apply step (restarts services).
# </dev/null: any unexpected prompt must fail fast, not hang the unit.
$INSTALL_CMD </dev/null || rollback "install.sh failed"

healthy=0
for _ in $(seq 1 15); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
    sleep 2
done
[ "$healthy" -eq 1 ] || rollback "API health check did not pass"

log "Updated to $TAG and healthy."
write_state ok "updated to $TAG"

#!/usr/bin/env bash
# run-steel.sh: start a Steel browser container that looks like the ordinary
# browser it is. The ONE place that knows how ShellTeam launches Steel, so
# every Steel container it starts gets the same pinned image and the same look.
#
# Why these settings (SHE-207, measured 15 Nov 2026 on 12 common pages; the
# release check is scripts/browser-check.py):
#   Steel's defaults run Chromium headless with a spoofed fingerprint. A
#   standard detector called that "headless Chrome", 6 of 12 pages refused it,
#   and on a Cloudflare check even a human click could not pass: it reported a
#   800x600 screen in a 1920x1080 window, no WebGL, no plugins, UTC on a French
#   address, and a made-up Chrome version. Spoofing is what gave it away.
#   So the browser is HONEST instead:
#     - a real window on a virtual display (Xvfb), not headless;
#     - no fingerprint injection: it says the Linux Chromium it is;
#     - WebGL on (software rendering) and the PDF viewer on, like any Chrome;
#     - the timezone of the address it browses from.
#   Result: the detector says "not a bot" and one click passes Cloudflare.
#
# Usage:
#   run-steel.sh --name NAME --network NET [--publish 127.0.0.1:3877]
#                [--profile-volume VOLUME] [--memory 2g] [--cpus 1]
#   run-steel.sh --image          # print the pinned image and exit
# DOCKER="sudo docker" in the environment runs docker through sudo.
set -euo pipefail

# Tag+digest: the digest pins, the tag says where it came from. Steel publishes
# only `latest`, rebuilt on every push to main, so a tag alone pins nothing.
# This digest is the build of 2026-10-30 (commit f48b02e, Chromium 156). It is
# deliberately NOT the newest: from the next commit on (#405, still so on
# 2026-11-13) the live view answers no client, Steel's own viewer included,
# and the Browser tab is that live view. Before moving the pin, run
# scripts/browser-check.py and scripts/qa/browser-live-view.mjs against it.
STEEL_IMAGE="ghcr.io/steel-dev/steel-browser:latest@sha256:9796ca0316a2b0daca5de61837e8971ff63b40b1f56aa2f4ec77e2736b25bda0"
PROFILE_DIR="/profile"

DOCKER="${DOCKER:-docker}"
name="" network="" publish="" volume="" memory="" cpus=""
while [ $# -gt 0 ]; do
    case "$1" in
        --image) echo "$STEEL_IMAGE"; exit 0 ;;
        --name) name="$2"; shift 2 ;;
        --network) network="$2"; shift 2 ;;
        --publish) publish="$2"; shift 2 ;;
        --profile-volume) volume="$2"; shift 2 ;;
        --memory) memory="$2"; shift 2 ;;
        --cpus) cpus="$2"; shift 2 ;;
        *) echo "run-steel.sh: unknown option $1" >&2; exit 2 ;;
    esac
done
[ -n "$name" ] && [ -n "$network" ] || { echo "run-steel.sh: --name and --network are required" >&2; exit 2; }

# The timezone of the address the browser will browse from. A clock in UTC on a
# French address is one of the things a site notices. Asked from ipinfo.io (the
# service Steel itself uses); when it cannot be reached, the machine's own
# timezone is used and the mismatch, if any, is said.
browser_timezone() {
    local tz
    tz="$(curl -fsS --max-time 6 https://ipinfo.io/timezone 2>/dev/null | tr -d '[:space:]' || true)"
    if printf '%s' "$tz" | grep -Eq '^[A-Za-z_]+/[A-Za-z_+-]+(/[A-Za-z_+-]+)?$'; then
        printf '%s' "$tz"
        return
    fi
    tz="$(cat /etc/timezone 2>/dev/null || true)"
    [ -n "$tz" ] || tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
    [ -n "$tz" ] || tz="Etc/UTC"
    echo "run-steel.sh: WARNING: could not look up the timezone of this machine's address; the browser uses the machine's own ($tz). If the two differ, sites can tell." >&2
    printf '%s' "$tz"
}
TZ_NAME="$(browser_timezone)"

# Runs inside the container before Steel's own entrypoint:
#  - a previous container's profile and display locks would stop Chromium and
#    Xvfb from starting (the profile outlives the container on its volume, and
#    `docker restart` keeps /tmp);
#  - Steel switches the PDF viewer off in the profile's preferences, which
#    leaves the browser with no plugins; a managed policy wins over that;
#  - Steel's image ships Xvfb but does not start it.
read -r -d '' BOOT <<'BOOT_EOF' || true
rm -f /profile/Singleton* /tmp/.X10-lock
echo '{"AlwaysOpenPdfExternally": false}' > /etc/chromium/policies/managed/10_shellteam.json
Xvfb :10 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
sleep 1
exec /app/api/entrypoint.sh
BOOT_EOF

args=(run -d --name "$name" --hostname shellteam-browser --restart unless-stopped
      --network "$network" --shm-size=1g
      -e CHROME_HEADLESS=false
      -e SKIP_FINGERPRINT_INJECTION=true
      -e "DEFAULT_TIMEZONE=$TZ_NAME"
      # Steel always passes --disable-gpu, and software GL in a way that leaves
      # pages without WebGL: take those out and render through SwiftShader.
      -e "FILTER_CHROME_ARGS=--disable-gpu --use-gl=swiftshader --in-process-gpu"
      -e "CHROME_ARGS=--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist")
[ -n "$publish" ] && args+=(-p "$publish:3000")
[ -n "$memory" ] && args+=(--memory "$memory")
[ -n "$cpus" ] && args+=(--cpus "$cpus")
if [ -n "$volume" ]; then
    # Sign-ins live in the profile: on a volume they survive restarts and updates.
    args+=(-v "$volume:$PROFILE_DIR" -e "CHROME_USER_DATA_DIR=$PROFILE_DIR")
fi
args+=(--entrypoint sh "$STEEL_IMAGE" -c "$BOOT")

# shellcheck disable=SC2086  # DOCKER may be "sudo docker"
exec $DOCKER "${args[@]}"

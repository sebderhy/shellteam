#!/usr/bin/env bash
# mirror-inventory.sh — inventory THIS machine (macOS / Linux / WSL) so a
# ShellTeam box can reproduce your dev environment ("Environment Mirror").
#
# Run it on your laptop (your box serves this script itself, at exactly the
# version it runs — download it, read it, then run it):
#   curl -fsSLO https://your-box.example.com/api/mirror/mirror-inventory.sh
#   bash mirror-inventory.sh
#
# It is STRICTLY READ-ONLY on your machine and produces one artifact:
#   ~/shellteam-mirror-<timestamp>.tar.gz
# Upload that to your ShellTeam box (Files tab, or scp) and tell your agent:
#   "mirror my laptop from the shellteam-mirror tarball in my home dir"
#
# What it collects (whitelist only — nothing else leaves your machine):
#   - package lists (brew / apt / npm / pipx / uv / cargo), VS Code extensions
#   - shell + editor + terminal dotfiles
#   - coding-agent config (Claude Code, Codex, OpenCode, Gemini) — configs and
#     skills only, NEVER credential/session files
#   - a list of your git repos (paths + remotes + branch), not their contents
#   - crontab
#
# Secrets NEVER travel in the default tarball: credential files are excluded by
# construction, every staged file is scanned for secret-looking values and those
# lines are redacted, and a SECRETS-MAP.md lists where secrets live on this
# machine (paths only) so the box agent can walk you through re-provisioning.
#
# Wizard modes (used by mirror-import.sh — the guided import UI):
#   --stage DIR                 stage everything into DIR without packing,
#                               INCLUDING opt-in `secure/` sections (agent
#                               logins, MCP tokens, chat history). secure/ is
#                               exempt from redaction: it exists only so the
#                               wizard can send it over TLS directly to the
#                               user's OWN box, and it is never written into a
#                               default (shareable) tarball.
#   --pack DIR --sections a,b --out FILE
#                               pack selected sections from a staged DIR.
#                               Sections: packages dotfiles repos agents
#                               logins history env shell-history
set -euo pipefail

MIRROR_FORMAT=2
MAX_FILE_KB=512     # any single staged file larger than this is skipped
MAX_DIR_KB=5120     # any whitelisted config dir larger than this is skipped
MAX_HISTORY_MB="${MIRROR_MAX_HISTORY_MB:-200}"  # per-agent chat-history cap

HOME_DIR="${HOME:?}"    # override with --home (e.g. a WSL user's Windows profile)
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '%s\n' "$*"; }
note() { printf '  • %s\n' "$*"; }
skip() { printf '  – skipped: %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── Mode parsing ──────────────────────────────────────────────────────────────
MODE="default"      # default = stage safe sections + redact + pack (v1 behavior)
STAGE=""
PACK_SECTIONS=""
PACK_OUT=""
while [ $# -gt 0 ]; do
    case "$1" in
    --stage)    MODE="stage"; STAGE="${2:?--stage needs a directory}"; shift 2 ;;
    --pack)     MODE="pack";  STAGE="${2:?--pack needs a staged directory}"; shift 2 ;;
    --sections) PACK_SECTIONS="${2:?}"; shift 2 ;;
    --out)      PACK_OUT="${2:?}"; shift 2 ;;
    --home)     HOME_DIR="${2:?--home needs a directory}"; shift 2 ;;
    *) say "unknown argument: $1"; exit 2 ;;
    esac
done
HOME_DIR="${HOME_DIR%/}"    # repo paths are emitted relative to "$HOME_DIR/"
[ -d "$HOME_DIR" ] || { say "not a directory: $HOME_DIR"; exit 2; }

# ── Pack mode: tar selected sections from an existing stage and exit ──────────
# The stage's top-level layout IS the section contract:
#   packages/ dotfiles/ repos.tsv agents/ secure/logins/ secure/history/
#   secure/env/ secure/shell-history/ — plus always-shipped metadata files.
section_paths() {
    case "$1" in
    packages)      echo "packages" ;;
    dotfiles)      echo "dotfiles" ;;
    repos)         echo "repos.tsv" ;;
    agents)        echo "agents" ;;
    logins)        echo "secure/logins" ;;
    history)       echo "secure/history" ;;
    env)           echo "secure/env" ;;
    shell-history) echo "secure/shell-history" ;;
    *) return 1 ;;
    esac
}

if [ "$MODE" = "pack" ]; then
    : "${PACK_SECTIONS:?--pack needs --sections}"
    : "${PACK_OUT:?--pack needs --out}"
    [ -f "$STAGE/manifest.json" ] || { say "not a mirror stage: $STAGE"; exit 2; }
    PATHS=(manifest.json)
    for meta in redactions.txt SECRETS-MAP.md crontab.txt summary.json; do
        [ -f "$STAGE/$meta" ] && PATHS+=("$meta")
    done
    IFS=',' read -ra WANTED <<< "$PACK_SECTIONS"
    for section in "${WANTED[@]}"; do
        rel="$(section_paths "$section")" || { say "unknown section: $section"; exit 2; }
        [ -e "$STAGE/$rel" ] && PATHS+=("$rel")
    done
    tar -czf "$PACK_OUT" -C "$STAGE" "${PATHS[@]}"
    chmod 600 "$PACK_OUT"
    say "Packed sections [$PACK_SECTIONS] -> $PACK_OUT ($(du -h "$PACK_OUT" | awk '{print $1}'))"
    exit 0
fi

# ── Inventory (default + --stage modes) ───────────────────────────────────────
if [ "$MODE" = "stage" ]; then
    mkdir -p "$STAGE"
    OUT=""
else
    STAGE="$(mktemp -d "${TMPDIR:-/tmp}/shellteam-mirror.XXXXXX")"
    OUT="$HOME_DIR/shellteam-mirror-$STAMP.tar.gz"
    trap 'rm -rf "$STAGE"' EXIT
fi

file_kb() { du -k "$1" 2>/dev/null | awk 'END {print $1}'; }

# Stage a single file (whitelist copy). $1 = source, $2 = dest relative to stage.
stage_file() {
    local src="$1" dst="$STAGE/$2"
    [ -f "$src" ] || return 0
    if [ "$(file_kb "$src")" -gt "$MAX_FILE_KB" ]; then
        skip "$src (> ${MAX_FILE_KB}KB)"
        return 0
    fi
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    note "$src"
}

# Stage a whole config dir (bounded). $1 = source dir, $2 = dest relative.
stage_dir() {
    local src="$1" dst="$STAGE/$2"
    [ -d "$src" ] || return 0
    if [ "$(du -sk "$src" 2>/dev/null | awk '{print $1}')" -gt "$MAX_DIR_KB" ]; then
        skip "$src (> ${MAX_DIR_KB}KB total)"
        return 0
    fi
    mkdir -p "$dst"
    cp -R "$src/." "$dst/"
    note "$src/"
}

say "ShellTeam Environment Mirror — inventorying $(hostname) (read-only)"
say ""

# ── System info ───────────────────────────────────────────────────────────────
OS="$(uname -s)"; ARCH="$(uname -m)"
IS_WSL=false
[ -f /proc/version ] && grep -qi microsoft /proc/version && IS_WSL=true

tool_version() { have "$1" && "$1" --version 2>/dev/null | head -1 || echo "not installed"; }

# Anything interpolated into the manifest goes through this: strip control
# characters and escape backslash + quote, so the manifest is valid JSON
# whatever a tool prints. Real machines print surprising things — a WSL
# `docker --version` can carry ANSI escapes or a CR, and one raw control
# character used to make the manifest unparseable, which the redaction pass
# then (correctly) deleted, leaving the wizard with no manifest at all.
json_str() { printf '%s' "$1" | tr -d '\000-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

{
    printf '{\n'
    printf '  "mirror_format": %s,\n' "$MIRROR_FORMAT"
    printf '  "created": "%s",\n' "$(json_str "$STAMP")"
    printf '  "os": "%s",\n' "$(json_str "$OS")"
    printf '  "arch": "%s",\n' "$(json_str "$ARCH")"
    printf '  "wsl": %s,\n' "$IS_WSL"
    printf '  "hostname": "%s",\n' "$(json_str "$(hostname)")"
    printf '  "user": "%s",\n' "$(json_str "$(id -un)")"
    printf '  "home": "%s",\n' "$(json_str "$HOME_DIR")"
    printf '  "shell": "%s",\n' "$(json_str "${SHELL:-unknown}")"
    printf '  "tools": {\n'
    printf '    "git": "%s",\n'     "$(json_str "$(tool_version git)")"
    printf '    "node": "%s",\n'    "$(json_str "$(tool_version node)")"
    printf '    "python3": "%s",\n' "$(json_str "$(tool_version python3)")"
    printf '    "docker": "%s"\n'   "$(json_str "$(tool_version docker)")"
    printf '  }\n'
    printf '}\n'
} > "$STAGE/manifest.json"
say "System: $OS/$ARCH (WSL: $IS_WSL)"

# ── Packages ──────────────────────────────────────────────────────────────────
say ""
say "Packages:"
mkdir -p "$STAGE/packages"
if have brew; then
    brew leaves > "$STAGE/packages/brew-formulae.txt" 2>/dev/null || true
    brew list --cask > "$STAGE/packages/brew-casks.txt" 2>/dev/null || true
    note "Homebrew: $(wc -l < "$STAGE/packages/brew-formulae.txt" | tr -d ' ') formulae, $(wc -l < "$STAGE/packages/brew-casks.txt" 2>/dev/null | tr -d ' ') casks"
fi
if have apt-mark; then
    apt-mark showmanual > "$STAGE/packages/apt-manual.txt" 2>/dev/null || true
    note "apt: $(wc -l < "$STAGE/packages/apt-manual.txt" | tr -d ' ') manually-installed packages"
fi
if have npm; then
    npm ls -g --depth=0 2>/dev/null | tail -n +2 > "$STAGE/packages/npm-globals.txt" || true
    note "npm globals captured"
fi
if have pipx; then
    pipx list --short > "$STAGE/packages/pipx.txt" 2>/dev/null || true
    note "pipx tools captured"
fi
if have uv; then
    uv tool list > "$STAGE/packages/uv-tools.txt" 2>/dev/null || true
    note "uv tools captured"
fi
if have cargo; then
    cargo install --list > "$STAGE/packages/cargo.txt" 2>/dev/null || true
    note "cargo installs captured"
fi
for editor in code cursor; do
    if have "$editor"; then
        "$editor" --list-extensions > "$STAGE/packages/$editor-extensions.txt" 2>/dev/null || true
        note "$editor extensions captured"
    fi
done
# Secrets-manager CLIs (Infisical, Doppler, 1Password, Vault, …): their
# presence changes the whole re-provisioning story — such users often have NO
# .env files or key material on disk at all; the box just needs the same CLI
# installed plus ONE login. Names only, never their caches or tokens.
rm -f "$STAGE/packages/secrets-managers.txt"   # >> below; a reused --stage dir must not duplicate
for sm in infisical doppler op vault teller chamber; do
    have "$sm" && printf '%s\n' "$sm" >> "$STAGE/packages/secrets-managers.txt"
done
if [ -s "$STAGE/packages/secrets-managers.txt" ]; then
    note "secrets-manager CLI(s) detected: $(tr '\n' ' ' < "$STAGE/packages/secrets-managers.txt")"
fi

# ── Dotfiles (whitelist) ──────────────────────────────────────────────────────
say ""
say "Dotfiles:"
DOTFILES=(
    .zshrc .zprofile .zshenv .bashrc .bash_profile .bash_aliases .profile
    .aliases .exports .functions .inputrc
    .gitconfig .gitignore_global .gitattributes
    .vimrc .ideavimrc .tmux.conf .wezterm.lua .editorconfig
)
for f in "${DOTFILES[@]}"; do
    stage_file "$HOME_DIR/$f" "dotfiles/$f"
done
stage_file "$HOME_DIR/.config/starship.toml" "dotfiles/.config/starship.toml"
for d in nvim fish ghostty alacritty kitty helix; do
    stage_dir "$HOME_DIR/.config/$d" "dotfiles/.config/$d"
done
stage_dir "$HOME_DIR/.oh-my-zsh/custom" "dotfiles/.oh-my-zsh/custom"
# ssh CLIENT config only (hosts/aliases) — keys are never touched.
stage_file "$HOME_DIR/.ssh/config" "dotfiles/.ssh/config"

# VS Code user settings (paths differ per OS)
if [ "$OS" = "Darwin" ]; then
    VSCODE_USER="$HOME_DIR/Library/Application Support/Code/User"
else
    VSCODE_USER="$HOME_DIR/.config/Code/User"
fi
stage_file "$VSCODE_USER/settings.json" "dotfiles/vscode/settings.json"
stage_file "$VSCODE_USER/keybindings.json" "dotfiles/vscode/keybindings.json"

# ── Coding-agent config (whitelist — NEVER credential/session files) ──────────
say ""
say "Coding-agent config:"
for f in CLAUDE.md settings.json keybindings.json; do
    stage_file "$HOME_DIR/.claude/$f" "agents/claude/$f"
done
for d in skills agents commands; do
    stage_dir "$HOME_DIR/.claude/$d" "agents/claude/$d"
done
# Claude Code auto-memory: the memory/ dir of each project (MEMORY.md + topic
# files). Session transcripts living alongside are NEVER staged here (they are
# an opt-in `secure/history` section in --stage mode).
for mem in "$HOME_DIR"/.claude/projects/*/memory; do
    [ -d "$mem" ] || continue
    stage_dir "$mem" "agents/claude/project-memory/$(basename "$(dirname "$mem")")"
done
# ~/.claude.json holds OAuth tokens + history and is NEVER staged; extract just
# the MCP server definitions (which the user does want mirrored).
if [ -f "$HOME_DIR/.claude.json" ] && have python3; then
    python3 - "$HOME_DIR/.claude.json" > "$STAGE/agents/claude/mcp-servers.json" 2>/dev/null <<'PYEOF' || true
import json, sys
data = json.load(open(sys.argv[1]))
print(json.dumps({"mcpServers": data.get("mcpServers", {})}, indent=2))
PYEOF
    [ -s "$STAGE/agents/claude/mcp-servers.json" ] && note "Claude MCP server definitions (tokens/history excluded)"
fi
stage_file "$HOME_DIR/.codex/config.toml" "agents/codex/config.toml"
stage_file "$HOME_DIR/.codex/AGENTS.md" "agents/codex/AGENTS.md"
stage_dir "$HOME_DIR/.codex/prompts" "agents/codex/prompts"
stage_dir "$HOME_DIR/.agents/skills" "agents/shared-skills"
stage_file "$HOME_DIR/.config/opencode/opencode.json" "agents/opencode/opencode.json"
stage_file "$HOME_DIR/.gemini/GEMINI.md" "agents/gemini/GEMINI.md"
stage_file "$HOME_DIR/.gemini/settings.json" "agents/gemini/settings.json"

# ── Git repos (paths + remotes only, never contents) ──────────────────────────
say ""
say "Git repos:"
REPO_ROOTS=(code projects dev src work repos workspace git Developer
    "Documents/GitHub" "source/repos")   # GitHub Desktop / Visual Studio defaults, for Windows profiles
{
    # shallow scan of $HOME itself, then deeper scan of conventional code roots
    find "$HOME_DIR" -maxdepth 2 -name .git \( -type d -o -type f \) 2>/dev/null
    for root in "${REPO_ROOTS[@]}"; do
        [ -d "$HOME_DIR/$root" ] || continue
        find "$HOME_DIR/$root" -maxdepth 4 -name .git \( -type d -o -type f \) 2>/dev/null
    done
    true  # the group's status must not depend on the last root existing (pipefail)
} | sed 's|/\.git$||' | sort -u | while read -r repo; do
    remote="$(git -C "$repo" remote get-url origin 2>/dev/null || echo '-')"
    # symbolic-ref, not rev-parse: on a no-commit repo rev-parse prints "HEAD"
    # AND fails, so `|| echo` used to emit a second line and corrupt the TSV.
    branch="$(git -C "$repo" symbolic-ref --short -q HEAD 2>/dev/null || echo '-')"
    # `|| true` on the pipeline: a phantom .git (a dir that isn't a valid
    # repo) makes git exit 128 and, under pipefail, used to kill the entire
    # inventory. Such a repo is listed with dirty=0 instead.
    dirty="$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || true)"
    printf '%s\t%s\t%s\t%s\n' "${repo#"$HOME_DIR"/}" "$remote" "$branch" "$dirty"
done > "$STAGE/repos.tsv"
note "$(wc -l < "$STAGE/repos.tsv" | tr -d ' ') repos listed (path, origin, branch, dirty-file count)"

# ── Crontab ───────────────────────────────────────────────────────────────────
crontab -l > "$STAGE/crontab.txt" 2>/dev/null || true

# ── Opt-in secure sections (--stage mode only) ────────────────────────────────
# These NEVER enter a default (shareable) tarball. The wizard packs them only
# for a direct TLS upload to the user's own box, where the migrate skill
# installs them and deletes the archive. They are exempt from the redaction
# pass below by construction (redaction would destroy the credentials and
# chat transcripts the user explicitly chose to move).
if [ "$MODE" = "stage" ]; then
    say ""
    say "Opt-in sections (only travel on direct upload to YOUR box):"

    # Everything below writes live OAuth refresh tokens and MCP bearer tokens.
    # Shell redirection creates those files at the ambient umask (0664 at the
    # common 002), and at umask 002 the secure/ directory itself would be
    # GROUP-WRITABLE — a hostile group member could swap in their own
    # mcp-servers.json before packing and get code execution on the box. The
    # wizard's own workdir is 700, but `--stage DIR` is a documented mode
    # anyone may run directly, so clamp here rather than relying on the caller.
    umask 077
    chmod 700 "$STAGE" 2>/dev/null || true

    # Agent logins: skip re-authenticating Claude/Codex on the box.
    if [ -f "$HOME_DIR/.claude/.credentials.json" ]; then
        mkdir -p "$STAGE/secure/logins/claude"
        cp "$HOME_DIR/.claude/.credentials.json" "$STAGE/secure/logins/claude/credentials.json"
        note "Claude Code login (~/.claude/.credentials.json)"
    elif [ "$OS" = "Darwin" ] && have security; then
        # macOS stores Claude Code credentials in the Keychain, not a file.
        if creds="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)" && [ -n "$creds" ]; then
            mkdir -p "$STAGE/secure/logins/claude"
            printf '%s\n' "$creds" > "$STAGE/secure/logins/claude/credentials.json"
            note "Claude Code login (macOS Keychain)"
        fi
    fi
    if [ -f "$HOME_DIR/.claude.json" ] && have python3; then
        # mkdir first: secure/logins/ only exists by now if a credentials FILE
        # was staged above, which is not the case when the login lives in a
        # keystore (Windows Credential Manager) or Claude is signed out — the
        # redirect below would then fail and drop the account identity.
        mkdir -p "$STAGE/secure/logins"
        python3 - "$HOME_DIR/.claude.json" > "$STAGE/secure/logins/claude-oauth-account.json.tmp" 2>/dev/null <<'PYEOF' || true
import json, sys
data = json.load(open(sys.argv[1]))
keep = {k: data[k] for k in ("oauthAccount",) if k in data}
print(json.dumps(keep, indent=2))
PYEOF
        if [ -s "$STAGE/secure/logins/claude-oauth-account.json.tmp" ] && grep -q oauthAccount "$STAGE/secure/logins/claude-oauth-account.json.tmp"; then
            mkdir -p "$STAGE/secure/logins/claude"
            mv "$STAGE/secure/logins/claude-oauth-account.json.tmp" "$STAGE/secure/logins/claude/oauth-account.json"
        else
            rm -f "$STAGE/secure/logins/claude-oauth-account.json.tmp"
        fi
    fi
    if [ -f "$HOME_DIR/.codex/auth.json" ]; then
        mkdir -p "$STAGE/secure/logins/codex"
        cp "$HOME_DIR/.codex/auth.json" "$STAGE/secure/logins/codex/auth.json"
        note "Codex login (~/.codex/auth.json)"
    fi
    # MCP definitions WITH their tokens/headers (the scrubbed copy lives in
    # agents/; this one keeps already-authenticated MCPs working on the box).
    if [ -f "$HOME_DIR/.claude.json" ] && have python3; then
        mkdir -p "$STAGE/secure/logins/mcp"
        python3 - "$HOME_DIR/.claude.json" > "$STAGE/secure/logins/mcp/mcp-servers.json" 2>/dev/null <<'PYEOF' || rm -f "$STAGE/secure/logins/mcp/mcp-servers.json"
import json, sys
data = json.load(open(sys.argv[1]))
print(json.dumps({"mcpServers": data.get("mcpServers", {})}, indent=2))
PYEOF
        [ -s "$STAGE/secure/logins/mcp/mcp-servers.json" ] && note "MCP servers with auth intact"
    fi

    # Chat history: Claude project transcripts + Codex sessions, newest first,
    # capped per agent so a years-old archive can't balloon the upload.
    if have python3; then
        python3 - "$HOME_DIR" "$STAGE" "$MAX_HISTORY_MB" <<'PYEOF'
import os, shutil, sys
home, stage, cap_mb = sys.argv[1], sys.argv[2], int(sys.argv[3])
cap = cap_mb * 1024 * 1024

def collect(root, rel_root, dest_root, match):
    files = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            path = os.path.join(dirpath, name)
            if match(path, name):
                st = os.stat(path)
                files.append((st.st_mtime, st.st_size, path))
    files.sort(reverse=True)  # newest first
    copied = total = skipped = 0
    for _mtime, size, path in files:
        if total + size > cap:
            skipped += 1
            continue
        rel = os.path.relpath(path, rel_root)
        dst = os.path.join(dest_root, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(path, dst)
        copied += 1
        total += size
    return copied, total, skipped

claude_projects = os.path.join(home, ".claude", "projects")
if os.path.isdir(claude_projects):
    n, size, skipped = collect(
        claude_projects, os.path.join(home, ".claude"),
        os.path.join(stage, "secure", "history", "claude"),
        lambda path, name: name.endswith(".jsonl") and os.sep + "memory" + os.sep not in path,
    )
    print(f"  • Claude chat history: {n} session files ({size // 1024}KB)"
          + (f", {skipped} old ones over the {cap_mb}MB cap" if skipped else ""))
codex_sessions = os.path.join(home, ".codex", "sessions")
if os.path.isdir(codex_sessions):
    n, size, skipped = collect(
        codex_sessions, os.path.join(home, ".codex"),
        os.path.join(stage, "secure", "history", "codex"),
        lambda path, name: name.endswith(".jsonl"),
    )
    print(f"  • Codex chat history: {n} session files ({size // 1024}KB)"
          + (f", {skipped} old ones over the {cap_mb}MB cap" if skipped else ""))
codex_hist = os.path.join(home, ".codex", "history.jsonl")
if os.path.isfile(codex_hist) and os.path.getsize(codex_hist) <= cap:
    dst = os.path.join(stage, "secure", "history", "codex", "history.jsonl")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(codex_hist, dst)
PYEOF
    fi

    # Project .env files: the CONTENTS, staged at their repo-relative path so
    # the box agent drops each back where it belongs. This is what makes the
    # env re-provisioning safe — the keys ride the same TLS channel as the
    # logins, straight to the user's own box, instead of being pasted into a
    # chat with an agent. Direct-upload only (secure/), never a saved tarball.
    env_count=0
    while IFS=$'\t' read -r repo _; do
        [ -n "$repo" ] || continue
        for envname in .env .env.local; do
            src="$HOME_DIR/$repo/$envname"
            if [ -f "$src" ] && [ "$(file_kb "$src")" -le "$MAX_FILE_KB" ]; then
                dst="$STAGE/secure/env/$repo/$envname"
                mkdir -p "$(dirname "$dst")"
                cp "$src" "$dst"
                env_count=$((env_count + 1))
            fi
        done
    done < "$STAGE/repos.tsv"
    [ "$env_count" -gt 0 ] && note "$env_count project .env file(s) (move over TLS to your box; never pasted)"

    # Shell history (off by default in the wizard — some people grep their
    # history like a second brain, so it stays available as a choice).
    for h in .bash_history .zsh_history; do
        if [ -f "$HOME_DIR/$h" ]; then
            mkdir -p "$STAGE/secure/shell-history"
            cp "$HOME_DIR/$h" "$STAGE/secure/shell-history/$h"
            note "shell history: ~/$h"
        fi
    done
    stage_file "$HOME_DIR/.local/share/fish/fish_history" "secure/shell-history/fish_history"
fi

# ── Secrets map (paths ONLY — contents never staged) ──────────────────────────
say ""
say "Secrets survey (paths only — nothing is copied):"
{
    echo "# Where secrets live on the source machine"
    echo
    echo "These files' CONTENTS are not copied, with one exception called out"
    echo "inline below: a project .env whose values were staged for a direct"
    echo "upload to your own box. On the new box, walk the user through"
    echo "re-provisioning everything else (fresh logins/keys are safer than"
    echo "copied ones)."
    echo
    for f in .aws/credentials .netrc .npmrc .docker/config.json .config/gh/hosts.yml .kube/config; do
        [ -f "$HOME_DIR/$f" ] && echo "- ~/$f"
    done
    for k in "$HOME_DIR"/.ssh/id_*; do
        [ -f "$k" ] && case "$k" in *.pub) ;; *) echo "- ~/${k#"$HOME_DIR"/} (ssh private key — generate a NEW key on the box instead)";; esac
    done
    if [ -s "$STAGE/packages/secrets-managers.txt" ]; then
        while IFS= read -r sm; do
            echo "- secrets-manager CLI: $sm — the user's project secrets live in $sm, not in files. Install the $sm CLI on the box and have the user log in ONCE; no key pasting or .env recreation needed for those."
        done < "$STAGE/packages/secrets-managers.txt"
    fi
    # A .env whose values were staged says so, so the box agent doesn't march the
    # user through recreating a file it already placed (and so this map never
    # claims the contents stayed behind when they didn't).
    while IFS=$'\t' read -r repo _; do
        for env in "$HOME_DIR/$repo/.env" "$HOME_DIR/$repo/.env.local"; do
            [ -f "$env" ] || continue
            rel="${env#"$HOME_DIR"/}"
            if [ -f "$STAGE/secure/env/$rel" ]; then
                echo "- ~/$rel (project env file: values staged in secure/env/, placed for you)"
            else
                echo "- ~/$rel (project env file: recreate by hand)"
            fi
        done
    done < "$STAGE/repos.tsv"
} > "$STAGE/SECRETS-MAP.md"
note "$(grep -c '^- ' "$STAGE/SECRETS-MAP.md" || true) secret locations mapped in SECRETS-MAP.md"

# ── Redaction pass over everything staged (secure/ exempt, see above) ─────────
# Fail-safe: any staged line that LOOKS like a secret is replaced wholesale.
say ""
say "Redaction pass:"
SECRET_RE='sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}[.]eyJ|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+-]{16,}|[Ss][Ee][Cc][Rr][Ee][Tt]["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+-]{16,}|[Tt][Oo][Kk][Ee][Nn]["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+-]{16,}'
REDACTED_COUNT=0
: > "$STAGE/redactions.txt"

# JSON files must stay parseable: scrub string VALUES in place (by secret-shaped
# value or secret-named key) instead of replacing whole lines with comments.
scrub_json() {  # $1 = file; prints hit count; non-zero exit = could not scrub
    python3 - "$1" "${SECRET_RE//\[\[:space:\]\]/\\s}" <<'PYEOF'
import json, re, sys
path, value_re = sys.argv[1], re.compile(sys.argv[2])
key_re = re.compile(r"(?i)(token|secret|passw|api[-_]?key|authorization|bearer|credential)")
hits = 0
def scrub(node, key=None):
    global hits
    if isinstance(node, dict):
        return {k: scrub(v, k) for k, v in node.items()}
    if isinstance(node, list):
        return [scrub(v) for v in node]
    if isinstance(node, str) and (value_re.search(node) or (key and key_re.search(key) and len(node) >= 8)):
        hits += 1
        return "[REDACTED by shellteam-mirror: possible secret]"
    return node
data = scrub(json.load(open(path)))
if hits:
    json.dump(data, open(path, "w"), indent=2)
print(hits)
PYEOF
}

while IFS= read -r f; do
    if grep -q -- '-----BEGIN .*PRIVATE KEY-----' "$f" 2>/dev/null; then
        echo "REMOVED ENTIRELY (private key material): ${f#"$STAGE"/}" >> "$STAGE/redactions.txt"
        rm -f "$f"
        REDACTED_COUNT=$((REDACTED_COUNT + 1))
        continue
    fi
    case "$f" in
    *.json)
        if hits="$(scrub_json "$f")"; then
            if [ "$hits" -gt 0 ]; then
                echo "REDACTED $hits value(s): ${f#"$STAGE"/}" >> "$STAGE/redactions.txt"
                REDACTED_COUNT=$((REDACTED_COUNT + hits))
            fi
        else
            # No python3 / unparseable: leaking is the only unacceptable outcome.
            echo "REMOVED ENTIRELY (json not scrubbable): ${f#"$STAGE"/}" >> "$STAGE/redactions.txt"
            rm -f "$f"
            REDACTED_COUNT=$((REDACTED_COUNT + 1))
        fi
        ;;
    *)
        if grep -Eq "$SECRET_RE" "$f" 2>/dev/null; then
            hits="$(grep -Ec "$SECRET_RE" "$f")"
            awk -v re="$SECRET_RE" '{ if ($0 ~ re) print "# [REDACTED by shellteam-mirror: possible secret]"; else print }' \
                "$f" > "$f.redacted" && mv "$f.redacted" "$f"
            echo "REDACTED $hits line(s): ${f#"$STAGE"/}" >> "$STAGE/redactions.txt"
            REDACTED_COUNT=$((REDACTED_COUNT + hits))
        fi
        ;;
    esac
done < <(find "$STAGE" -type f ! -name redactions.txt ! -name SECRETS-MAP.md ! -path "$STAGE/secure/*")
if [ "$REDACTED_COUNT" -gt 0 ]; then
    note "$REDACTED_COUNT secret-looking line(s) redacted — details in redactions.txt"
else
    note "no secret-looking content found in staged files"
fi

# The manifest is OUR file: if the pass above dropped it as unparseable, that is
# a bug in this script, not user data. Say so here instead of letting the wizard
# die later on a bare FileNotFoundError.
if [ ! -f "$STAGE/manifest.json" ]; then
    say ""
    say "ShellTeam bug: manifest.json was generated as invalid JSON and dropped."
    say "Nothing left your machine. Please report this with the line above."
    exit 3
fi

# ── Summary (--stage mode: what the wizard renders as checkboxes) ─────────────
if [ "$MODE" = "stage" ] && have python3; then
    python3 - "$STAGE" <<'PYEOF'
import json, os, sys
stage = sys.argv[1]

def stats(rel):
    root = os.path.join(stage, rel)
    if not os.path.exists(root):
        return {"present": False, "files": 0, "kb": 0}
    if os.path.isfile(root):
        return {"present": True, "files": 1, "kb": os.path.getsize(root) // 1024}
    files = size = 0
    for dirpath, _d, names in os.walk(root):
        for n in names:
            files += 1
            size += os.path.getsize(os.path.join(dirpath, n))
    return {"present": files > 0, "files": files, "kb": size // 1024}

repos = 0
repos_path = os.path.join(stage, "repos.tsv")
if os.path.isfile(repos_path):
    repos = sum(1 for line in open(repos_path) if line.strip())

summary = {
    "sections": {
        "packages": stats("packages"),
        "dotfiles": stats("dotfiles"),
        "repos": {**stats("repos.tsv"), "count": repos},
        "agents": stats("agents"),
        "logins": {
            **stats("secure/logins"),
            "claude": os.path.isfile(os.path.join(stage, "secure/logins/claude/credentials.json")),
            "codex": os.path.isfile(os.path.join(stage, "secure/logins/codex/auth.json")),
            "mcp": os.path.isfile(os.path.join(stage, "secure/logins/mcp/mcp-servers.json")),
        },
        "history": {
            **stats("secure/history"),
            "claude_files": stats("secure/history/claude")["files"],
            "codex_files": stats("secure/history/codex")["files"],
        },
        "env": stats("secure/env"),
        "shell-history": stats("secure/shell-history"),
    },
}
with open(os.path.join(stage, "summary.json"), "w") as fh:
    json.dump(summary, fh, indent=2)
PYEOF
    say ""
    say "Staged (no tarball): $STAGE"
    exit 0
fi

# ── Pack (default mode) ───────────────────────────────────────────────────────
tar -czf "$OUT" -C "$STAGE" .
say ""
say "Done: $OUT ($(du -h "$OUT" | awk '{print $1}'))"
say ""
say "Next steps:"
say "  1. Upload it to your ShellTeam box — drag it into the Files tab, or:"
say "       scp $OUT <your-box>:~/"
say "  2. Tell your agent: \"mirror my laptop from the shellteam-mirror tarball\""
say ""
say "Review what was collected before uploading:  tar -tzf $OUT"

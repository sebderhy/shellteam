# What ShellTeam touches on your box

ShellTeam is an **additive layer on top of your VPS, not a mutation of it.** This
page is the complete, honest manifest of everything `install.sh` adds or changes —
so you (or a coding agent) can audit it before installing and reverse it after.

The guiding rule: **ShellTeam never writes to your coding-agent config or your
dotfiles.** Run `claude` / `codex` / `agy` / `opencode` in your own shell and you get *your*
config, untouched. Run an agent *through ShellTeam* and you get your config **plus**
ShellTeam's additions, composed at launch and persisted only in ShellTeam's own
namespace. See [design/vps-footprint.md](design/vps-footprint.md) for the why.

This extends to the third-party installers `install.sh` runs (uv, Antigravity):
some like to append PATH lines to `~/.bashrc` / `~/.profile` / fish's `conf.d`.
The installer snapshots those files around each such step and restores any edit,
loudly (their binaries land in `~/.local/bin`, which ShellTeam's service PATH
already covers — the edits are unnecessary). Pinned by
`tests/test_install_bootstrap.py`.

## Tier 1 — ShellTeam's own stuff (namespaced, fully removable)

| What | Where | Removed by |
|---|---|---|
| systemd `--user` services | `~/.config/systemd/user/shellteam-{api,ai-chat,nginx}.service` | `uninstall.sh` |
| Dreaming timer (only with the `dreaming` module) | `~/.config/systemd/user/shellteam-dream.{service,timer}` | `uninstall.sh` (or dropping the module + re-running `install.sh`) |
| Self-update timer (inert unless `AUTO_UPDATE` is on in `.env`) | `~/.config/systemd/user/shellteam-update.{service,timer}` | `uninstall.sh` |
| Runtime state (rendered nginx config, etc.) | `~/.local/state/shellteam/` | `uninstall.sh` |
| **Agent launch-layer** (skills, hooks, MCP, persona) | `~/.shellteam/agent-layer/` | `uninstall.sh` |
| Knowledge layer (your accumulated memory, incl. the per-folder `tree/`) | `~/.shellteam/knowledge/` | `uninstall.sh --purge` |
| Dream run artifacts (audit trail: prompts, deltas, reports) | `~/.shellteam/dream/` | `uninstall.sh --purge` |
| Steel browser (opt-in: part of `--full`) | Docker container `shellteam-steel` | `uninstall.sh` |

## Tier 2 — the agent layer (additive; **never your dotfiles**)

ShellTeam's additions to coding agents — its skills, hooks, MCP servers, and
system-prompt persona — live entirely under `~/.shellteam/agent-layer/` and are
loaded **at agent-launch time**, not by editing your config. The prompt, skills,
and MCP set come from one canonical rendered harness, so every cockpit agent
gets the same agent-visible ShellTeam layer:

- **Claude Code** — spawned with `--plugin-dir ~/.shellteam/agent-layer/claude`
  (a session-only plugin bundling skills + hooks + MCP) and
  `--append-system-prompt-file …/system-prompt.md`.
- **Codex** — ShellTeam splices `-c key=value` overrides at spawn (MCP servers,
  doc-fallback, shared developer prompt, plus the OpenAI provider when you use
  your own key). A cockpit-only `~/.shellteam/agent-layer/codex-home` overlay
  exposes the canonical skills while `CODEX_HOME` stays on your real `~/.codex`
  auth/config; ShellTeam writes nothing there.
- **Antigravity** — ShellTeam passes `--add-dir` for its own
  `~/.shellteam/agent-layer/antigravity-workspace`, whose workspace plugin holds
  the same prompt, skills, and MCP servers. It writes nothing to `~/.gemini`.
- **OpenCode** — ShellTeam sets `OPENCODE_CONFIG=~/.shellteam/agent-layer/opencode.json`
  (Fireworks provider + the canonical prompt, MCP, and skills). OpenCode **merges**
  it with your own config; ShellTeam writes nothing to `~/.config/opencode`.

So for every agent, ShellTeam's additions are composed at launch and your config
dirs are never written. API keys you set in the cockpit are passed to agents **via
environment variables**, never written into shared config files.

## Tier 3 — genuinely global changes (can't be additive → disclosed)

These touch the box outside ShellTeam's namespace. `uninstall.sh` reverses the one
that's purely ours (the nginx mask); the rest are standard packages left in place.

| Change | Why | Reversal |
|---|---|---|
| apt packages: `nginx`, `nodejs`, plus `curl ca-certificates git python3 python3-venv` | the stack needs them | `apt remove` (manual — you may want them) |
| Global npm CLIs: `claude`, `codex`, `opencode`; plus the Antigravity CLI `agy` (official installer → `~/.local/bin/agy`) | the agents themselves | `npm -g uninstall` / `rm ~/.local/bin/agy` (manual — you may use them directly) |
| **Masks the system `nginx.service`** — only when no nginx was active or enabled before install; an nginx you already run is never touched | a freshly apt-installed distro unit would auto-start and grab `:80`; ShellTeam runs its own `--user` nginx | `uninstall.sh` unmasks it |
| `loginctl enable-linger` | keeps `--user` services running after logout / at boot | `uninstall.sh --purge` disables it |
| **Public deploys only** (`--remote` / `--domain`): installs **Caddy**, writes `/etc/caddy/Caddyfile`, sets a strong `OWNER_TOKEN` | automatic TLS for your URL | `uninstall.sh` leaves Caddy (it's a shared proxy); remove manually if unused |

## Portable sessions — the one carve-out (session *state*, not config)

The purity guarantee covers agent **configuration and behavior** — not the
session *state* you deliberately move between agents. When you switch a slot's
model **across agent families mid-conversation** (Claude→Codex, etc.), ShellTeam
translates the conversation into the target CLI's native session format and
writes exactly one native session file so the target agent resumes it as its own:

| Target | File written |
|---|---|
| Claude | `~/.claude/projects/<cwd-encoded>/<new-uuid>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<new-uuid7>.jsonl` |
| Antigravity | none — `agy` keeps conversations in its own store (switching *into* Antigravity is not yet supported) |
| OpenCode | imported via `opencode import` (its own store) |

Stated precisely:
- It happens **only on an explicit user switch** — never during normal cockpit
  operation, which writes nothing into these dirs.
- The file contains **only your own conversation data**, and is exactly the kind
  of file each CLI creates itself on every normal run (no ShellTeam-specific
  markers in the agent store).
- The **source session is never mutated** — a switch produces a *new* session id
  in the target store; the original stays intact and usable.
- An audit/lineage record of each handoff is kept in ShellTeam's own directory,
  `~/.shellteam/sessions/<csfId>.json` — not in any agent store.

See [docs/decisions/20260702-portable-sessions.md](decisions/20260702-portable-sessions.md).

## What ShellTeam never touches

- Your coding-agent **config**: `~/.claude.json`, `~/.codex/config.toml` &
  `~/.codex/auth.json`, `~/.gemini/settings.json`, `~/.gitconfig`, `~/.bashrc`.
  (Session *state* is the one carve-out above — config and behavior are not.)
- Anything you create or change *through* ShellTeam — your repos, deploys, installed
  packages, prod changes. That's the product, and it's yours to manage (with git and
  VM snapshots, the same as any box). ShellTeam neither tracks nor reverts it.

## Network egress

ShellTeam only reaches the network when *you* drive it. The one piece that phones
home is **in-product feedback**: when you click "Send feedback" in the dashboard
and submit, the box POSTs your report (text, voice transcript, screenshots, and
basic environment metadata) to the maintainer relay at `feedback.shellteam.sh`,
which files it as a Linear issue. The box ships **no maintainer secret** — a
proof-of-work header gates the public relay instead. Nothing is sent unless you
submit the form. Point `FEEDBACK_RELAY_URL` at your own relay/webhook, or set it
empty in `.env`, to redirect or disable this entirely.

## Migrating off an older build

Early OSS builds *did* inject ShellTeam's template into `~/.claude` / `~/.claude.json`
(overwriting hooks/MCP/permissions and seeding a bogus `projects/-home-user` dir).
The current edition never does this. If you ran an older build, revert the leftovers
once — backed up, reversible, surgical:

```bash
uv run python scripts/cleanup-legacy-agent-config.py --dry-run   # preview
uv run python scripts/cleanup-legacy-agent-config.py             # apply (backs up first)
```

## Security boundary

The box itself is the security boundary, not a container inside it. The owner gets
full box access — that's the point (deploy to prod, read real logs, manage the
machine). Want a smaller blast radius? Run ShellTeam on a dedicated VM. The auth
boundary is `OWNER_TOKEN` (required on any public bind). See [SECURITY.md](../SECURITY.md).

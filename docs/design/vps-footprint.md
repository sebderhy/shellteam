# ShellTeam's VPS footprint — the "OS layer" design

**Status:** accepted direction (2026-06-29), implementation pending.
**Audience:** anyone touching install, agent spawning, or agent config.

## TL;DR — the principle

ShellTeam should be an **additive layer on top of the VPS, not a mutation of it.**

1. **Never write to the user's coding-agent config.** `~/.claude`, `~/.codex`,
   `~/.gemini`, `~/.config/opencode`, `~/.gitconfig`, `~/.bashrc` are the user's.
   ShellTeam composes its additions (MCP servers, skills, hooks, persona) **at
   agent-launch time** via CLI flags / env, layered in memory, persisted nowhere.
2. **Keep ShellTeam's own state in ShellTeam's own namespace** (`$STATE`,
   `~/.shellteam/`). Removable as a unit.
3. **The box/VM is the security boundary, not a container inside it.** The owner
   gets full access — that's the product. Want a smaller blast radius? Run
   ShellTeam on a dedicated VM. (OSS stays Docker-free except the Steel browser.)
4. **Reversibility is scoped to ShellTeam's own install footprint**, never to what
   the user does *through* ShellTeam.
5. **Guests are the one exception** that needs a hard boundary (see §5).

Net effect: run `claude` in your terminal → your config. Run it through ShellTeam
→ your config **+** ShellTeam's layer, composed at launch, nothing persisted. The
cockpit agent differs from your terminal agent only by an explicit, visible layer.

## 1. The problem this replaces

`api/services/agent_config.py` (`_setup_claude_config` / `_setup_secondary_agent_configs`),
called by `processes.py:_materialize_config` on every `start_computer` (dashboard
load / proxy auto-start), writes ShellTeam's **Cloud** config template into the
owner's real `$HOME`:

| File | Damage |
|---|---|
| `~/.claude/settings.json` | merges perms (shipped invalid `mcp__…(*)` rules) + **overwrites the user's hooks** |
| `~/.claude.json` | **overwrites** MCP servers |
| `~/.claude/CLAUDE.md` | injects/overwrites marked sections |
| `~/.claude/projects/-home-user/memory/` | seeds a **bogus** dir (`-home-user` is a *Cloud* container path) |
| `~/.claude/skills/`, `~/.codex/`, `~/.gemini/`, `~/.config/opencode/` | writes configs + symlinks |
| `~/.gitconfig` | sets git identity if absent |

This is Cloud logic (throwaway containers need seeding) wrongly applied to OSS,
where the user already has a setup. It caused three real bugs we hit while
dogfooding: invalid MCP permission rules (Claude skips them with warnings), hooks
pointing at a nonexistent `/opt/claude-config/` (PreCompact + every Bash call
failing), and the cockpit agent "not having the same context" as a terminal agent.

**Fix direction:** stop materializing into user config; move ShellTeam's additions
to a launch-time layer (below). Delete the injection rather than patch what it
writes.

## 2. Launch-time layering — per agent

All four CLIs support composing config at launch, via different primitives:

| Agent | Mechanism | Quality |
|---|---|---|
| **Claude** | `--plugin-dir <dir>` (skills + commands + hooks + MCP as one bundle) + `--mcp-config <file>` + `--settings <file>` + `--append-system-prompt[-file]` + `--add-dir` | ★ purpose-built |
| **Codex** | `--profile <name>` → **layers `$CODEX_HOME/<name>.config.toml` on top of the user's base config**; `-c key=value`; `$CODEX_HOME` | ★ clean layering |
| **Gemini** | settings precedence (system/user/workspace) + system-settings-path env + `--allowed-mcp-server-names` | ◐ clunkier (and being replaced by Antigravity CLI — see §7) |
| **OpenCode** | `OPENCODE_CONFIG` env → config file; project `opencode.json` (and it's the managed agent ST controls) | ◐ workable |

**Universal fallback:** ShellTeam spawns every agent as a child process with a
controlled env, so it can point each CLI's config-home (`CODEX_HOME`, Gemini's
settings path, `OPENCODE_CONFIG`) at a ShellTeam-owned dir. Prefer the *additive*
flags (so the user's own config still loads); fall back to config-home only where
a CLI offers no layering.

ShellTeam's bundle lives in e.g. `$STATE/shellteam-agent/` (a Claude plugin dir,
a Codex profile toml, an OpenCode config, …), built/refreshed by the installer and
the control plane — never copied into the user's dotfiles.

## 3. Tiers of footprint, and "control vs warn"

Three categories, each with its own rule:

1. **ShellTeam's own stuff** — `shellteam-*` systemd units, `$STATE`, the Steel
   container, the nginx config, the launch-layer dir. Namespaced and removable.
   Fine — this is the "OS" installing itself.
2. **The agent layer** — MCP, skills, hooks, persona, keys. **Additive + composed
   at launch; never written into user dotfiles.** (Keys already pass via env.)
3. **Genuinely global changes** — apt packages (nginx, node), masking system
   nginx. Can't be additive → **disclose + make reversible.**

**Control first, warn for the residue.** Minimize blast radius by design; a warning
is for unavoidable tier-3 items, never a license to clobber tier-2. Leaning on
warnings to excuse dotfile mutation kills the "run it on your real VPS" pitch.

## 4. Reversibility — scoped

Two different things, do not conflate:

- **ShellTeam's own install footprint** — bounded and known → an `uninstall.sh`
  that removes its services, dirs, launch-layer, and lists the tier-3 global
  changes it made. *This* is worth building.
- **What the user does *through* ShellTeam** — deploys, package installs, file
  edits, prod changes. Unbounded, and the whole point. **Not ShellTeam's job to
  track or revert** — that's what VM snapshots and git are for.

## 5. Security boundary — the box, not a container

The catastrophe ("someone catches a link → in my box") is an **auth** failure;
fix it with auth (OWNER_TOKEN, single-use 5-min enrollment codes, Tailscale-first/
private-by-default), not by sandboxing away the product's value. The value *is*
full box access (deploy to prod, read real logs, install packages, manage the
machine). A Docker'd ShellTeam either can't do that or maps in everything until the
sandbox is decorative. So: **owner = full box; the VM is the wall.** One box = one
owner's ShellTeam.

**Guest mode is the lone exception.** It's implemented (`guest-bridge.mjs`,
`/ws/guest`, `guest.html`, `~/guest-config.json`) but **off by default**. A guest is
an external person chatting with the cockpit agent in a restricted, isolated,
rate-limited session scoped to `~/public/`. Today its boundary is **soft** — a
prompt preamble + allow/deny rules + hooks — running as the owner's uid on a
full-access box. A jailbreak/prompt-injection could overstep.

- **Now:** a loud warning at activation (in `guest-config.json` and a runtime log
  on every guest session start). Done.
- **Before guest mode is promoted / used for anything sensitive:** a **hard**
  boundary — a separate restricted uid/namespace for guest sessions, or a
  tool-allowlist enforced by hooks rather than prompt text.

(Note: the owner-enrollment link grants *full* access and is the real "leaked link"
risk — mitigated by single-use + 5-min TTL. Distinct from guest mode.)

## 6. Knowledge layer & dreaming process

Same principle. The knowledge layer is ShellTeam **data**, not user config:

- Lives in **`~/.shellteam/knowledge/`** (ShellTeam namespace), never `~/.claude`.
- Agents *read* it via the launch-layer (the plugin / profile / appended prompt
  points them at it) — ShellTeam never edits the user's `CLAUDE.md`.
- The dreaming/consolidation process writes **only** to `~/.shellteam/knowledge/`.

It's the flagship reason the launch-layer architecture is worth doing: persistent
memory is what makes ShellTeam an OS layer rather than a launcher. See STC for the
current knowledge-layer + dreaming implementation to port.

## 7. Implementation plan (phased) — DONE (Gemini deferred)

1. ✅ **Claude launch-layer + stop writing user config.** Built `agent_layer.py`,
   which stages a session-only **plugin** (skills + hooks + MCP) + persona under
   `~/.shellteam/agent-layer/`. The cockpit and managed terminal load it via
   `--plugin-dir` + `--append-system-prompt-file` (`agent-layer.mjs:claudeLayerArgs`).
   `processes.py` no longer calls `_setup_claude_config`. Verified: `~/.claude` /
   `~/.claude.json` byte-identical across a materialize; cockpit agent sees skills
   + persona + MCP **alongside** the user's own config.
2. ✅ **One-time cleanup** — `scripts/cleanup-legacy-agent-config.py` (backed up,
   reversible) reverts the old `~/.claude` injection *and* ShellTeam-written
   `~/.codex/config.toml` / `~/.config/opencode/opencode.json`.
3. ✅ **Secondary agents.** Codex layers via `-c` overrides plus a
   ShellTeam-owned skills HOME overlay (`build_codex_overrides` →
   `codexLayerArgs`) — additive on the user's `config.toml`, no write. OpenCode
   uses `OPENCODE_CONFIG` (merges with the user's config). Antigravity uses a
   ShellTeam-owned workspace plugin added per session with `--add-dir`; it writes
   nothing to `~/.gemini`. The OSS path calls neither `_setup_claude_config` nor
   `_setup_secondary_agent_configs`.
4. ✅ **`uninstall.sh` + `docs/FOOTPRINT.md` manifest** + INSTALL.md uninstall
   section listing the tier-3 global changes.

Superseded by this direction: the interim `agent_config.py` patches (self-healing
merge, hook-path rewrite) and the `claude-config/settings.json` MCP-rule fix — keep
only the one-time cleanup logic from them.

## 8. Open / future

- **Guest hard-isolation** before guest mode is promoted (§5).
- Decide where the launch-layer bundle is built (installer vs control plane) and
  how updates propagate without touching user files.

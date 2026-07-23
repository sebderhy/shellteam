# Architecture

How ShellTeam turns one Linux box into a cockpit for coding agents. For install
steps see [INSTALL.md](../INSTALL.md); for the threat model see
[SECURITY.md](../SECURITY.md); for what ShellTeam touches on the box see
[FOOTPRINT.md](FOOTPRINT.md).

## The pieces

Everything runs natively on the host as `systemd --user` services — no database,
no per-user tenancy, and no container boundary between the agents and the VPS
(by design; the agents were already yours and already had the box).

| Service | Port | What it does |
|---|---|---|
| `shellteam-api` (FastAPI) | `127.0.0.1:8000` | Control plane: dashboard, auth, subdomain proxy, terminal WS, `/internal/ai` key proxy |
| `shellteam-ai-chat` (Node) | `127.0.0.1:3456` | The cockpit: chat UI + one adapter per coding agent CLI |
| `shellteam-nginx` | `127.0.0.1:80` | File server: `~/` (owner-gated), `~/public` (world), `/_editor` Monaco SPA |
| `shellteam-steel` (Docker, opt-in) | `127.0.0.1:3000` | Steel browser + bundled Chromium — the only Docker dependency; enabled by `./install.sh --full` (or `MODULES=browser` in `.env`) |
| Caddy (public deploys only) | `:80/:443` | TLS for `APP_DOMAIN` + `*.APP_DOMAIN`, proxies everything to `:8000` |

## Request flow

```
Internet → Caddy (TLS) → FastAPI :8000
                           ├── APP_DOMAIN/*            → dashboard + API routes
                           │     └── unmatched paths   → the owner's ~/<path> via nginx
                           │         (owner-token gated; dotfiles denied; only ~/public
                           │         and published reports are open)
                           └── <name>.APP_DOMAIN/*     → SubdomainProxyMiddleware
                               <name>-<port>.APP_DOMAIN/* → forward to localhost:<port>
```

**File URLs are main-domain paths**: `https://APP_DOMAIN/tmp/report.html` serves
`~/tmp/report.html`. The catch-all behind every real route is
`proxy.serve_owner_file`. `SubdomainProxyMiddleware` (in `api/main.py`)
intercepts subdomain hosts at the ASGI level, before route matching, and
forwards to the file server or a local port.

## Auth model (single-user)

One owner controls the whole box; identity is fixed from the environment
(`OWNER_ID`/`OWNER_USERNAME`/`OWNER_EMAIL`). Two secrets:

- **`OWNER_TOKEN`** — the auth boundary for every request from outside
  (Bearer header, `?token=`, or the `shellteam_token` cookie; constant-time
  compared in `api/services/auth.py`). Empty = localhost-trust mode; required
  on any public bind.
- **`SHELLTEAM_AI_TOKEN`** — an HMAC secret for `/internal/*`: in-box tools
  (skills, the cockpit) call the control plane with it to use LLM/media APIs
  without provider keys ever leaving the host.

The planned split-credential upgrade (HttpOnly master cookie, derived read-only
file credential, short-lived signed share links) is specced in
[decisions/20260702-split-credentials.md](decisions/20260702-split-credentials.md)
— not yet implemented.

## The cockpit and its agent adapters

`computer/ai-chat/` wraps each coding-agent CLI in a `CodingAgent` adapter
(`lib/*-agent.mjs`) that spawns the CLI in headless/JSON mode and translates its
event stream into one cockpit protocol. `lib/agents/registry.mjs` is the single
source of truth: per agent it declares the model-match rules, adapter class,
terminal spawn args, and capabilities (`rewind`, `resume`, `cliOwnsHistory`).
Adding an agent = one registry row + one adapter file.

Model routing lives in `config/models.json` (read by both the Python control
plane and the cockpit) — add a model there, restart, done.

**Portable sessions** (`lib/portable/`): conversations translate through a
canonical format into each CLI's *native* session-file format, so switching a
tab's model across agent families hands the full conversation to the target CLI
and it resumes it as its own. Same-family switches just `--resume`.

## The agent launch-layer (the zero-footprint rule)

ShellTeam **never writes to the owner's coding-agent config** (`~/.claude`,
`~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.gitconfig`, …). Its additions
are rendered once under `~/.shellteam/agent-layer/` by
`api/services/agent_layer.py` and loaded **at spawn time only**. The canonical
harness is one rendered prompt, one skill tree, and one MCP server map; each
cockpit agent receives that same content through its native adapter:

- **Claude Code**: `--plugin-dir` (session-only plugin with the canonical skills
  and Claude lifecycle hooks), `--mcp-config` (additive), and
  `--append-system-prompt-file`.
- **Codex**: additive `-c` overrides (MCP + developer prompt) and a
  ShellTeam-owned, cockpit-only `HOME` overlay that exposes the canonical skills;
  `CODEX_HOME` still points at the user's real auth/config.
- **Antigravity**: `--add-dir` adds a ShellTeam-owned workspace plugin containing
  the same rules, skills, and translated MCP configuration.
- **OpenCode**: `OPENCODE_CONFIG` supplies the same prompt, skills, and MCP map,
  merging with the user's config.

Native tool/event systems and lifecycle hooks remain provider-specific; the
shared contract is the agent-visible prompt, skills, MCP access, and scoped
knowledge injected into each one.

So a cockpit-launched agent = the user's own config **plus** ShellTeam's layer;
a hand-run `claude` in SSH is bit-identical to a box without ShellTeam.

## Key files

| Path | Purpose |
|---|---|
| `api/main.py` | App init, middleware, CSP, dashboard routes |
| `api/config.py` | Owner identity, `OWNER_TOKEN`, `APP_DOMAIN`, `DATA_DIR`, runtime |
| `api/routers/proxy.py` | Subdomain proxy + owner-file catch-all + port forwarding |
| `api/routers/terminal.py` | WebSocket terminal (xterm.js ↔ host shell) |
| `api/services/agent_layer.py` | Builds the additive launch-layer |
| `computer/ai-chat/server.mjs` | Cockpit server (WS protocol, slots, OAuth flows) |
| `computer/ai-chat/lib/session-manager.mjs` | Slot lifecycle, history, portable handoff |
| `computer/ai-chat/lib/agents/registry.mjs` | The agent registry |
| `config/models.json` | Model catalog (single source of truth) |
| `install.sh` / `uninstall.sh` | Native installer / reverser |
| `deploy/` | systemd unit + nginx templates rendered by install.sh |

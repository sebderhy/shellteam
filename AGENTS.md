# AGENTS.md

Guidance for coding agents working in this repository — the single source of
truth for every agent (`CLAUDE.md` is a one-line import of this file).

## Overview

ShellTeam (OSS edition) — a **single-user, self-hostable command center for coding
agents**. It turns one Linux box into a cloud computer you drive through a cockpit
of coding agents (Claude Code, Codex, Antigravity, OpenCode). The control plane runs **natively**
on the host as `systemd --user` services — no database, no per-user tenancy. The
**only** Docker dependency is the opt-in Steel browser container (part of `--full`);
the default install is fully Docker-free.

> This is the OSS edition. The multi-tenant **Cloud** edition (Docker isolation,
> Supabase, Stripe, per-user containers) is a separate codebase; the two diverge.
> Do not reintroduce Cloud concepts (containers, Supabase, billing tiers) here.

To install it, follow **[INSTALL.md](INSTALL.md)**.

## Stack

- **Backend:** Python 3.12 + FastAPI (async, uvicorn), bound to `127.0.0.1:8000`.
- **Cockpit:** ai-chat Node service on `:3456` (`computer/ai-chat/server.mjs`).
- **File server:** nginx on `:80` (serves `~/public`, file API, `/_editor`).
- **Browser (opt-in module):** Steel browser **Docker container** on `:3000`
  (bundles its own Chromium). The only Docker dependency; `--full` adds it
  (granular control: `MODULES=` in `.env`).
- **Reverse proxy (public deploys):** Caddy with automatic TLS for `APP_DOMAIN`
  and `*.APP_DOMAIN`.
- **Package managers:** `uv` (Python), `npm` (Node).

## Commands

```bash
# Run API locally (dev)
uv run uvicorn api.main:app --host 127.0.0.1 --port 8000

# Run tests
uv run pytest
uv run pytest tests/test_proxy.py              # single file
uv run pytest tests/test_proxy.py::test_name   # single test

# Install dev dependencies (uv sync --group dev doesn't work)
uv pip install pytest pytest-asyncio respx

# Full native install (provisions deps + systemd --user services)
./install.sh                  # PURE CORE (no modules — zero agent injection);
                              #   --minimal is an explicit alias for this default
./install.sh --full           # persona + browser + dreaming modules (the full experience)

# Manage the running stack
systemctl --user restart shellteam-api shellteam-ai-chat shellteam-nginx
journalctl --user -u shellteam-ai-chat -f
```

## Architecture

Everything runs on the host — there is no container boundary between the agents
and the VPS, by design (see [SECURITY.md](SECURITY.md)).

### Request flow

```
Internet → Caddy (TLS) → FastAPI :8000
                           ├── APP_DOMAIN/*            → dashboard + API routes
                           │     └── unmatched paths   → the owner's ~/<path> via the nginx file
                           │         server (owner-token gated; dotfiles denied; only ~/public
                           │         and published reports are open)
                           └── <name>.APP_DOMAIN/*     → SubdomainProxyMiddleware → file server / port-forward
                               <name>-<port>.APP_DOMAIN/* → forward to localhost:<port> (agent-built apps)
```

**File URLs are main-domain paths**: `https://APP_DOMAIN/tmp/report.html` serves
`~/tmp/report.html` (`proxy.serve_owner_file` — the catch-all behind every real
route). This is the convention the agent-layer persona teaches. The
`<owner>.APP_DOMAIN` file subdomain still works but is no longer the canonical
form — see [docs/decisions/20260702-main-domain-file-urls.md](docs/decisions/20260702-main-domain-file-urls.md).

`SubdomainProxyMiddleware` in `api/main.py` intercepts subdomain requests at the
ASGI level (before route matching) and delegates to `proxy.proxy_subdomain()` or
`proxy.proxy_websocket()`. It must run before the `StaticFiles` mount, otherwise
`/static/*` on subdomains would 404. Requests whose host is in `MAIN_HOSTS`
(`APP_DOMAIN`, `localhost`, `127.0.0.1`, `VPS_IP`, in `api/config.py`) are served
as the dashboard + owner files.

### The dashboard (`/`)

`GET /` serves `frontend/dashboard.html` — a thin tabbed iframe shell: **Agents**
(the ai-chat cockpit), **Terminal** (`/terminal`), **Files** (nginx `/_files/`),
**Browser** (`/browser` CDP screencast), **Settings** (inline). The owner identity
and cockpit URL are injected server-side at serve time via the `__OWNER_USERNAME__`
and `__COCKPIT_URL__` placeholders (single-user: identity is known server-side, so
there is no client-side profile fetch). It does **not** redirect to the cockpit.

### Auth model (single-user)

- One owner controls the whole box. Identity is fixed from the environment
  (`OWNER_ID` / `OWNER_USERNAME` / `OWNER_EMAIL` in `api/config.py`) — no database,
  no per-request user lookup.
- **`OWNER_TOKEN`** is the auth boundary, deployed as a **credential split**
  (`docs/decisions/20260702-split-credentials.md`): the master rides an HttpOnly
  **host-only** `shellteam_token` cookie on the dashboard origin (or a Bearer
  header); content subdomains carry only `shellteam_files`, a derived HMAC
  credential that can read files and nothing else (cockpit-port access is
  additionally Origin-gated). Sharing mints signed expiring `?sig=&exp=` links
  (`GET /api/auth/share`). `?token=` is NOT a general auth param — it is redeemed
  exactly once on `GET /` into cookies and scrubbed. All compares are
  constant-time (`api/services/auth.py`). When `OWNER_TOKEN` is **empty**, the box
  is assumed localhost-trusted and all requests pass. On any public
  (non-localhost) bind, `OWNER_TOKEN` is required.
- **`SHELLTEAM_AI_TOKEN`** is a separate HMAC secret for the `/internal/ai/*`
  proxy — in-box tools call the control plane with it to use LLM/media APIs without
  the keys ever leaving the host. Auto-generated by `install.sh`.

### Agent config — the additive launch-layer (DO NOT inject into user dotfiles)

ShellTeam is an **additive layer**, not a mutation of the box: it **must never
write to the owner's coding-agent config** (`~/.claude`, `~/.claude.json`,
`~/.codex`, `~/.gitconfig`, …). This is a hard rule — see
[docs/design/vps-footprint.md](docs/design/vps-footprint.md) and
[docs/FOOTPRINT.md](docs/FOOTPRINT.md).

- ShellTeam's additions (skills, hooks, MCP servers, persona) are built into a
  launch-layer under `~/.shellteam/agent-layer/` by `api/services/agent_layer.py`
  (`build_agent_layer` / `canonical_mcp_servers`), refreshed on `start_computer`
  (`processes.py:_materialize_config`) and at install time.
- **The layer is module-gated** (`MODULES=` in .env; the *purity gate*, see
  `docs/decisions/20260704-purity-gate-modules.md`). Empty (default) = pure core:
  the builder deletes every injection artifact and cockpit agents spawn
  bit-identical to hand-run CLIs — pinned by contract tests
  (`tests/test_purity_gate.py`, `computer/ai-chat/test/purity-contract.test.mjs`).
  Modules: `persona` (system prompt + skills + hooks + docs MCP), `browser`,
  `composio`, `linear`, `dreaming` (`KNOWN_MODULES` in `api/config.py`).
  The builder writes a `layer.json` manifest that the Node
  spawners (`agent-layer.mjs`) gate every flag on. One core-mode exception:
  OpenCode keeps a provider-only `opencode.json` (credential plumbing).
  Never add an unconditional spawn flag — gate it through the manifest.
- **Claude Code** loads it purely via flags: the cockpit (`claude-cli-agent.mjs`)
  and the managed terminal (`agents/registry.mjs`) call `claudeLayerArgs()`
  (`computer/ai-chat/lib/agent-layer.mjs`) to add `--plugin-dir` (a session-only
  plugin bundling skills + hooks + MCP) and `--append-system-prompt-file`. So a
  cockpit `claude` == the user's config **plus** ShellTeam's layer; a hand-run
  `claude` is untouched. `--dangerously-skip-permissions` is always passed, so the
  layer carries no `permissions` block (it'd be moot).
- **Codex** gets the layer via `-c` overrides spliced at spawn
  (`agent_layer.py:build_codex_overrides` → `codex/overrides.json`, consumed by
  `codexLayerArgs()` in `agent-layer.mjs`) — additive on the user's `config.toml`,
  no write. **OpenCode** gets it via `OPENCODE_CONFIG` (set in `session.mjs`
  `getCliEnv()`, pointing at `agent_layer.py`'s `opencode.json`) — merges with the
  user's config. **Antigravity** gets it via `--add-dir` (`antigravityLayerArgs()`
  in `agent-layer.mjs`) pointing at a ShellTeam-owned workspace plugin
  (`~/.shellteam/agent-layer/antigravity-workspace`) that carries the same prompt,
  skills, and MCP servers — nothing is written to `~/.gemini`.

### Key files

| Path | Purpose |
|---|---|
| `api/main.py` | App init, middleware, CSP, dashboard routes, router registration |
| `api/config.py` | Single source of truth for owner identity, `OWNER_TOKEN`, `APP_DOMAIN`, runtime |
| `api/services/auth.py` | `OWNER_TOKEN` verification (single-user) |
| `api/dependencies.py` | Request auth dependency (the one owner) |
| `api/routers/proxy.py` | Subdomain proxy (HTTP + WebSocket), auth gate, port forwarding |
| `api/routers/terminal.py` | WebSocket terminal (xterm.js ↔ host shell) |
| `api/routers/ai_tools.py` | `/internal/ai` proxy (STT voice input, OpenCode's Fireworks relay) |
| `api/routers/internal.py` | Internal endpoints (TLS `check-domain`, etc.) |
| `api/services/agent_layer.py` | Builds the additive Claude launch-layer (`~/.shellteam/agent-layer/`) — never user dotfiles |
| `api/services/agent_config.py` | Shared agent-config templates + secondary-CLI config helpers used by the launch-layer builder |
| `computer/ai-chat/lib/agent-layer.mjs` | `claudeLayerArgs()` — the `--plugin-dir`/`--append-system-prompt-file` flags the cockpit + terminal pass |
| `uninstall.sh` / `docs/FOOTPRINT.md` | Remove ShellTeam / the audited manifest of what it touches |
| `frontend/dashboard.html` | Tabbed cockpit shell served at `/` |
| `frontend/terminal.html`, `frontend/browser.html` | Terminal + browser-screencast pages |
| `computer/ai-chat/` | The ai-chat cockpit (Node service on `:3456`) |
| `deploy/systemd/*.service` | `systemd --user` unit templates (rendered by `install.sh`) |
| `deploy/nginx/shellteam.conf` | File-server nginx config template |
| `install.sh` | Native installer (idempotent) |
| `Caddyfile.example` | Caddy reverse-proxy config for public deploys |

## Conventions

- Python: type hints everywhere, async/await, Black formatter.
- Use `uv` for Python dependency management; Pydantic models for API schemas.
- Let errors propagate — no try/catch unless there's a specific recovery strategy.
- Keep code DRY — extract shared logic into reusable functions.
- Tests use `conftest.py` fixtures that mock auth across all import paths; the test
  suite hard-sets `APP_DOMAIN=localhost` for hermeticity.
- **Log generously, never swallow errors.** Every significant operation must log
  its outcome — success at INFO, failure at WARNING/ERROR with details. Silent
  failures are unacceptable: failures must be visible in `journalctl` so issues can
  be diagnosed from logs alone.

## Environment Variables

All runtime config lives in `.env` (copied from `.env.example` by `install.sh`;
gitignored — never commit values). The important ones:

| Variable | Purpose |
|---|---|
| `APP_DOMAIN` | Domain the dashboard is served on (`localhost` for laptop use) |
| `OWNER_TOKEN` | Auth boundary — required on any public bind |
| `OWNER_ID` / `OWNER_USERNAME` / `OWNER_EMAIL` | The single owner's identity |
| `VPS_IP` | VPS public IP, so direct-IP hits count as the dashboard host |
| `API_PORT` / `AI_CHAT_PORT` | Control plane / cockpit ports (8000 / 3456) |
| `SHELLTEAM_AI_TOKEN` | HMAC secret for `/internal/ai` (auto-generated) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | LLM keys (set what you use; Antigravity signs in via its own Google OAuth) |
| `FIREWORKS_API_KEY` | Enables the OpenCode agent (relayed via `/internal/ai/fireworks`) |
| `ELEVENLABS_API_KEY` | Voice input (speech-to-text) in the cockpit + feedback |
| `COMPOSIO_API_KEY` | Optional — enables Composio app integrations over MCP (off by default) |
| `LINEAR_API_KEY` | Needed by the `linear` module (Linear MCP) |

## Deployment & Verification

- **ALWAYS verify your work end-to-end before telling the user it's ready.** The
  user is NOT your QA.
- After changes: restart the affected service, hit `/health`, load the dashboard,
  check `journalctl`. For frontend changes, confirm the page renders and tabs load.
- Use `curl` (or a browser) to verify — never assume "it should work."
- Before tagging a release, run the gates in [docs/release-qa.md](docs/release-qa.md).
  They exist because each one caught a bug that a fully green suite had missed;
  a fix for that class of bug belongs there, not only in `test/`.

## Git

- Never commit or push to `main` without asking first.
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.

## Decision Docs

Every important decision (architecture, tooling, product direction, deliberate
"not doing X") must be recorded in `docs/decisions/YYYYMMDD-<slug>.md`: context,
the decision, the reasoning with evidence as of that date, explicit "what would
make us revisit" triggers, and consequences — so that months later anyone can
understand why it was made and revert it confidently. Write the doc proactively
when a discussion ends in a real decision. First example:
[20260702-not-using-acp.md](docs/decisions/20260702-not-using-acp.md).

## Memory

Be proactive about continuous learning. After a long or corrective interaction,
ask yourself: why was it needed, could it have been avoided, and what note to
self (in the right config/markdown file) would prevent a repeat? The long-term
goal is to work as autonomously as a trusted 10-year partner on this project.

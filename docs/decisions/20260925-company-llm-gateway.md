# Company LLM gateway, and nothing leaves the box for analytics

Date: 2026-09-25. Status: accepted.

## Context

An owner ran the OSS edition on a corporate VDI. The company routes
coding agents through its own LLM gateway: its `.env` held
`ANTHROPIC_BASE_URL` (the gateway) and `ANTHROPIC_AUTH_TOKEN` (a company token,
not an `sk-ant-` key). ShellTeam got it wrong in three ways:

1. Pasting that token as "Claude API key" filed it as the **OpenAI** key: the
   server guessed the provider from the key prefix. The same save deleted the
   ChatGPT login (`~/.codex/auth.json`), silently moving Codex to metered
   billing. Fixed separately (e5040ce): the tab decides the provider, and a key
   save never touches a login.
2. Claude showed "not connected" and its models were hidden, because only an
   `ANTHROPIC_API_KEY` counted as a credential. Yet the gateway variables did
   reach the CLI (the cockpit inherits `.env`), so what the badge said and what
   ran had drifted apart.
3. Nothing stopped a gateway URL from reaching a CLI without the gateway's own
   token. Claude Code would then send the owner's personal OAuth login to that
   host.

The same audit found the Composio SDK POSTing a metric to
`telemetry.composio.dev` on every traced call (its default), on any box with a
Composio key.

## Decision

- **A company gateway is its own auth mode, `gateway`, per family.**
  - Claude uses `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (or
    `ANTHROPIC_API_KEY`, for gateways that take x-api-key).
  - Codex uses `OPENAI_BASE_URL` + `OPENAI_API_KEY`. Codex's provider block
    points at that URL.
  - It can also be entered in Settings, "Use a company gateway". The Settings
    file (0600) wins over `.env`, the same rule API keys follow.
- **A gateway wins over a subscription.** This is not really a choice: Claude
  Code itself ranks an env token above its OAuth login. And a company that
  configures a gateway means for its traffic to go there. The UI says so
  ("ahead of any subscription or API key").
- **A URL alone is not a gateway.** With no token, the URL is ignored,
  stripped from every spawn env, and logged loudly. Outside gateway mode, the
  gateway variables are always stripped.
- **Every path follows the same rule:**
  - cockpit agents, the managed terminal, and the Settings connection test
    (which now also passes Codex its provider block);
  - quota checks (skipped: the gateway tracks limits);
  - nightly dreaming. `api/services/llm_gateway.py` mirrors `session.mjs`, and
    a test pins the shared Codex provider strings.
- **A gateway or key failing never marks the subscription expired.** Only a
  subscription-mode failure can.
- **Corporate proxy and CA variables** (`HTTPS_PROXY`, `NO_PROXY`,
  `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`) already pass through `.env` to every
  CLI. They are now documented in `.env.example`.
- **Composio SDK telemetry is off, process-wide.** `allow_tracking=False` only
  covers the context that built the client, so the SDK's ContextVar default is
  replaced. A test fails if an SDK upgrade moves that switch.

## Not doing (yet)

- Bedrock / Vertex / Foundry (`CLAUDE_CODE_USE_BEDROCK`, ...). Those need model
  IDs mapped per cloud; wait for a user who needs them.
- Per-gateway model catalogs. The picker still offers the catalog IDs. A
  gateway that serves other names can map aliases with Claude Code's
  `ANTHROPIC_DEFAULT_*_MODEL` variables, or the owner picks a model it serves.

## Revisit if

- A company wants its gateway to *coexist* with personal subscriptions for some
  folders: that would need a per-workspace route, not a per-family one.
- Claude Code changes its auth precedence (an env token no longer beating
  OAuth). The `gateway`-first rule must then follow the CLI, or the badge
  drifts again.
- The Composio SDK exposes a process-wide telemetry switch: use it and drop the
  ContextVar swap.

## Consequences

- A corporate box works with the `.env` it already has: Claude shows "Company
  gateway", and its models are pickable.
- Verified end to end against a fake gateway that recorded every request:
  real `claude` and `codex` CLIs, a cockpit chat turn for each, the Settings
  form plus Test, and dreaming's `claude -p`. Each reached the gateway with
  the company token and nothing else.

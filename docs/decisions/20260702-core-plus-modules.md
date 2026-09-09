# Decision: core + opt-in modules — the zero-footprint core is the v1 default

- **Date:** 2026-07-02
- **Status:** Accepted
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [vps-footprint.md](../design/vps-footprint.md), [FOOTPRINT.md](../FOOTPRINT.md)

## Context

ShellTeam has two identities pulling in opposite directions:

1. **A pure UX lift** — a mobile-grade cockpit for the coding agents already on
   your VPS: voice notes, image upload, live URLs, cross-agent session
   switching. Its selling point is *restraint*: it should be invisible to the
   agents.
2. **A plug-and-play harness** — superpowers layered onto those agents: the
   shared Steel browser, Composio app connections over MCP, nightly "dreaming"
   knowledge consolidation, eventually a Chief of Staff agent.

Today the additive launch-layer (`api/services/agent_layer.py` +
`claudeLayerArgs()` in `computer/ai-chat/lib/agent-layer.mjs`) is passed
**unconditionally**: every cockpit-spawned agent gets ShellTeam's plugin dir,
system-prompt append, and MCP servers. That's additive (never writes user
dotfiles) but not invisible — a cockpit `claude` behaves differently from a
bare one. Options considered: (a) ship everything on (status quo), (b) delete
the harness features and ship pure UX, (c) two separate versions
(`--minimal` vs full-default), (d) one product: a guaranteed-pure core plus
independently removable opt-in modules.

## Decision

**Option (d): one codebase, core + modules. The core is the install default
for the v1 launch.**

1. **Core (default)** ships with a *guarantee*: no Docker, no database, no MCP
   servers added, no skills, no system-prompt injection — an agent run through
   the cockpit is **bit-identical in config and behavior** to a bare run. The
   guarantee is enforced by a contract test in CI, not prose.
2. **Modules (opt-in at install or later):** `browser` (Steel, the one Docker
   container), `composio` (app connections over MCP), and `dreaming` (nightly
   knowledge consolidation + the dashboard Knowledge tab). `--full` enables the
   complete supported set; `MODULES=` provides granular control. Each module
   documents exactly what it adds in FOOTPRINT.md and is individually removable.
3. **The agent-layer code is NOT deleted** — it becomes the module mechanism.
   With no modules enabled, no layer flags are passed at all. The core's
   path→URL guidance moves from the persona prompt to **client-side
   linkification** in the cockpit (render agent-emitted file paths as their
   URLs), which works uniformly across all four agents with zero footprint.
4. **Post-launch roadmap order (deliberate):** Chief of Staff **before**
   chat-reachability (Telegram → WhatsApp) — a box worth messaging needs
   someone home to answer. Then sandbox mode, guest hard-boundary, worktrees,
   ACP.

## Why (state of the world on 2026-07-02)

- **The guarantee is a differentiator, not a limitation.** The mobile-wrapper
  competitors (Happy Coder, Omnara) and orchestrators don't offer "your agents
  can't tell it's there." It's also the strongest honest answer to HN's
  security scrutiny: ShellTeam-core adds **zero new agent privilege** — the
  audience already runs these agents on their VPS; the only new surface is the
  cockpit.
- **Half the "full" tier doesn't exist in OSS yet.** Code audit (2026-07-02):
  browser and Composio are real; dreaming and chat-reachability are cloud-only
  (`push.py` returns 404 in OSS; the dream cron is never installed). Making
  "full" the default would make the launch post describe defaults we can't
  demo. Dreaming is being ported for v1 *as a module*; chat-reachability comes
  after Chief of Staff.
- **"Two versions" doubles the QA matrix and splits the docs.** Modules keep
  one product, one installer, one test suite (core hard + each module on top).
- **Default-core keeps the launch claims clean:** "no Docker" without an
  asterisk (the browser container is opt-in), no MCP supply chain in the
  default security story.

**Precision carve-outs** (state these exactly, or a commenter catches us):

1. The guarantee covers agent **configuration and behavior**, not session
   *state*. Portable sessions writes synthesized session files into
   `~/.claude/projects` / `~/.codex` / `~/.gemini` — the user's own
   conversation data, written only on an explicit switch, in files the CLIs
   create themselves on every normal run.
2. The claim is **"your agents can't tell"**, not "the VPS can't see it" —
   the box obviously carries systemd units, nginx, and `~/.shellteam` state.

## What would make us revisit

1. **Adoption data post-launch** shows most users enable all modules
   immediately → flip the default to full (one-line change, and a natural
   "v2: modules on by default" announcement).
2. **The core alone fails to differentiate** against pure-UX wrappers and the
   harness features prove to be the actual draw → lead with modules.
3. **Module gating causes real support burden** ("why doesn't the browser
   work?" → they never opted in) → reconsider default-on with a
   first-run chooser.
4. **A module can't honor per-module footprint documentation** (e.g. a future
   module needs invasive config) → that feature doesn't ship as a module, or
   the framework changes.

## Consequences

- New build items: gate `claudeLayerArgs()` (and Codex/OpenCode equivalents)
  behind module state; client-side linkification; the bit-identical contract
  test; installer `--with-*` flags.
- The dreaming port (cloud `dream.py` → `systemd --user` timer + Knowledge
  tab) targets the module layer from day one.
- FOOTPRINT.md gains a per-module section; `uninstall.sh` must remove modules
  cleanly.
- Marketing language changes: "minimal vs full" is dead; it's "the cockpit,
  plus opt-in superpowers."

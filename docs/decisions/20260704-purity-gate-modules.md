# Decision: the core-purity gate — MODULES=, the `persona` module, and the split-credential deltas

- **Date:** 2026-07-04
- **Status:** Implemented (roadmap items B2 + B3, shipped together)
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [20260702-split-credentials.md](20260702-split-credentials.md),
  [20260702-core-plus-modules.md](20260702-core-plus-modules.md)

## Context

The v1 launch post promises: *"no MCP/skills/system-prompt injection — agent
behavior bit-identical [to a hand-run CLI], with a contract test proving it."*
Until now `claudeLayerArgs()` injected the full layer unconditionally — the
"minimal version" of ShellTeam did not exist. Implementing the gate forced four
design decisions the roadmap had left open.

## Decisions

### 1. `MODULES=` in .env is the gate; empty = pure core (the default)

`api/config.py` parses `MODULES` (comma-separated). `build_agent_layer()` builds
only what the enabled modules need and **deletes** the artifacts of disabled ones
(purity means *absent*, not merely unreferenced — a downgraded box actually sheds
the layer). It always writes a `layer.json` manifest; the Node spawners
(`agent-layer.mjs`) gate every flag on that manifest, so Node never parses .env.
A manifest promising a missing artifact errors loudly; a manifest-less layer is
treated as legacy (artifact presence decides) with a loud rebuild warning.

### 2. A `persona` module carries the assistant experience

The roadmap named browser/composio/dreaming as modules but never said where the
system prompt, 18 skills, hooks, and docs MCP (context7/deepwiki) live. They
can't be "core" (they ARE the injection the guarantee removes) and they can't
vanish (they are the full-experience product). So: module `persona` = appended
system prompt + skills/hooks plugin + context7/deepwiki MCP + Codex doc-fallback
+ OpenCode skills/instructions. `install.sh --full` = `persona,browser`.
The browser default also flips **off** (pure core), per the roadmap; the
installer keeps `--no-browser` as a back-compat no-op and re-provisions the
Steel container on re-runs whenever `.env` lists the browser module.

### 3. OpenCode keeps a provider-only config in core — the one documented exception

`OPENCODE_CONFIG` still points at the layer's `opencode.json` in core mode, but
it contains ONLY the proxied Fireworks provider block (no MCP, no skills, no
instructions — an empty-list sentinel in `_build_opencode_json` omits the keys
entirely). Rationale: the provider is credential plumbing without which the
OpenCode agent cannot run at all; it does not alter agent *behavior*. The purity
contract test pins exactly this shape. If OpenCode ever gains first-class
env-var provider config, drop the exception.

### 4. Split-credential deltas discovered during implementation

The accepted design said "the derived credential cannot reach the cockpit" and
implied all iframes just switch to it. Two realities forced deltas:

- **The cockpit lives on a port subdomain** (`<owner>-3456.<domain>`), where a
  host-only master cookie can never arrive. Resolution: the derived credential
  DOES unlock the cockpit port, but only behind an **Origin allow-list** (no
  Origin header — non-browser; or Origin ∈ {dashboard, the port's own origin}).
  An XSS'd served page fetching/WS-ing the cockpit sends its own subdomain
  Origin and is refused — riding is blocked, and HttpOnly blocks stealing.
  Mutations on generic app ports get the same Origin gate; the bare file host is
  strictly read-only under the derived credential.
- **The editor writes files** (`/_api/` POSTs), which must require the master.
  Resolution: the Files tab iframe moved from `<owner>.<domain>/_editor/` to the
  dashboard origin's `/_editor/` (the main-domain catch-all already proxies it),
  so saves ride the host-only master same-origin. The subdomain editor still
  loads read-only.

**Known residual (documented in SECURITY.md):** hostile HTML opened as a
top-level page on the dashboard origin is same-origin with the dashboard and can
act as the owner while open. No credential scheme stops same-origin XSS; what
the split achieves is that nothing durable can be *stolen* anymore. Full fix =
a separate content domain (googleusercontent pattern) — post-v1 candidate.

## What would make us revisit

1. Claude Code/Codex gain a first-class "extra config file" env var that makes
   flag-splicing unnecessary — simplify the manifest gate.
2. OpenCode supports env-var provider credentials — remove the core-mode
   provider-only exception (decision 3).
3. The Origin allow-list breaks a legitimate cross-subdomain flow (e.g. a
   multi-port app the owner builds) — consider a per-port opt-out, not a
   weakening of the cockpit rule.
4. A second person needs scoped access — signed links and the single owner
   credential stop being enough; that's real multi-identity auth, not a wider
   owner token.

## Consequences

- Fresh installs are pure core; Seb's box gets `MODULES=persona,browser,composio,linear`.
- The purity contract is enforced in CI: `tests/test_purity_gate.py` (builder)
  + `computer/ai-chat/test/purity-contract.test.mjs` (spawn argv, pinned exact).
- The persona's URL-teaching is no longer load-bearing: the cockpit linkifies
  `~/…` and `$HOME/…` paths in agent output client-side (marked postprocess),
  so core-mode agents still yield clickable file links.
- SECURITY.md's credential section rewritten around the split model.

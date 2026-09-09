# Decision: do NOT adopt ACP as the agent integration layer (for now)

- **Date:** 2026-07-02
- **Status:** Accepted
- **Deciders:** Seb + Claude (cockpit session)
- **Follow-up ticket:** [SHE-35 — generic ACP adapter as a fifth registry row](https://linear.app/shellteam/issue/SHE-35/feat-generic-acp-agent-client-protocol-adapter-as-a-fifth-registry-row)

## Context

ShellTeam's cockpit drives four coding agents (Claude Code, Codex, Gemini CLI,
OpenCode) through hand-written adapters (`computer/ai-chat/lib/*-agent.mjs`,
~1,500 lines total) that spawn each CLI's headless JSON-streaming mode and
translate its events into our protocol format. The
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP, Zed, Sept 2025)
standardizes exactly this client↔agent boundary — JSON-RPC over stdio, "LSP for
coding agents" — and by mid-2026 it has clearly won adoption: JetBrains rolled it
out across their IDE suite, Zed + JetBrains run a shared agent registry (Jan
2026), and dozens of agents support it natively (Gemini CLI, Qwen Code, Kimi
CLI, Cline, OpenHands, Goose, GitHub Copilot, OpenClaw, …).

The question: should we replace our adapter layer with ACP to simplify agent
orchestration?

## Decision

1. **Keep the four first-class adapters.** Claude Code, Codex, Gemini CLI, and
   OpenCode stay on direct CLI integration.
2. **Add ACP later as an *addition*, not a replacement** — one generic
   `AcpAgent` adapter as a fifth registry row, unlocking the long tail of
   ACP-compatible agents (SHE-35).

## Why (state of the world on 2026-07-02)

We checked the ACP spec (agentclientprotocol.com + the
`zed-industries/agent-client-protocol` repo) against what
`session-manager.mjs` + our adapters actually do:

| Capability we rely on | ACP status (July 2026) |
|---|---|
| Stream turns, tool calls, plans | ✅ core protocol, maps cleanly onto our protocol events |
| Resume after cockpit restart | ⚠️ `session/load` is an **optional** per-agent capability |
| Model switching mid-session | ❌ not in spec (only `session/set_mode`; no `session/set_model`) |
| Session forking | ❌ not in spec — Claude's `--fork-session` / OpenCode's `--fork` unreachable through ACP |
| Rewind | ❌ not in spec (ours truncates Claude's session JSONL on disk) |
| Cost/usage per turn | ❌ not in spec (only `stopReason: max_tokens`) — per-tab cost display would go dark |
| Session listing | ❌ not in spec (ours scans session files on disk) |
| Additive agent-layer injection (`--plugin-dir`, `--append-system-prompt-file`) | ⚠️ depends on what each adapter package exposes |

Two structural problems on top of the missing features:

- **Our two most important agents are not native.** Claude Code and Codex are
  reachable only through **Zed-maintained adapter packages**
  (`claude-agent-acp` built on the Claude Agent SDK, `codex-acp`). Going
  through them means: a third-party dependency in the hot path, feature lag
  behind the CLIs, and — critically — losing control over CLI flags, which is
  how ShellTeam's core "additive launch-layer" works (we must never write to
  user dotfiles; the layer is injected purely via spawn flags).
- **ACP doesn't shrink the orchestration layer.** Slots, tabs, history
  persistence, watchdog restarts, cost tracking, the delegation broker — all of
  that is ours regardless. ACP only standardizes the event translation, which
  is the *stable, already-working* part of the stack.

Also relevant: we had just designed two features (same-session model switching
fixing SHE-14, and conversation forking via native `--fork-session`/`--fork` +
a transcript-handoff primitive for cross-family moves) that depend precisely on
the CLI-level control ACP would take away.

## What would make us revisit

Reopen this decision if any of these become true:

1. **Native ACP support in Claude Code and/or Codex** (from Anthropic/OpenAI,
   not a Zed adapter) with arg pass-through preserving our layer injection.
2. **The spec grows** model selection, fork/rewind, or usage/cost reporting
   (watch the `_meta` extension point becoming a de-facto standard for these).
3. **Gemini first:** Gemini CLI's native `--acp` mode surpasses our current
   Gemini adapter (the weakest of the four — no resume). Swapping just Gemini
   to ACP is the cheapest experiment and a natural first migration.
4. **Maintenance pain:** if keeping four bespoke adapters in sync with CLI
   changes starts costing more than the features they protect.

## Consequences

- We keep ~1,500 lines of per-agent translation code and remain responsible for
  tracking each CLI's JSONL format changes.
- New-agent requests beyond the big four should be answered with the generic
  ACP adapter (SHE-35), not a fifth bespoke adapter.
- Positioning when SHE-35 lands: "first-class support for the big four, plus
  any ACP-compatible agent."

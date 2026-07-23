# Decision: one shared harness for every cockpit coding agent

- **Date:** 2026-07-10
- **Status:** Implemented; not deployed as part of this change.
- **Deciders:** Seb + ShellTeam team
- **Related:** [ARCHITECTURE.md](../ARCHITECTURE.md), [FOOTPRINT.md](../FOOTPRINT.md), [20260704-purity-gate-modules.md](20260704-purity-gate-modules.md)

## Context

ShellTeam presents Claude Code, Codex, Antigravity, and OpenCode as interchangeable
cockpit agents. Previously they were not actually launched with equivalent
ShellTeam context: Claude had the full plugin layer, Codex and OpenCode had parts
of it, and Antigravity had none. Switching providers could therefore silently
change an agent's instructions, skills, or MCP tools.

## Decision

Render the content-carrying harness exactly once under
`~/.shellteam/agent-layer/`:

1. one hydrated system prompt;
2. one canonical skill tree;
3. one canonical MCP server map; and
4. one runtime composition path for folder knowledge and dynamic MCP additions.

The adapters transport that same content through each supported CLI's native
session-only extension surface:

| Agent | Transport |
|---|---|
| Claude Code | plugin + additive MCP config + appended prompt |
| Codex | additive config overrides + a ShellTeam-owned `HOME` skills overlay |
| Antigravity | workspace plugin loaded with `--add-dir` |
| OpenCode | additive `OPENCODE_CONFIG` |

The Codex overlay leaves `CODEX_HOME` on the real owner configuration, and the
Antigravity plugin lives under ShellTeam's own workspace. The workspace plugin
is also materialized for knowledge-only and project-scoped Linear setups, so
runtime additions do not bypass Antigravity. Neither approach modifies a user's
agent dotfiles or repository.

## Scope of “same”

The contract is byte-identical, agent-visible content: prompt, skills, MCP names
and configuration, and scoped project knowledge. Tests compare the rendered
artifacts and the final composed prompt that each adapter receives.

CLI-native behavior is deliberately not normalized: providers have different
built-in prompts, tool protocols, session formats, streaming, and lifecycle-hook
schemas. Claude's existing pre-tool secret sanitizer and pre-compaction archive
are platform safety/observability mechanics, not alternative instructions or MCP
access. We will add a cross-provider operational behavior only when it can be
implemented safely and semantically equivalently for all four.

## Evidence

Antigravity accepts a workspace plugin discovered via `--add-dir`; a live probe
loaded a ShellTeam-style rule from that session-only directory. Its plugin format
supports rules, skills, and MCP configuration. Codex discovers skills from the
global `$HOME/.agents/skills` location, and a disposable `HOME` overlay was
verified to load a ShellTeam skill while retaining the normal `CODEX_HOME`.

The shared Context7 MCP uses the `context7-mcp` stdio executable. Native
`install.sh` now installs `@upstash/context7-mcp`, matching the existing Docker
image, so the common configuration is usable on new or upgraded boxes. It also
uses Antigravity's official Linux installer for the `agy` binary—the CLI the
registry launches—instead of continuing to install the retired Gemini CLI.

## What would make us revisit

1. A CLI gains a better session-only extension surface that removes an adapter
   workaround, especially Codex global-skill discovery or Antigravity workspace
   plugin discovery.
2. A provider cannot faithfully load a new canonical harness capability; then
   either add an equivalent adapter or deliberately exclude that capability from
   the shared contract rather than creating provider drift.
3. A future agent becomes a first-class cockpit provider; it must pass the same
   harness parity tests before it is enabled.

## Consequences

- New prompt, skill, or MCP additions belong in the canonical harness, not in a
  provider-specific adapter.
- Pure-core mode continues to remove every harness artifact; the only exception
  remains OpenCode's provider-only config.
- Every native installer run will ensure the Context7 executable is present; the
  current running host is unchanged until Seb chooses to deploy or rerun the
  installer.

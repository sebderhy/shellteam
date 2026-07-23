# Decision: portable sessions via a canonical format + native session writers

- **Date:** 2026-07-02
- **Status:** Accepted (implemented — roadmap B1, week 1)
- **Deciders:** Seb + Claude (cockpit session)
- **Plan:** `docs/plans/active/20260702-portable-sessions.md` (internal)
- **Builds on:** SHE-14 (same-family switches keep the session)

## Context

The Show HN post's spike is: *start a task with Claude Code, switch to Codex on
GPT-5.5 mid-conversation, and it picks up with full context.* Each CLI persists
history in its own native format (Claude project JSONL, Codex rollout JSONL,
Gemini chat JSONL, OpenCode SQLite), and their session ids are family-specific —
so before this, a cross-family model switch had to reset the conversation.

Three architectures were on the table:

1. **Transcript-in-first-message handoff** — dump the prior conversation as text
   into the target agent's first user message. Rejected by Seb: coding-agent LLMs
   are tuned to a specific *shape* of prior messages; a wall-of-text prefix is not
   that shape, and it pollutes the visible conversation.
2. **N×N direct translation** — a converter for every ordered family pair. O(N²)
   converters, no shared invariants, quadratic maintenance as agents are added.
3. **Canonical format + N importers + N exporters** — normalize any session into
   one interchange representation (CSF), then synthesize a *native* session file
   the target CLI resumes as its own. O(N) legs, one place for shared rules.

## Decision

**Adopt architecture 3 — a Canonical Session Format (CSF) plus writers that
synthesize native session files** — with one refinement discovered during
implementation:

**The importer is a single path, not N native importers.** The cockpit's
`history.mjs:readSessionForReplay` *already* normalizes every family into one
uniform protocol-message stream (it parses Claude's native JSONL directly, and
for Codex/Gemini/OpenCode it reads the cockpit-owned protocol JSONL that
SessionManager writes as those turns happen). So CSF is built **once** from that
stream (`protocolToCsf`) rather than parsing four native schemas. The N×N matrix
collapses to **1 importer + 4 exporters**, reusing proven, already-tested code.

Design invariants (each testable; see the plan §2): turn-boundary only; the only
writes to agent stores happen on an explicit switch and contain only the user's
own data (the FOOTPRINT carve-out); every `tool_call` gets a `tool_result`
(synthesize an interrupted result otherwise); reasoning is dropped on export
(unforgeable across APIs, never crosses a family); the source session is never
mutated (a switch mints a new native id); no silent fallback — a failed handoff
reverts the model and leaves the source intact and usable.

## Reasoning (evidence as of 2026-07-02, this box)

- **All four CLIs resume hand-synthesized session files** — proven live: Claude
  2.1.198, Codex 0.142.4, Gemini 0.49.0, OpenCode 1.17.12 each resumed a
  fabricated session and recalled a planted codeword. **No checksums or crypto
  validation exist in any of the native formats.**
- **Reasoning blocks are unforgeable but omissible** on all three APIs (Anthropic
  400s forged signatures; OpenAI reasoning items omissible; Gemini ships dummy
  signatures) — so exporters simply drop them.
- **Historical tool calls with unknown names are accepted**; the only hard API
  invariant is strict `tool_call ↔ tool_result` id-pairing — hence `pairCheck()`.
- The uniform-importer refinement removes ~3 native parsers of maintenance and
  makes the import path identical to what the cockpit already renders, so a
  session translates exactly as the user saw it.
- Prior art confirms the shape: casr (canonical IR, per-path PASS/FAIL harness),
  OpenAI's first-party `external_agent_sessions` crate (Claude→Codex mapping),
  and opencode's `MessageV2.toModelMessages` `differentModel` lossy-conversion
  rules.

## Consequences

- New module `computer/ai-chat/lib/portable/{csf,import,export,index}.mjs`; the
  cockpit's `set_model` calls `switchSlotModel()`, which runs `handoffSession()`
  on a cross-family switch and renders a visible handoff marker.
- A per-handoff CSF artifact is persisted to `~/.shellteam/sessions/` for
  lineage/upgrade triage (records the source→target CLI version pair).
- Quality is gated by `scripts/golden-portable-sessions.mjs` — the 12-pair
  real-CLI matrix, re-run before merge, before launch on a fresh box, and after
  any CLI upgrade.
- Reasoning does not carry across a family boundary (cold cache, no thinking
  replay). The turn-boundary switch + the visible marker set that expectation;
  same-family switches keep full native fidelity by never exporting (SHE-14).

## What would make us revisit

- A CLI adds session-file **validation or signing** (checksums, signed rollouts)
  → that leg's exporter must produce a verifiable file, or fall back.
- An official cross-agent **import API** appears (e.g. Codex ships
  `external_agent_sessions` as a stable CLI) → prefer it for that leg.
- A leg **breaks twice in a row** on CLI upgrades → consider pinning or an
  adapter-owned format probe.
- We decide to make **CSF the cockpit's single history store** (uniform
  replay/search, orchestration) — that is a separate decision (plan fast-follow
  #4), not implied here.

# Structured agent questions via the permission control protocol

**Date:** 2026-09-01
**Status:** Accepted

## Context

Claude Code and Codex can steer users with multiple-choice questions
(AskUserQuestion / request_user_input). The cockpit runs agents headless, and a
mid-2026 verification found that NO headless CLI exposed a structured ask tool:
questions arrived as plain text, the turn ended, and the cockpit's existing
`ask_user` button UI was dead code. Seb asked for real pre-filled-choice
questions in the cockpit chat.

Re-verified 2026-09-01 against Claude Code 2.1.215 and Codex 0.147.0, the
landscape had changed on the Claude side only.

## Decision

**Claude Code:** the cockpit adapter registers a stdio permission handler
(`--permission-prompt-tool stdio`) *alongside* `--dangerously-skip-permissions`.
Verified behavior of that combination:

- Ordinary tools (Bash, Edit, …) still run without any prompt — the bypass
  keeps its meaning.
- Registering the handler is what puts `AskUserQuestion` into the headless
  tool list. Its calls arrive as `can_use_tool` control_requests
  (`requires_user_interaction: true`) that BLOCK the turn until we write a
  `control_response`.
- The answer is `behavior:"allow"` with
  `updatedInput: { questions, answers: { "<question text>": "<label>" } }`
  (array value for multiSelect; free text allowed). The turn then continues
  in-place — no resume round-trip.

Protocol choices:

- `ask_user` is emitted ONLY from the control_request (it carries the
  request_id an answer must reference); the old stream-path emissions were
  removed to prevent double-rendering.
- While a question is pending the adapter watchdog is disarmed — the CLI is
  waiting on a human, and a 5-minute silence is not a wedge. Re-armed on
  answer/deny.
- A normal user message while a question is pending DENIES the blocked call
  with an explanation ("the user replied in chat instead"), then delivers the
  message — typing over the buttons must never hang the CLI.
- Other `can_use_tool` requests are auto-allowed (preserves skip-permissions
  semantics); unknown control_request subtypes get an error response so the
  CLI never blocks on us.
- A clicked answer whose request is no longer pending (turn ended, agent
  restarted, replayed history) falls back to a normal chat message — a click
  is never lost. Pending questions replay as live blocks to reconnecting
  clients.

**Codex: not supported, deliberately.** Codex 0.147 has an experimental
`request_user_input` tool (`tools.experimental_request_user_input.enabled`),
but it is hard-locked to Plan mode (`error=request_user_input is unavailable in
Default mode`; the collaboration_mode config is not honored in exec), and
`codex exec` has no channel to answer mid-turn anyway. Codex keeps the existing
flow: it asks in plain text, the turn ends, the user replies normally.

**OpenCode / Antigravity:** no structured ask exists in their headless modes;
unchanged.

## What would make us revisit

- Codex ships `request_user_input` outside Plan mode, or the Codex adapter
  moves from `exec --json` to the bidirectional app-server protocol.
- Claude Code changes the control protocol shape (the adapter tests pin the
  current one and will go red).
- OpenCode's permission "ask" actions become reachable without disabling
  `--dangerously-skip-permissions`.

## Consequences

- Claude agents in the cockpit now genuinely pause and ask with clickable
  options (plus a free-text field), including across page reloads.
- Requires a Claude Code CLI recent enough to know `--permission-prompt-tool`
  (any 2026 build; ancient CLIs would fail at spawn with an unknown flag).
- The frontend answers over a new `answer_question` WS type; the old
  fill-composer path remains as the fallback for legacy/stale blocks.

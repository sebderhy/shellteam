# Codex runs through `codex app-server`, so a mid-turn message joins the turn

Date: 2026-10-25. Ticket: SHE-126.

## Context

In Codex's terminal UI, a message typed while Codex works joins the running
turn. In the cockpit it waited until the turn ended: the adapter ran
`codex exec --json` once per turn, which reads one prompt and has no input
channel after that. Since SHE-107 a mid-turn message was queued and run as its
own turn. On the demo seat (#18, 2026-10-23) a visitor's two follow-ups waited
22 minutes behind one long turn and were never read before the seat ended.

## Decision

The Codex adapter speaks `codex app-server --stdio`, the JSON-RPC protocol
Codex's own clients use, and sends a mid-turn message with `turn/steer`.

It keeps **one process per turn**, the exact lifecycle `codex exec` had: the
process starts the turn (`initialize`, `thread/start` or `thread/resume`,
`turn/start`), and its stdin is closed when `turn/completed` arrives, so it
exits. Everything built around that lifecycle stays as it was: the thread
writer lock and its retry (SHE-102), the spawn queue behind a dying process,
Stop as a process-group kill (SHE-90), overflow recovery (SHE-66), `/compact`
as a turn with `model_auto_compact_token_limit=1`, and the rollout file as the
context meter's source (SHE-68). App-server notifications are translated into
the same event shapes the adapter already read, since the exec stream is a
flattened form of the same protocol.

The SHE-107 queue remains for every moment a turn can't take input: before the
turn has started, during `/compact` or an overflow recovery, and a steer that
loses the race with the turn's end (refused, or accepted but never read).

## Why not a long-lived app-server per tab

It would hold the thread's writer lock while the tab is idle (a terminal
`codex resume` on the same thread would fail), keep one Codex process per open
tab, and need new idle-shutdown and restart logic. Per-turn processes cost
about 0.3 s of startup, the same as `codex exec`, and change nothing else.

## Evidence (codex-cli 0.159.2)

- A real turn steered during `sleep 25` read the message and answered both
  parts in one turn (`scripts/qa/codex-steer.mjs --scenario steer`).
- A thread created by `codex exec` resumes under app-server, recalls its
  context, compacts with `/compact`, and still recalls it afterwards.
- Pasted images arrive as `localImage` inputs and are read.
- `-c developer_instructions` applies to new threads only, under exec and
  app-server alike (Codex stores them with the thread), so nothing regressed.

## Revisit if

- Codex drops or renames `turn/steer`, or makes app-server non-experimental
  with a different shape (`codex app-server generate-ts` shows the protocol).
- Per-turn startup becomes noticeable, which would favour a pooled server.

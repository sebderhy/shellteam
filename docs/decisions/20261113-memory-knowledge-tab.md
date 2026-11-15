# The Knowledge tab answers three questions, and the cockpit keeps every launch text

*2026-11-13 · step 3 of the memory rebuild (K16, K17b) · code:
`frontend/knowledge.html`, `api/routers/knowledge.py`,
`api/services/memory/overview.py`, `told.py`, `agent-layer.mjs`
(`recordLaunchText`)*

## Decision

1. **One screen, three columns** (as in `mockup.html`): the tree with how
   full each card and essentials view is; what a chat was told; a night's
   changes with undo per change and for the whole night. On a phone and in
   the cockpit's side panel, one column at a time behind three tabs.
2. **Exact launch texts are kept by the cockpit.** Each time a folder's
   launch text changes, `agent-layer.mjs` stores it once
   (`~/.shellteam/memory/told/<hash>.md`) and appends one line to
   `told/launches.jsonl` (when, whose). A chat's text is the one in force for
   its folder when it sent its first message (its transcript's first line,
   else the tab's creation). Chats older than the records show the first
   text kept, labelled as possibly different.
3. **Undo goes through the nightly job's own functions** (`undo_night`,
   `undo_change`); the views are printed again at once. Refused while the
   job runs.
4. **The cockpit's Knowledge button passes the open chat** (`?chat=`), so
   the owner sees what that chat was told in one click from the chat.
5. The old file tree listing (`/api/knowledge/tree`) is removed.

## Why

- Recomputing "what a chat was told" after the fact would be a guess once a
  night has run; storing each distinct text costs a few kilobytes per change.
- Colour carries meaning only: a fill bar is amber near its limit (the job is
  choosing what stays) and green with room; each kind of change has its tag
  colour; an undone change is struck through.

## Revisit when

- `told/` grows past a few megabytes (then: drop texts no chat used for 90
  days).
- A chat's first message comes long after its tab was made and the owner
  sees the wrong text (then: the cockpit records the chat id at spawn).

## Consequences

- The cockpit must be restarted once for the records to start (the launch
  code is loaded at its start).
- A cockpit test (`antigravity-agent.test.mjs`) ran with the real home and
  wrote into the live memory; it now uses a throwaway home.

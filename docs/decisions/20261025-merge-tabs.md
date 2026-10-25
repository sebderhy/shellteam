# Merging tabs hands one agent the other's whole conversation

Date: 2026-10-25. Ticket: SHE-128.

## Context

Seb often forks a conversation or opens a new tab, and later finds two tabs
working on the same project (usually the same folder) without knowing about
each other: two workers that never talk.

## Decision

"Merge tab B into tab A" (drag B onto the middle of A and confirm, or B's tab
menu > Merge into). The cockpit renders B's full conversation, every message,
tool call and result, as a Markdown transcript under
`~/.shellteam/sessions/merge-*.md`. It then starts a turn on A with a
`<cockpit-notice>`: read what you need from that file, check the files, and tell
the user what B did, what you take over and what conflicts. B closes, and A
shows a "Merged in" marker. Both tabs must be idle.

## Why

- **No literal merge exists.** Neither Claude Code nor Codex nor any other CLI
  can load two conversations into one session, so one agent has to learn what
  the other did.
- **No summarizer.** The receiving agent reads the transcript and decides what
  matters, keeping judgment on the model side rather than in a cockpit
  summarizer that would lose detail.
- **Works across agents.** The transcript is plain text, built from the same
  importer forks and model switches use (`importSession`), so a Codex tab can
  merge into a Claude tab.
- **B closes.** A merge that leaves both tabs open is not a merge. B's
  conversation is still on disk and reopens from Resume.

## Revisit if

- Two workers in one folder collide before anyone thinks of merging. The
  companion idea is a warning at turn start when another tab is active in the
  same folder.
- A CLI gains a native way to import another conversation.

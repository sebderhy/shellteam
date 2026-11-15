# Agents look further with one command, and leave notes instead of editing memory

*2026-11-13 · step 3 of the memory rebuild (`docs/plans/active/knowledge/`,
K13, K14) · code: `api/services/memory/search.py`, `notes.py`, `cli.py`,
`bin/shellteam-memory`*

## Context

The launch text is short on purpose (a card, the essentials above it). The
exam after step 2 showed that about half of the recent facts agents missed
were in memory, on a record page the agent never opened. Agents also had no
way to pass something to the next chat of the day other than editing memory
files, which memory's one-writer rule forbids.

## Decision

1. **One command for every agent**: `bin/shellteam-memory`, named with its
   full path in the launch text's closing lines (`views/footer.md`, printed
   with the views). It runs with the system's Python and the standard
   library only, so Claude Code, Codex, OpenCode and Antigravity all reach it
   through their shell.
2. **`search WORDS [--all]`**, in this order: the facts of the level the
   chat stands at, the levels above, then past conversations of this project
   from every agent. Other projects only with `--all`, or when the chat
   stands in `~`, whose view is wide by design (K4). Each result shows its
   level and date; a conversation line also says who said it.
3. **Plain words, no index.** A result must hold all of one or two words,
   most of more. Conversations are searched where they are, with the nightly
   job's own line parsers (`reading.claude_said`, `codex_said`), so tool
   output, sub-agents and the job's own runs are never found. A byte search
   over 32 MB chunks finds candidate lines before any is parsed. Measured on
   the owner's box: 1.6 s from a project (381 MB of transcripts), 4 s from
   `~` (all 1.8 GB).
4. **`note TEXT`** files one or two sentences at the chat's level. Chats
   started later at that level see them under "today, not yet filed"
   (`today/<level>.md`, newest first within the `today` limit, older ones
   counted). The same safety check as facts refuses orders to agents and
   secrets. The nightly job reads the notes like a conversation, with the
   same write-less rules, and clears those it read; a failed batch keeps
   them.
5. **The exam** passes every source conversation of the question set to
   the agents under test (`SHELLTEAM_MEMORY_SEARCH_EXCLUDE`), and the
   memory-off arm refuses the command.

## Why

- A command beats a tool per agent: four agents, one implementation, and the
  launch text already reaches all four.
- No embeddings is a non-goal of the plan; plain words are explainable and
  the exam decides whether they are enough.
- Searching transcripts in place keeps a single source of truth: no second
  copy of every conversation to keep in step, and today's chats are found
  the same day.

## Revisit when

- The exam's lookup score stays under 70% for an agent that does run the
  search (then: better matching, or more text up front for that agent).
- A search takes more than about 5 s on a real box (then: an index built by
  the nightly job).
- Agents file many notes a day that the night leaves out (then: tighten the
  footer's wording).

## Consequences

- Employee sandboxes mount only the cockpit code, not the Python side: they
  keep the old pointer ("open a record page") until the command can run
  there. Their synced memory now includes their project's facts.
- Sub-area levels (step 4) will be picked up by `notes.level_here` and the
  search order without change: both use the store's levels.

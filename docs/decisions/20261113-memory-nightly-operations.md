# The nightly job reads by bookmark and writes by operation

*2026-11-13 · step 2 of the memory rebuild (`docs/plans/active/knowledge/`,
K5 to K8, K21) · code: `api/services/memory/reading.py`, `nightly.py`,
`night_report.py`*

## Context

The old nightly job kept one clock for the whole box, read the last 120
messages of each conversation cut to 700 characters each, and let the model
write lines that were appended to files. On the owner's box that stored about
33 lines a night, a third of what was said in the last two weeks never
reached memory (exam, recent facts: 65%), and nothing was ever replaced.

## Decision

1. **One bookmark per conversation**, a byte offset in the transcript file
   (a part id for OpenCode). A night reads what is behind each bookmark and
   moves it only past text whose batch succeeded. A conversation with no
   bookmark is read from 14 days before memory went live, so the first nights
   catch up on what the old job missed.
2. **A budget per night, never a cap.** `night_chars` (1,000,000 by default,
   a setting) is read oldest first. What is over stays behind its bookmark,
   is reported with its size and age, and is logged as an error from three
   days. Measured on the owner's box: a normal day is about 130,000
   characters, the busiest 320,000.
3. **Only what people and agents wrote.** Tool output, sub-agents, compaction
   summaries and harness notices are dropped by the reader, before any model
   sees them. Every candidate carries a quote; code checks the quote is in
   the text that was read, and drops the candidate otherwise.
4. **Scheduled runs are recognised by repetition.** Nothing on disk marks a
   run as scheduled. Rule: a headless run with one message, not a cockpit
   tab, whose opening equals another such run's. The first version ("one
   message and not a tab") was tried on the owner's data and wrongly held
   back a real one-message chat whose tab had been closed.
5. **The model chooses, code writes.** Extraction (one call per 45,000
   characters) returns candidates. Placement (one pass per level, at most 40
   candidates a pass) is shown every active fact of the level with its id
   and answers with operations: add, confirm, replace, drop, merge, retire,
   card, move. `ops.apply_ops` checks ids, the branch, safety and the quarter
   rule, all or nothing per pass.
6. **A failed level changes nothing.** Its candidates wait in
   `candidates.json`, at most three nights, then are dropped in the report.
7. **History is a local git repository** in `~/.shellteam/memory` (never
   pushed), one commit before and one after each night. `ops.jsonl` keeps the
   facts as they were, so a night or one change is undone with
   `python -m api.services.memory.nightly undo <run> [fact id]`.
8. **The review queue is gone** on a box whose tree is live: its entries
   become candidates on the first night.

## Why

- Bookmarks by offset make "read everything once" cheap: a 250 MB transcript
  kept open for months costs one seek.
- A cap that drops (OpenClaw: 240 messages a night) loses a busy day
  silently. A budget that carries over loses nothing and shows its backlog.
- Operations by id are the only way replace and merge can fire. Systems that
  let the model rewrite memory handled out-of-date facts right about half
  the time in the 2026 comparison cited in `design.md`.
- The quote check is cheap and removes both invention and anything that
  could only have come from tool output.

## Revisit when

- The backlog is not empty two mornings in a row on a real box.
- More than a few candidates a night are dropped for "its supporting
  sentence is not in the conversation" (the model paraphrases its quotes).
- A scheduled job is read (its opening changes every run) or a real chat is
  held back. The clean fix is then a registry of the sessions the cockpit
  starts.
- A level has so many facts that one placement pass no longer fits a model
  call (today the largest, `shellteam`, is about 60,000 characters).

## Consequences

- The old system is deleted (update below): the old nightly job, the old
  knowledge files at launch, the review queue, the acceptance page.
- Placement needs one model call per level with candidates each night. With
  the catch-up the first nights are larger than a normal one.
- Codex as the engine still depends on its read-only sandbox, which does not
  work on boxes without user namespaces. Unchanged by this step.

## Update 2026-11-13: the old system is deleted, the move is automatic

The owner's standing rule (2026-11-13): remove legacy code; no backward
compatibility unless he asks for it. So the old nightly job
(`dreaming.py` gather/extract, `knowledge_tree.py`), the old files at launch
(`composeKnowledge` in `agent-layer.mjs`), the persona's "edit the knowledge
files" section, the review queue's screen and API, the acceptance page
(`move_page.py`) and the empty old files seeded at every start are gone.

A box that has not moved yet does so on its first night
(`memory.switch.move_in`, called at the start of `nightly.run_night`): the old
files become facts, then the night reads as usual, and the report says what
was moved. A new box has nothing to move and starts empty. Until that first
night such a box launches agents with no memory: at most one night, accepted
over keeping two launch paths.

# Memory as facts and printed views

*2026-11-13 · ticket SHE-192 · plan: `docs/plans/active/knowledge/` (step 1)*

Replaces, where they disagree: `20260708-dreaming-v1.md` (the file layout and
the append-only apply engine), `20260710-dreaming-owner-pass.md` and
`20260710-dreaming-autonomous-review.md`. Still binding:
`20260903-dreaming-engine-choice.md` and "the nightly job runs on the owner's
subscription".

## Context

Measured on the owner's box: the nightly job only appended (2,522 additions,
no removal), the launch text carried the first 8,000 characters of each file
(the oldest part), facts had no date, source or identity, and every project
chat carried the owner's career notes. The owner approved a knowledge tree
that mirrors his folders (PRD 1, 2026-11-13). What was left to the builder:
storage, layout, how launch text reaches agents, how history is kept.

## Decisions

1. **One file of facts is the truth**: `~/.shellteam/memory/facts.jsonl`, one
   JSON object per line, loaded and saved whole by one writer. A few thousand
   short records do not need a database, and a text file diffs and backs up.
   A fact has an id, sentence, kind, folder, topic, first seen, last
   confirmed, sources, status and marks (on the card, essential, pinned).
   Nothing is deleted: a fact is replaced, retired, removed by the owner or
   blocked, and says which.
2. **Views are printed by Python only** (`api/services/memory/views.py`):
   `views/<level>/card.md`, `essentials.md`, `record/<topic>.md`, with the top
   level under `views/_top/`. Limits are applied at print time; the oldest
   unpinned line leaves a view that is over. The cockpit (Node) only joins
   files at launch: header, essentials of the levels above, the level's card.
   So no selection logic exists in two languages, and launch never cuts.
3. **Limits are settings** (`settings.json` under the memory root, defaults in
   `store.py`). An unknown key raises, so a typo cannot silently do nothing.
4. **The model chooses, code writes** (`ops.py`): add, confirm, replace, merge,
   move, card, retire, all by fact id. Checks: ids exist and are active, the
   pass stays on its own level and branch, a source is something the owner or
   an agent wrote, a new sentence is not an order or a secret, at most a
   quarter of a card's lines leave it in one run, pinned facts are the
   owner's. A failed check leaves the level exactly as it was.
5. **Undo is a log of before-images** (`ops.jsonl`: every applied batch with
   the changed facts as they were). `undo_run` puts them back. The design
   suggested version control for the folder; a before-image log is enough for
   "undo a night" and "undo one change" without a second tool, and it is in
   the same file format as everything else. Revisit if the owner wants to
   browse history by date.
6. **Owner hand edits are read back, never overwritten**. A manifest
   (`views/.printed.json`) keeps the hash and the fact behind every printed
   line. A changed file is read before anything is printed over it: a changed
   line is a pinned owner fact replacing the old one, a deleted line is
   removed for good, a new line is a pinned fact at that level. The Knowledge
   tab saves through the same path.
7. **The switch is one file**, `live.json`. Before it exists, agents get the
   old files and the old nightly job writes them. `SHELLTEAM_MEMORY=tree`
   lets one process (the exam) read the proposal earlier. Accepting runs the
   move once more, which reads only old lines it has not seen, so the owner's
   corrections to the proposal survive.
8. **Learning between the switch and the new nightly job** (K19): the existing
   extraction keeps running; its proposals are filed as facts at the level
   the conversations ran in, through the same checked operations
   (`intake.py`). A repeat confirms instead of adding. Step 2 replaces this.
9. **Employee boxes** get `views/<their project>/`, the header and the switch,
   nothing else. With no `_top` folder there, the same launch code finds a
   project card and no essentials.
10. **The persona's "knowledge files" section is dropped at launch once the
    tree is live** (it told agents to edit those files by hand). The persona's
    own-memory section stays until step 3 (K15).

## Things found while building

- The model sometimes labels a fact with a kind outside the list
  ("preference"). A fact is never dropped for that: unknown kinds map to the
  nearest known one.
- A model answer with text after the JSON object broke the first full move.
  `parse_json_object` now reads the first complete object.
- The move is long (about 2,800 old lines). Per-batch verdicts are cached
  and the per-level placement keeps a pending list, so a stopped move resumes.

## Revisit when

- Facts pass about 20,000 or more than one process must write: move to SQLite.
- The owner wants history by date or diffs between nights: put the memory
  root under git as the design suggested.
- Sub-area cards arrive (step 4): `Store.levels()` is the one place that
  decides which folders have a card.

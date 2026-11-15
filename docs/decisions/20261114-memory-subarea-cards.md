# Memory: sub-area cards (K18)

Date: 2026-11-14. Plan: `docs/plans/active/knowledge/` (step 4, SHE-195).

## Context

A project's card has a limit (8,000 characters to start). Printing keeps every
card inside its limit by taking the oldest lines off, so a big project's card
fills up and then loses lines that still matter to part of the project. The
PRD's answer (K18): when a card is full and a clear group of its facts is about
one sub-folder, that sub-folder gets a card of its own.

What the owner's box showed on 14 Nov, before this step: three project cards at
90% or more (93%, 97% and 90%). Only 5 of
2,184 active facts are filed below a project folder: the nightly job files a
fact where the conversation ran, and cockpit chats run at the project root. So
a split cannot wait for facts to arrive filed in a sub-folder. It has to find
the group among the project's own facts.

## Decision

- **Trigger.** After a night prints, a project or sub-area whose card is at
  90% of its limit or more (setting `split_when_full`), or lost lines to fit,
  *and* that changed tonight, is checked. It has to change tonight so the same
  card is not asked again every night. "Over its limit" in the PRD becomes
  "full", because printing never lets a card go over.
- **One model call per full level** gets the level's facts (with the folder
  each is filed under) and the real sub-folders of the project (up to 3 deep,
  no hidden, dependency or build folders). It answers "no group" with a reason,
  or one group: the sub-folder, the facts that move, and the card lines that
  hold for the whole project (the project's new essentials).
- **Code checks, all or nothing** (`ops.split`): the folder is one of those
  listed and lies below the level, is not hidden and is not named `record`
  (that name is where record pages print). The group has at least 6 facts
  (`MIN_SPLIT`), all active and at this level. No fact is in the group and in
  the essentials. A fact already filed deeper keeps its exact folder.
- **The sub-area list** is kept in `subareas.json` beside the facts. A sub-area
  is a level only while it holds an active fact. The split is one logged
  operation, so it is undone alone (`nightly.undo_split`, the Knowledge tab's
  Undo, `POST /api/knowledge/night/{run}/undo-split/{folder}`) or with its night.
- **Placement.** Candidates are placed at the nearest level with a card,
  sub-areas included. Each level's prompt uses its own limit. A project that
  has a sub-area may mark lines essential.
- **Printing.** A sub-area's card is titled `SUB-AREA`. Its Above section
  names each level whose essentials it receives. A parent lists only the levels
  directly below it. The launch side (`composeTree`) needed no change: it
  already gives a chat the essentials of every level above and the card of the
  nearest one.
- **Employee boxes** get the sub-areas of their branch with its facts.

## Why

- A model is needed to see that "the tab strip", "the composer" and "unread
  dots" are all about `computer/ai-chat`. The folder field alone does not show
  it today. Code still decides whether the answer stands, as for every other
  memory operation.
- 6 facts: below that, a sub-area card would mostly be pointers and headings,
  and the parent gains little room. The number is a starting value.
- 90%: the placement prompt already tells the model to make room when the card
  is nearly full, so cards rarely drop lines to fit. Waiting for that would
  mean waiting for loss.

## Revisit when

- A split the owner undoes, or a sub-area card that stays nearly empty: raise
  `MIN_SPLIT` or the threshold.
- Full cards that are never split while the owner's chats keep running in one
  sub-folder: file facts by the folders a conversation touched (evidence the
  night already prints for the extraction), so groups show in the folder field.
- The exam: a question about a sub-area answered worse from the sub-folder than
  from the project root.

## Consequences

- At most one extra model call per full, changed card per night (three cards
  on the owner's box today).
- The nightly report and the Knowledge tab show each split with its reason,
  the number of facts moved and the lines that became essentials, with Undo.

# One map of the cockpit, one layout, and a private count of what is used

Date: 2026-11-15 · Tickets: SHE-188, SHE-184, SHE-187, SHE-115, SHE-204

## Context

In 35 days, 25 UX tickets were each fixed on their own; nobody had decided
where things belong. The model button held eight unrelated things (model,
folder, reports, new chat, resume, fork, rewind, compact) next to an Info
button and a gear. On a phone the only way back to the chat list was a 30 px
arrow in a top corner, and the agent's name was an icon. Two layouts (a tab
row and the projects column) meant every header fix was made twice.

There was also no data. To place controls by use we could only read server
logs, which showed compact at 2.5 a day and rename at 1 a day (both filed
under "weekly" in the first draft), and said nothing about switching chats,
opening reports, or phone versus desktop.

## Decision

1. **Where a control lives follows how often it is used.** All the time:
   always on screen. Daily: one tap. Weekly or less: two taps, under a menu
   that says what it holds. This is the owner's rule for every later change.
2. **One button, one kind of thing.** The chat header holds four controls:
   the chat's title (it opens the chat menu: rename, move, compact, fork,
   rewind, new, resume, close, info), this chat's reports, the agent and
   model in words (it opens the model list and nothing else), and usage.
3. **Usage is one ring.** Outer arc: the plan. Inner arc: how full this
   conversation is. A click shows both in words with a Compact button, since
   compacting is a daily action. A key billed per use keeps a visible badge.
4. **Phone: a tap on the title goes back to the chats, a long press opens the
   chat menu** (owner's choice: going back is far more frequent). A swipe
   from the left edge also goes back. Daily targets are 44 px or more.
5. **The projects column is the only layout** (SHE-188). The tab row, its
   phone drawer, the Settings switch, `COCKPIT_LAYOUT` and the header folder
   pickers are removed. A chat's folder is its project: chosen when the chat
   starts, changed with "Move to a project", which keeps the conversation.
6. **Every state has a word**: Working, Waiting (its turn ended but work it
   started is still running), Needs you, Done. A question is never listed as
   Done, and an agent with background work is never listed as finished.
7. **Rare things leave the header**: agent sign-in, console mode and the
   shortcut list are in Settings (a Cockpit card) and in the jump box.
8. **The cockpit counts which controls are used** (SHE-204): a number per
   control name, per day, per screen, in `~/.config/shellteam/ui-use.json`.
   Names only, never text the owner wrote; nothing leaves the box.
   `bin/shellteam-usage` prints the ranking and the shelf each control
   belongs on. Any agent asked for a UX change reads it first.

## Why

- Frequency is the one placement rule that can be checked against data, so
  disagreements about "where should X go" end with a number.
- A title that is a menu costs no header room and puts the chat's actions on
  the thing they act on. A separate "..." button was the alternative; the
  owner chose the title.
- Counting locally is the only way to know what a single owner uses. A
  product whose claim is "nothing phones home" cannot use hosted analytics;
  a local file with fixed names keeps that claim true and auditable.
- Keeping two layouts doubled every header change and kept dead paths alive
  (the folder picker wiped a conversation when used).

## What would make us revisit

- `bin/shellteam-usage` shows a control on the wrong shelf for two weeks
  (for example the long press on a phone is used less than once a week while
  chat actions are used daily there): move it.
- A provider other than Claude Code starts reporting background work: wire
  it into `waitingOn` so its chats say "Waiting" too.
- Owners ask for the tab row back in numbers: the column can be hidden
  (Hide the column), which is the supported way to get the width back.

## Consequences

- Boxes that had `COCKPIT_LAYOUT=tabs` get the column on their next update,
  with no setting to go back.
- The dashboard still carries its tab buttons, unseen: they name the screens
  for the column's tools row. Removing them is a follow-up.
- Not built yet: a "Failed" state word, a per-helper list under "Waiting",
  counting inside the Reports, Knowledge, Files and Terminal pages.

# The projects column: agents grouped by project, and chats that can move

Date: 2026-11-11 · Ticket: SHE-168 · Shipped in v0.1.58 (opt-in)

## Context

The cockpit showed open chats as one row of tabs. Seb asked for the product to
feel like managing work by project: tabs grouped by the folder they run in,
with that project's Knowledge, Files and Reports next to them, and the general
tools (Terminal, Apps, Settings) moved aside.

Two facts from his own box shaped the design:

- He had 16 tabs open. A row cannot hold 16 names plus group headers, so the
  names were already cut to a few letters.
- Only 4 of the 16 ran in a project folder. The other 12 ran in the home
  folder. The reason was in the code: changing a tab's folder (`set_cwd`)
  reset its conversation, so nobody ever moved a chat once it had history.

## Decision

1. **A column on the left replaces the tab row** (`public/projects.js`,
   `projects.css`). Projects are listed with their agents; each agent shows
   what it is doing ("Working 4 min", "Has a question", "Done 12 min", or how
   long it has been quiet). Chats untouched for a week fold into "N older".
2. **A project is a folder under home with a name the owner chooses.** The
   name is editable, the path is shown next to it and is not. The list is kept
   in `~/.config/shellteam/projects.json` (`lib/projects.mjs`). A folder an
   agent works in becomes a project by itself. Home is never a project: its
   chats sit under "General ~" (renamed from "Not in a project" on 2026-11-12, SHE-169: Seb found the plain name with the home path clearer).
3. **A chat can be moved into a project and keeps its history**
   (`session-manager.moveSlot`). The conversation is carried into a fresh
   session of the same agent in the new folder, the way a fork does it. With
   "the agent moves in" (on by default) the agent is then asked to bring its
   files and write the project's first notes (`lib/project-move.mjs`). For a
   brand-new project it can also create a private GitHub repository.
4. **A moved chat's reports follow it.** The cockpit records each move in
   `~/.config/shellteam/moved-sessions.jsonl`; the report catalog applies the
   moves on top of its attribution index when it lists reports.
5. **Knowledge, Files and Reports open beside the chat**, in the dashboard's
   existing side panel, filtered to the project. They do not replace the chat.
6. **The column lives inside the cockpit frame**, not in the dashboard shell.
   The cockpit owns all tab state (unread, rename, drag, merge, fork); drawing
   it a second time in the dashboard would have meant mirroring all of it over
   `postMessage`. So the cockpit frame stays on screen and the dashboard opens
   its other screens to the right of the column, whose width the cockpit
   reports.
7. **It is opt-in for now.** Settings -> Layout stores `COCKPIT_LAYOUT` in
   `.env` so every device follows. Default is `tabs`.
8. **The word stays "agents".** Not "employees": a tab is a conversation, and
   invented names or avatars would read as a toy.

## Why these choices

- Vertical because a column holds any number of full names and a status next
  to each; a row holds neither. It is also already the phone layout.
- Same-agent move through the portable-session path because a session belongs
  to the folder it started in for every CLI; pointing a session at another
  folder is not something the CLIs support, a fresh session seeded with the
  history is. Proven by hand with Claude (the moved agent recalled an earlier
  fact and named its new folder) and pinned for the cockpit-owned history
  path by test.
- The agent does the moving in because it is the only one who knows which
  files it created. The request states the goal and leaves the details to it.
- Moves are a file both sides read, not an API call from the cockpit to the
  control plane, so a move never depends on the control plane being up.
- Opt-in because this is the largest change to the main screen since launch.

## What would make us revisit

- If owners keep most chats in "General" after moving is this easy,
  the project model is wrong for them, not the screen.
- If the default flips to `projects`, the tab row and its phone drawer can be
  deleted (about 400 lines), along with the switch.
- Report attribution still needs a Claude transcript with a Write call. If
  per-project Reports turn out thin for Codex or shell-written reports,
  attribution should move to write time.
- The move is proven on Claude and on the cockpit-owned history path. Codex,
  OpenCode and Antigravity use the same portable-session export a fork uses,
  but a real moved chat on each should be checked before the default flips.

## Consequences

- New owner state: `projects.json` and `moved-sessions.jsonl` under
  `~/.config/shellteam/`. Nothing is written to any agent's own config.
- `set_cwd` (the tab row's Workspace picker) still resets the conversation.
  In the projects layout that menu item is hidden; moving is the way.
- Two latent display bugs surfaced and were fixed on the way: the tab
  right-click menu stretched to the window's right edge, and the side panel's
  Comment / Edit text buttons ignored `hidden`.

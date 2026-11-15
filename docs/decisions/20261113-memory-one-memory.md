# One memory: agents' own notes become a source, then are switched off

*2026-11-13 · step 3 of the memory rebuild (K15) · code:
`api/services/memory/reading.py` (`_agent_notes`), `agent_layer.py`
(`_owner_persona`), `agent-layer.mjs` (`ownMemoryEnv`, `codexLayerArgs`)*

## Context

On the owner's box Claude Code keeps its own notes per project
(`~/.claude/projects/<folder>/memory/*.md`, about 3 MB across 60 projects;
218 files for `~/shellteam` alone), and ShellTeam's persona told every agent to
keep them. Codex has a `memories` feature, off on this box. OpenCode keeps
none. Antigravity cannot be run on this box (SHE-113: its service refuses the
server's location), so whatever it keeps cannot be observed. Two memories
disagree, and only one of them reaches the other agents.

## Decision

1. **The nightly job reads each agent's own notes as a source**, like a
   conversation the agent wrote: Claude Code's note files (its `MEMORY.md`
   index left out) and Codex's `~/.codex/memories`. A file is read again,
   whole, only when its content changed (its bookmark is the content's hash).
   Its folder comes from the directory name; notes kept under a hidden folder
   (the job's own runs, the exam's) are never read. Memory never writes them.
2. **The persona stops asking for a second memory** when the memory module is
   on: its `memory` section is left out of the prompt all four agents get.
   The launch text's closing lines say how to search and leave a note.
3. **A launch setting switches agents' own memory off in cockpit chats**:
   `"agents_own_memory": "off"` in `~/.shellteam/memory/settings.json`.
   Claude Code gets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, Codex
   `-c features.memories=false`. Default `"on"`. Nothing changes without the
   module or for chats started outside the cockpit.
4. **When the setting flips is the exam's call** (PRD K15): two runs in a row
   with own memory off, every kind within 10 points of the last run with it
   on. Until then it stays on.

## Why

- Reading the notes first means a fact that lived only in Claude's notes
  reaches Codex the next day, before anything is switched off.
- A setting, not a code change, so the owner can switch back at once.

## Revisit when

- Antigravity can run here (SHE-113): find where it keeps its own memory,
  read it, and add its switch.
- Claude Code or Codex change where or how they keep notes.

## Consequences

- The first night after this lands reads every existing note file once
  (about 3 MB on the owner's box, three nights at the default budget; the
  report shows the backlog).

## Update 2026-11-14: Antigravity

Antigravity runs on the owner's box after all: only its Gemini models are
refused ("User location is not supported", a Google-side check that many
users in supported countries report against data-centre addresses); its
Claude and GPT-OSS models answer. Its own memory is its "knowledge items" in
`~/.gemini/antigravity-cli/knowledge`, empty on this box: the nightly job
reads every markdown file under it. Its settings schema
(antigravity.google/schemas/v1/settings.json) has no key to switch them off,
so `agents_own_memory: "off"` cannot reach Antigravity; this is stated, not
worked around.

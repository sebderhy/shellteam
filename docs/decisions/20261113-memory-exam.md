# The recall exam: how we know memory works

*2026-11-13 · tickets SHE-191, SHE-134 · plan: `docs/plans/active/knowledge/`*

## Context

The memory rebuild (knowledge tree, facts, cards) needs a number that says
whether a freshly opened agent knows what happened this week. Public memory
benchmarks do not transfer: vendor scores for one system differ by 30 points
depending on who ran them, and none measures this box. The plan's rule is that
no step ships without a before and after score.

## Decision

An exam built from the box's own conversations, in
`api/services/memory_exam.py` (`python -m api.services.memory_exam
generate|run|grade|report`). Data lives under `~/.shellteam/exam/`, never in
the repository: the questions are the owner's private life and work.

1. **Questions** are written by a model from real conversations of the last 14
   days, read with the nightly job's own readers, so tool output is already
   gone and no question can rest on it. Long conversations are read in up to
   ten evenly spaced pieces. A second call selects about 100 across four
   kinds: recent fact, changed fact, needs a lookup, should not know.
2. **The agent under test** is started with the flags the cockpit passes,
   asked of the cockpit's own code at run time (`claudeLayerArgs`,
   `codexLayerArgs`), one fresh agent per question, in the question's folder.
   Nothing is saved (`--no-session-persistence`, `--ephemeral`).
3. **Arms** vary two things: ShellTeam's launch memory (`SHELLTEAM_MEMORY=off`
   removes it) and the agent's own memory (Claude Code:
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). Codex's `memories` feature is off on
   this box, so there is nothing to vary there.
4. **Grading** is by a model against the supporting sentence: right, partly,
   wrong, did not know. "Should not know" is graded on the launch text, not on
   the answer. Twenty graded answers per arm are listed for a hand check.
5. **A frozen set** (`frozen-2026-11`) is never regenerated; `generate` refuses
   to overwrite a set.

## Isolation, and why it is a hook and not a sandbox

An agent that can read the source conversations is reading the answer key.
Hiding files per process needs a mount namespace; this box has no bubblewrap
and blocks unprivileged user namespaces (checked 2026-11-13: `unshare --user`
fails on `uid_map`). So:

- **Claude Code** gets a `PreToolUse` hook for the exam run only (`--settings`,
  no file of the owner's is touched). `memory_exam_guard.py` refuses any call
  that reaches a conversation store, any file write, and any outside tool.
  Verified on a real run: a request to grep `~/.claude/projects` and write a
  file was refused and nothing was written.
- **Codex** has no such hook, and its read-only sandbox does not work here
  (`bwrap: loopback: Failed RTM_NEWADDR`: every command fails). It runs as in
  the cockpit, without a sandbox, and its commands are read back from the
  event stream: an answer that touched a conversation store counts as wrong
  and is reported as contaminated.
- MCP servers are not loaded for either agent during an exam.
- The exam's own model calls run under `~/.shellteam/exam/work/`, a hidden
  folder the nightly job's reader already skips. A test pins that.

## What is a deviation from "opened the normal way"

- One-question print mode instead of the cockpit's streaming session, and
  `codex exec` instead of `codex app-server`. Same model, same layer flags,
  same launch text.
- No MCP servers.
- The question ends with "If you cannot tell, say that you do not know", so a
  missing fact shows up as "did not know" instead of a guess.

## Limits to keep in mind

- About 100 questions: a score is good to about plus or minus 10 points.
- The box had 25 real conversations in the window (the owner works in long
  sessions), so many questions come from the same few conversations.
- Antigravity and OpenCode are not run: neither answers unattended here yet.
  Every report says so.
- The grader is a model. The hand-check list exists because it can be wrong.

## Revisit when

- An agent gains a real per-process file sandbox on this box (then hide the
  source conversations instead of refusing whole stores).
- Antigravity or OpenCode can run one question unattended.
- The exam score stops moving with real changes (the set is too easy or too
  stale): generate a fresh set and compare.

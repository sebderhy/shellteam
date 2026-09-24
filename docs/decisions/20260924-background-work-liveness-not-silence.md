# Background work is judged by liveness, never by silence (SHE-93)

Date: 2026-09-24

## Context

The Claude adapter kills an idle CLI after 10 quiet minutes so a box does not
accumulate resident processes. Two earlier fixes taught it to wait for work
running inside the process: Task subagents (SHE-59) and background Bash tasks
(`run_in_background`). Both waited under one rule, a 1 hour "stale cap": if the
CLI printed nothing for an hour, whatever was tracked was assumed leaked and
the process was reaped.

A real overnight run (Jev deck session, 23 to 24 September) showed the cap is
wrong for background Bash. The agent launched a multi-hour benchmark plus a
watcher (`until grep -q DONE log; do sleep 60; done`) as a background task. A
watcher prints nothing by design. After an hour of silence the reaper killed
the CLI, the watcher died with it (background tasks are children of the CLI),
no completion notification was ever delivered, and the agent sat silent until
the owner typed "So?" the next morning. The kill log said "no subagents or
background tasks" while 6 subagents and 1 task were tracked: the 6 subagents
were phantoms (async Agent completions arrive as a task notification, never as
a `parent_tool_use_id` result, so the tracker never released them) and the
real reason was the cap.

## Decision

1. **A background Bash task is alive while its shell is alive.** The harness
   runs the command in a shell whose stdout and stderr are the task's output
   file, and that shell (plus any child inheriting the fds) holds the file open
   for writing until the command exits. `lib/task-liveness.mjs` scans `/proc`
   for a writer of that file. The reaper defers as long as one tracked task
   has a live writer, for hours or days; a tracked task nobody writes to any
   more is dropped as finished. Silence carries no information and is not
   consulted. Verified against a real `claude -p` background task: the shell
   and `sleep` hold fd 1 and 2 with write flags, the CLI does not hold the file.
2. **Tracking follows the CLI's own task messages.** Claude Code 2.1.280
   narrates background work as structured `system` messages (`task_started`
   with `task_id` and `tool_use_id`, `background_tasks_changed` with the live
   list, `task_notification` with the output file), captured from a real run
   into `test/fixtures/claude-stream-background-task.jsonl` and replayed by the
   tests. The tool_result and `<task-notification>` text forms stay as the
   fallback for older CLIs. Async subagents are released by the notification,
   which names the Agent tool call in `tool_use_id`, the tracker key. Subagents keep
   the 1 hour stale cap: they stream events while they work, so an hour of
   total silence does mean the tracker leaked.
3. **The kill log states the actual reason** (`quiet for Ns with nothing
   tracked`, or `stale cap: N subagent(s) ... no stdout for Ns`), never a
   generic sentence, because the wrong sentence cost a day of diagnosis.
4. **A CLI that dies with tasks running gets its agent resumed.** The adapter
   reports the lost tasks; the session manager records them on the slot,
   persists them in the tabs file, and sends the agent a `<cockpit-notice>`
   naming the tasks and their output files, either at once (crash) or after
   the cockpit restarts (the nightly release update at 03:10 is exactly such
   a restart). The record is cleared before sending, so a slot is nudged once
   per loss. A deliberate stop (Stop button, model switch, tab close) abandons
   the tasks and never nudges. Verified live: after `kill -9` of the CLI the
   agent resumed, read the output file, and reported the task had not
   finished. On `--resume` Claude Code also injects its own "didn't finish
   before the previous session ended" notification, so the two signals agree;
   the cockpit's contribution is the resume itself, which nothing else does.

## Rejected

- **A longer cap** (6 h, 24 h): moves the cliff, keeps it. Overnight jobs are
  the core use, and a benchmark can run 20 hours.
- **Polling the output file's modification time**: a quiet watcher never
  writes, so mtime says nothing.
- **Counting the CLI's child processes**: MCP servers and hooks are long-lived
  children too, and telling them apart means matching command lines.
- **Persisting the task list in the Claude session file**: the CLI owns that
  transcript; the tabs file is the cockpit's own store and already survives
  restarts.

## What would make us revisit

- The harness stops redirecting background tasks to their output file, or
  moves off Linux `/proc` semantics. The liveness test then reports "no
  writer" for a live task and the reaper drops it; `test/task-liveness.test.mjs`
  and the real-process reaper test would fail first.
- Subagents gain a liveness handle of their own (an output file, as async
  agents already have); then the stale cap can go too.

## Consequences

- Long autonomous jobs finish and get reported without a prod, on the box the
  agent runs on. An idle CLI still exits after 10 quiet minutes once nothing
  is running.
- A slot's tab record may carry `bgTasks` between restarts; it is consumed on
  the first resume and absent otherwise.
- Every Claude adapter change needs `shellteam-ai-chat` restarted to take
  effect (the owner runs that).

# Session search runs off the event loop in a `grep` subprocess

**Date:** 2026-07-21
**Status:** accepted

## Context

SHE-82 made cockpit session search server-side: a query now scans **every**
transcript on disk (Claude `~/.claude/projects/**` + cockpit Codex history), not
just the newest 50 the browser holds, so a term buried in an old conversation —
or the folder a session ran in (e.g. `~/avsv`) — is findable.

The first implementation did this synchronously inside the WebSocket message
callback: for every metadata miss it `readFileSync`'d the whole JSONL, built a
lowercase copy, and `.includes()`'d it. The round-7 launch audit measured the
cost on a mature real history — 269 files / 640 MB, largest transcripts 112 MB
and 100 MB. One no-match query blocked the Node event loop for **5,325 ms**. The
cockpit runs a single event loop for every client's HTTP and WebSocket traffic,
so during that window nothing else progressed: agent-stream rendering,
heartbeats, status, multi-device updates all stalled behind the scan, and a
second settled query could trigger another full scan. A fully green CI missed it
because the unit test used 61 tiny fixtures and the "wire" test was a
source-string assertion that never started the server.

## Decision

Scan transcript **bodies** in a `grep` subprocess, off the main event loop, and
make searches cancellable.

- `history.mjs:searchSessions` is now `async`. Body matching runs via
  `grepBodies` → `spawn("grep", ["-l","-i","-a","-F","-e",q,"--",...paths])`.
  grep streams each file (a 100 MB transcript is never loaded into V8), matches
  case-insensitively as a literal, treats JSONL as text, and prints only the
  paths that match. The file list is chunked (`GREP_BATCH`) to stay under the
  child's argv limit on an arbitrarily large corpus.
- **Folder** matching stays a zero-I/O check: a Claude session encodes its cwd
  in the project-dir name, so `~/avsv` is found straight from the path with no
  read. Codex cwd (in `session_meta`) and every message body are covered by the
  grep pass.
- Cancellation lives at the WS handler (`server.mjs:search_sessions`): each
  connection keeps one `AbortController`; a new keystroke aborts the previous
  scan (killing its grep child via the spawn `signal`) so a burst never stacks
  overlapping full-corpus scans, and a superseded scan stays silent so it can't
  clobber the newer answer. Latest-query-wins.

Result on the real 640 MB corpus: a cold no-match search does ~350 ms of grep
wall-time but the **event-loop lag stays ≤ 3 ms** — the loop is free throughout,
versus a 5,325 ms freeze before.

## Alternatives considered

- **Streaming async reads on the main thread** (replace `readFileSync` with a
  promise). Rejected: the audit's own bar calls this out — lowercasing/scanning
  a 100 MB chunk still runs on the main thread and stalls the loop.
- **A `worker_threads` scanner.** Truly off-thread and dependency-free, but more
  moving parts (pool, message passing, its own cancellation) than the job needs,
  and it would re-implement in JS what `grep` already does faster. grep also
  parallelises across the OS and memory-maps large files.
- **A persistent inverted index.** Fastest queries, but adds a build/refresh
  lifecycle, staleness handling, and on-disk state to a single-user tool whose
  corpus is a few hundred files. Over-engineered for the current scale.

## Consequences

- Adds a hard runtime dependency on `grep` for **content** matching. It is base
  on every supported Linux target. If absent, `grepBodies` logs a warning and
  returns no body hits — folder/path matching still works — so search degrades
  loudly, never silently.
- A new self-contained release gate,
  `test/session-search-responsiveness-gate.test.mjs`, spawns the real server on
  a throwaway HOME, seeds ~300 MB, and pings over a real WebSocket while a cold
  no-match search runs. It fails if the worst ping round-trip exceeds 250 ms or a
  superseded query still answers, and it was verified to **fail on the pre-fix
  code** (public 50f95fa: 801 ms / 1549 ms stalls). Listed in
  [release-qa.md](../release-qa.md).

## What would make us revisit

- Corpus growth into the multi-GB / tens-of-thousands-of-files range where even
  an off-loop grep per keystroke is too slow → build the incremental index.
- Wanting search on a platform without `grep` (e.g. a future non-Linux target) →
  fall back to a `worker_threads` scanner.

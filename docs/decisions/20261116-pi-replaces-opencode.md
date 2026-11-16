# Pi replaces OpenCode as the included-models agent

Date: 2026-11-16. Ticket: SHE-114. Decided by the owner after the evidence below.

## Context

The "included" tab runs the Fireworks models (GLM 5.3, Kimi K3, GLM 5.3 Flash)
through ShellTeam's relay, for people without a Claude or ChatGPT plan. It ran
on OpenCode 1.x. Three problems:

- OpenCode's headless JSON mode only prints finished blocks: the tab showed
  "Working..." and then the whole answer.
- Its prompt was heavy: about 52,000 input tokens per request with ShellTeam's
  layer (persona, skills, 5 MCP servers), paid on the relay.
- OpenCode 2.0 (a new npm package, `@opencode/cli`) changed its CLI flags,
  database schema, tool names and config format, and starts a background
  daemon. Staying on OpenCode meant porting the adapter anyway.

## Decision

Replace OpenCode with Pi (`@earendil-works/pi-coding-agent`, MIT, by Earendil),
driven over its RPC mode: one long-lived `pi --mode rpc` process per chat.
OpenCode is removed entirely. Open OpenCode chats are carried over to Pi with
their conversation on their next start (portable-session handoff).

## Evidence (as of 2026-11-16)

Measured on this box, same relay, same tasks (explain a file, fix a failing
test, one MCP call), Pi 1.5.2 against OpenCode 2.3.0:

| | OpenCode 2.3 | Pi 1.5.2 |
|---|---|---|
| Text streams live in headless mode | no (whole blocks) | yes, from about 1 s |
| Input tokens per request, bare | 12,196 | 1,345 |
| Same, full ShellTeam layer | 20,157 (Code Mode) | 7,422 (codemode) |
| Pass rate, GLM 5.3, 9 runs | 9/9 | 9/9 |
| Install size | 961 MB | 160 MB |

Public evidence: the Hugging Face Harness Leaderboard (Terminal-Bench 2.1 and
DeepSWE, same model and weights for every harness, 3 attempts, public
trajectories) ranks Pi 1.2 tied for first (49.4% macro, $0.29 per solved task,
the cheapest) and OpenCode 1.19 well behind (35.5%, $3.35 per solved task),
across three open models. OpenCode 2.x was not on that board yet. A smaller
30-task comparison (Composio) called the two a tie.

Live checks after the build: a real chat turn through the relay (read tool and
a DeepWiki MCP call, answer streamed, $0.003); resume in a new process recalled
the conversation; Claude to Pi, Pi to Claude and Codex to Pi handoffs recalled
their codeword (scripts/golden-portable-sessions.mjs).

## How it fits the additive layer

- `~/.shellteam/agent-layer/pi/shellteam.ts`: a static extension that
  registers the `shellteam` provider (the relay, keys as `$VAR` references,
  never values) and the MCP servers it reads from `pi/layer.json` (0600).
- The shared prompt and skills ride as `--append-system-prompt` and `--skill`.
- Pure core keeps the provider only: the one documented core-mode artifact,
  as OpenCode's provider-only config was (20260704-purity-gate-modules.md).
- Nothing is written to `~/.pi` beyond what Pi itself writes (sessions, its
  own state), and the portable handoff's session files, as for Claude/Codex.
- The cockpit mints `pi-<uuid>` session ids and opens them with
  `--session-id`, so a resume and a first start are the same spawn.

## Consequences

- Node floor raised to 22.19 (Pi's requirement). Node 20 is past its end of
  life; `install.sh` installs Node 22 when the box is older.
- Pi's project trust: in RPC mode Pi skips a folder's protected resources
  (`.pi/` settings, project MCP, project skills) unless the owner trusted the
  folder in Pi (`/trust`, saved in `~/.pi/agent/trust.json`). The cockpit
  passes no override, so the owner's own Pi decision applies.
- Mid-turn messages wait in Pi's own queue (`followUp`), in the same process;
  Stop aborts the run and clears that queue.
- The relay's daily request limit (200 per user) applies as before.

## What would make us revisit

- OpenCode 2.x lands on the Harness Leaderboard clearly ahead of Pi.
- Pi breaks its RPC protocol or session format in a way that costs more than
  an adapter fix, or its release pace stops.
- A Pi release drops the `registerProvider` / `registerMcpServer` extension API
  the layer depends on.

# Secrets vault built into ShellTeam (SHE-135)

Date: 2026-11-05

## Context

After the 2026-11-03/04 incident on the shared VPS, Seb had to rotate every API
key. Two pains stood out: keys end up in agent traces (transcripts, AI provider
logs, screenshots), and re-inserting a rotated key into every app is slow and
error-prone.

## Decision

Build a small vault into ShellTeam instead of adopting an external tool:

- One owner-only file, `~/.shellteam/secrets.json` (0600 in a 0700 dir).
- Dashboard Settings -> Secrets: add, replace, delete. The API never returns
  values.
- `bin/shellteam-secrets`, called by agents by absolute path (taught by the
  `persona` module's prompt):
  - `write` puts named keys into an env file, straight from the vault, never
    via stdout;
  - `run` runs a command with keys in its env and masks them in its output;
  - both record a *use*.
- Replacing a key = rotating it: every recorded file is rewritten, its
  registered `systemd --user` unit restarted, and remembered commands re-run.
  Each result is shown in the UI and logged.
- The cockpit masks vault values in every websocket frame (`[secret NAME]`)
  as a safety net.

## Why (evidence as of 2026-11-05)

- Infisical and Doppler restart apps on change (`run --watch`). But Infisical
  needs Postgres and Redis, and Doppler is closed-source and paid. Neither
  keeps keys out of agent traces.
- The agent-focused tools (psst, Phantom, AgentSecrets, secretctl) keep keys
  out of traces but don't propagate rotations. They are also young and come
  with their own runtimes: Bun for psst, a Rust binary for Phantom.
- ShellTeam already owns the Settings UI, the agents' prompt, the cockpit
  display and the app units. So a few hundred lines give the whole loop.
- Claude Code's PostToolUse `updatedToolOutput` is reported as ignored for
  Bash (open issues). So values must stay out of tool output by
  construction, not be scrubbed afterwards.

## Limits (stated plainly)

- This is not protection against an attacker with a shell as the owner or as
  root: they can read the vault like any secret on the box.
- Cockpit masking hides values from what the browser shows. The agent CLI's own
  transcript and the model still see raw output if an agent prints a file.
- The CLI is on no PATH (purity gate). Agents learn it from the persona, so a
  pure-core box has the vault and CLI but agents aren't told about them.

## Revisit if

- People ask for it outside ShellTeam: extract the CLI as its own package.
- A placeholder-plus-proxy design (Phantom, Fly's tokenizer) becomes needed so
  apps never hold real keys at all.
- Claude Code reliably honors `updatedToolOutput` for Bash: add a scrub hook.

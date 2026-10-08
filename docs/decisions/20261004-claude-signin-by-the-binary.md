# Claude sign-in is done by the Claude Code binary

Date: 2026-10-04 (SHE-116)

## Context

The cockpit signed users in to their Claude subscription itself: `startOAuth()`
built the authorize URL with Claude Code's public client id, `completeOAuth()`
posted the pasted code to Anthropic's token endpoint and wrote
`~/.claude/.credentials.json`, and `subscriptionStatusFor("claude")` parsed that
file. Anthropic's terms (code.claude.com/docs/en/legal-and-compliance, read
2026-10-02) do not let third-party applications offer Claude.ai login or
"collect, store, or intermediate Claude.ai credentials or session tokens";
sign-in must complete through Anthropic's own flow. They do allow hosting the
unmodified Claude Code binary where each user signs in with their own plan.

## Decision

1. **Sign-in:** spawn `claude auth login --claudeai` on a PTY (node-pty, as for
   `agy`), scrape the authorize URL it prints once the "Paste code here" prompt
   is up, type the user's pasted code into that prompt. The binary does the
   exchange and stores its own credentials. A failure is the binary's own
   "Login failed" line.
2. **Status:** `claude auth status --json`, run without `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or a base URL so a key
   cannot pose as the login. Connected = `loggedIn` and `authMethod` is
   `claude.ai`; a credential file the binary calls logged-out = `expired`; no
   file = `none`. The answer is cached on the file's stat (mtime and size), so
   the binary runs once per login or refresh, not per status request.
3. **Recovery marker:** keyed on the same stat fingerprint (was a content hash).
   Markers written before this release no longer match and are dropped once; the
   next provider auth failure writes a new one.
4. **Sign-out:** `claude auth logout`, `POST /api/oauth/logout`.
5. Deleted `startOAuth`, `completeOAuth` and the `OAUTH_*` constants. The API-key
   path is unchanged (the terms require it to stay available).
6. Codex (`codex login --device-auth`) and Antigravity (`agy` over a PTY) already
   used their own binaries; not touched.

## Why

The binary-driven flow keeps the same user experience (open link, paste code)
while moving the credential handling to the one party the terms allow. Status via
the binary also stops us guessing token validity from timestamps in a file whose
format Anthropic owns.

## Verified

Against Claude Code 2.1.285: the real binary prints the URL (twice, once as a
terminal hyperlink) and the prompt; a bogus code gives "Login failed: Request
failed with status code 400" and exit 1; status reports `loggedIn`/`authMethod`.
Not verified: a successful real login (needs a real code; the fake binary covers
that branch in tests).

## Revisit when

- Claude Code changes the `auth login` prompt or status JSON (the tests pin both
  against a fake; the release gate should run the real binary once).
- Anthropic offers a sanctioned third-party sign-in program.

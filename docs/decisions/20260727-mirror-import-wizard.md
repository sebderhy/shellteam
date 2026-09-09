# Environment Mirror v2: the import wizard, and letting credentials travel (opt-in)

**Date:** 2026-07-27
**Status:** decided, shipped (hardened in pre-merge security review — see Consequences)
**Builds on:** [20260727-environment-mirror.md](20260727-environment-mirror.md)

## Context

Mirror v1 shipped the same day as this doc: a read-only inventory script, a
secretless tarball, and a `migrate` skill. Its flow assumed a technical user
(run a script, upload a file, prompt an agent) and its security contract was
absolute: secrets never travel, the user re-authenticates everything on the box.

The first pilot user is non-technical, struggled to build his local setup, and
budgets 5-10 minutes for the whole move. He uses Codex, is already
authenticated locally (Claude, Codex, MCPs), and wants his chat history on the
box. Re-doing OAuth flows and losing conversations is exactly the friction that
kills the onboarding wedge the mirror exists to be.

## Decision

1. **The box mints the flow.** Settings (and the last first-run-wizard step)
   generate one copy-paste command containing the box URL and a **24-hour
   purpose-bound upload credential** (`mirror-v1.<exp>.<HMAC(master)>`,
   `api/services/auth.py`). The master token never enters the laptop's shell
   history; rotating `OWNER_TOKEN` revokes all outstanding passes. The wizard
   also accepts a pasted welcome link (`?token=...`) for users arriving from
   the provisioning email.
2. **A local checkbox UI on the laptop** (`scripts/mirror-import.sh`: bash +
   stdlib-Python server on 127.0.0.1, page mounted under a random nonce path as
   the CSRF boundary). The user ticks sections — the "checkbox where HE defines
   what gets imported" — and clicks once. `mirror-inventory.sh` stays the single
   engine (`--stage` / `--pack` modes).
3. **The secrets-never-travel contract becomes two-tier** instead of absolute:
   - *Shareable tarball* (save-to-file, or the v1 script run by hand): the v1
     contract, unchanged and contract-tested — no credentials, redacted, safe
     to store anywhere.
   - *Direct-only sections* (`secure/` in the stage): agent logins
     (`~/.claude/.credentials.json`, `oauthAccount`, `~/.codex/auth.json`),
     MCP definitions with tokens intact, Claude/Codex chat history, shell
     history. These exist **only** for a TLS upload to the user's own box,
     are never written into a saved file (tested), and the migrate skill
     deletes them after install. Rationale: moving a credential from one
     machine the user owns to another machine the user owns, over TLS, at the
     user's explicit tick, is not the threat the v1 contract guarded against
     (accidental sharing of a tarball).
4. **Zero-typing migration start.** `POST /api/mirror/upload` stores to
   `~/mirror-inbox/` (0600) and calls the cockpit's new
   `/internal/mirror/kickoff` (gated on the shared `SHELLTEAM_AI_TOKEN` in a
   custom header **and** a refusal of any request carrying an `Origin`),
   which opens a "Laptop import" tab and starts the `migrate` skill. The user
   opens their box to an agent already moving them in.
5. **Codex is a first-class citizen**: logins, config, AGENTS.md/prompts,
   sessions history — everything done for Claude is done for Codex (skill rule
   3). The pilot will exercise the Codex path directly.
6. **Defaults**: shell history off; SSH private keys never travel (fresh keys
   on the box); project `.env` files are an opt-in `secure/env` section
   (default on) whose **contents** ride the same direct TLS channel as the
   logins and are dropped back at each repo path by the migrate skill. The
   earlier plan — map `.env` by name only and re-provision by hand — was
   rejected after review: "by hand" meant the user pasting real API keys into
   a chat with a `--dangerously-skip-permissions` agent, which lands them in
   the agent's context and transcript. Moving the file itself over TLS to the
   user's own box is both safer and less work. A saved file (not a direct
   upload) still carries no `.env` — the values stay on the laptop and the
   skill falls back to the SECRETS-MAP by-hand walk.
7. **Where it lives**: the same public repo (`scripts/`), not a separate
   repo/product — the wizard is the mirror's front door, and a second repo
   would fork the engine and the contract tests.

## What we deliberately did not build

- **Pay-first gating inside the wizard.** The wizard links people without a
  box to the site; it does not embed checkout. Payment is the managed-cloud
  funnel's job; OSS self-hosters have no checkout at all.
- **Byte-copying `~/.ssh`**, even as an opt-in — key hygiene beats symmetry,
  and GitHub access comes via the dashboard's device-flow connect.
- **A persistent laptop agent / two-way sync** — still out of scope (v1 doc).

## Revisit triggers

- Providers start machine-binding OAuth tokens (copied logins stop working):
  fall back to the dashboard connect buttons; consider a guided re-auth step in
  the wizard.
- Chat-history archives routinely blow the 200MB/agent cap: add a range picker
  to the wizard instead of raising the cap silently.
- The managed funnel wants import-during-checkout: revisit pay-first gating.

## Consequences

- The upload credential is a third derived credential class (after files and
  share links) — auth surface documented in `api/services/auth.py`, covered by
  `tests/test_mirror_upload.py`.
- `mirror-inventory.sh` default mode is byte-compatible with v1 (the old
  contract tests pass unmodified); wizard modes are additive.
- The cockpit gained a control endpoint that starts an agent turn
  programmatically. Anything else wanting "start a tab with a prompt" must go
  through `internalCallerAuthorized()` (`computer/ai-chat/lib/internal-auth.mjs`)
  rather than invent another path.

  **"Loopback-only" was the wrong trust model and shipped as a real hole** (found
  in pre-merge review, fixed before merge). The endpoint listens on the same host
  the owner browses from, so a page in the owner's browser connects from
  127.0.0.1 too — a socket-address check would have authorised the attacker. And
  a cross-origin `fetch` with `Content-Type: text/plain` is a CORS-safelisted
  *simple* request: no preflight, the response is opaque but the side effect has
  already landed. On a localhost install any website the owner visited could
  therefore start a `--dangerously-skip-permissions` agent with an
  attacker-authored prompt. The gate is now two independent locks — a secret in a
  non-safelisted header (which forces a preflight this server never answers) and
  refusing a present `Origin` — and fails closed when no secret is configured.
  `scripts/qa/internal-csrf.mjs` replays the exploit against the real server on
  every CI run.

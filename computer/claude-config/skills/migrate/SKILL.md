---
name: migrate
version: 2.0.0
description: "Mirror the user's laptop dev environment onto this box from a shellteam-mirror tarball. Use when the user mentions mirroring/migrating their local setup (Mac, WSL, laptop), moving in, the import wizard, or a shellteam-mirror-*.tar.gz file (often in ~/.mirror-inbox/)."
metadata:
  tags: ["mirror", "migration", "onboarding", "dotfiles", "setup", "laptop", "environment", "import"]
---

# Environment Mirror — migrate a laptop setup onto this box

The user ran the import wizard (`mirror-import.sh`) or the inventory script
(`mirror-inventory.sh`) on their laptop. A `shellteam-mirror-*.tar.gz` is now on
this box — wizard uploads land in `~/.mirror-inbox/`, manual uploads usually in
`~/`. Your job: make this box feel like their machine — same tools, same shell,
same agent config and logins, same repos, same conversations — adapted honestly
to Ubuntu. This is a *functional* migration, not a byte copy.

If no tarball exists yet, point them at the box's Settings tab ("Import your
laptop") — it mints the exact wizard command with upload credentials baked in.
The manual fallback fetches from THIS box (it serves the scripts itself, at
exactly its installed version — never point them at GitHub for these), with
`<box-url>` being this box's dashboard URL:

```
curl -fsSLO <box-url>/api/mirror/mirror-inventory.sh
bash mirror-inventory.sh
```

## Ground rules

1. **Never overwrite an existing file on this box.** Merge additively; when a
   real conflict exists, back the original up to `<file>.pre-mirror` and say so.
2. **The tarball may contain a `secure/` directory** (agent logins, MCP tokens,
   chat history, project `.env` files) — only when the user explicitly ticked
   those in the wizard for
   a direct upload to their own box. Treat it as live credentials: install with
   `0600` permissions, and when you're done **delete the tarball and every
   extracted copy of `secure/`** so credentials never linger in
   `~/.mirror-inbox/` or your extraction directory.
3. **Everything you do for Claude Code, do for Codex too.** Config, memory,
   logins, MCP servers, chat history — the two agents get equal treatment
   (same for OpenCode/Gemini where files exist).
4. **Secrets that did NOT travel are re-provisioned in one pass at the end**,
   driven by `SECRETS-MAP.md`. Never ask the user to paste secrets mid-migration.
5. **Don't touch ShellTeam's own layer** (`~/.shellteam/agent-layer/` and the
   services). The user's personal `~/.claude`, `~/.codex` etc. are theirs —
   installing their configs there is exactly what they asked for.
6. **Be honest about what doesn't map.** GUI apps and macOS-only casks don't
   exist on a headless Ubuntu box: list them as skipped with one line of
   reasoning, don't silently drop them.

## Procedure

1. **Unpack and survey.** Extract to `~/.mirror-work/<timestamp>/` (mode 700).
   A DOT-directory, never `~/tmp/`: the file server serves `~/<path>` to
   anything holding the read-only files credential and hard-denies only
   dotfiles, so extracting logins under `~/tmp/` would publish them at a URL.
   Read `manifest.json`, `summary.json` (if present), `redactions.txt`, and
   `SECRETS-MAP.md` first, then skim the package lists and `repos.tsv`. Tell
   the user in 3-4 lines what arrived and what you're about to do. Then
   proceed — don't wait for approval unless something looks destructive.
2. **Agent logins first** (`secure/logins/`, when present) — this is what makes
   the box immediately feel signed-in:
   - Claude Code: install `claude/credentials.json` as
     `~/.claude/.credentials.json` (0600). If `claude/oauth-account.json` has an
     `oauthAccount`, merge that key into `~/.claude.json` (create the file if
     missing, back it up first if it exists).
   - Codex: install `codex/auth.json` as `~/.codex/auth.json` (0600).
   - MCP servers: `mcp/mcp-servers.json` is the *authenticated* set (tokens
     intact) — merge its `mcpServers` into `~/.claude.json`, and mirror the
     same servers into Codex's `~/.codex/config.toml` (`mcp_servers` tables)
     so both agents see them. Servers whose commands need packages installed
     later will start working as the migration proceeds.
   - Verify each login non-interactively (e.g. a trivial `claude -p` /
     `codex exec` call) and report which agents are signed in. If a copied
     credential doesn't work (providers can bind tokens to machines), say so
     plainly and point at the dashboard's provider connect buttons — don't
     retry-loop.
3. **Packages.** Translate with judgment, not a lookup table: brew formulae →
   apt equivalents (names often differ), language toolchains via their standard
   installers (nvm/uv/rustup), npm/pipx/uv/cargo globals reinstalled directly.
   Skip GUI casks and macOS-only tools, noting each. Prefer the box's existing
   tool versions when already installed. If `packages/secrets-managers.txt`
   lists a secrets-manager CLI (Infisical, Doppler, 1Password `op`, Vault, …),
   install it via its official Linux instructions — it is the user's whole
   secrets story, so it is high priority, and its login goes in the one-pass
   secrets step below.
4. **Repos.** Check `gh auth status`. If not connected, point the user at the
   dashboard's Connect GitHub button (device flow) and continue with other
   steps meanwhile. Clone each repo from `repos.tsv` to the same relative path
   under `~`. Warn about repos that were dirty on the laptop (dirty-file count
   column): uncommitted work did NOT travel and still lives only on the laptop.
   If a recorded branch no longer exists on the remote, clone the default
   branch and flag the mismatch in the report — never silently substitute.
5. **Dotfiles and shell.** Install shell rc files, git config, editor and
   terminal configs. Adapt mac-isms (Homebrew paths, `pbcopy`, macOS-only
   plugins) instead of copying them broken. If the user's default shell differs
   (e.g. zsh), install it and `chsh`. `secure/shell-history/` (when present)
   installs as `~/.bash_history` / `~/.zsh_history` (0600, merge-append if the
   box already has history).
6. **Agent config.** Install their `CLAUDE.md`, skills, commands, project
   memory (`agents/claude/project-memory/*` → `~/.claude/projects/<dir>/memory/`),
   and MCP definitions into `~/.claude`; Codex's `config.toml`, `AGENTS.md`,
   and `prompts/` into `~/.codex`; OpenCode/Gemini configs likewise. If
   `secure/logins/mcp/mcp-servers.json` was installed in step 2, it wins over
   the redacted `agents/claude/mcp-servers.json` copy.
7. **Chat history** (`secure/history/`, when present). The laptop's home path
   differs from this box's — remap it, for both agents:
   - Claude: files arrive as `history/claude/projects/<laptop-path-slug>/…`.
     Rename each project dir slug from the laptop home prefix to this box's
     (e.g. `-home-alice-code-app` → `-home-<boxuser>-code-app`, matching where
     you cloned the repos), place under `~/.claude/projects/`, and rewrite
     absolute laptop-home paths in each transcript's `cwd`-style fields so
     resume works. Never overwrite an existing session file.
   - Codex: `history/codex/sessions/…` and `history.jsonl` → `~/.codex/`,
     with the same home-path rewrite in session metadata.
   - Spot-check one resumed session per agent and report whether history shows
     up (`claude --resume`, cockpit session list).
8. **Project `.env` files that travelled** (`secure/env/`, when present). These
   are the user's real project secrets, moved over TLS precisely so they never
   have to be pasted into a chat with you. Mirror the whole tree, file for file:
   every `secure/env/<repo-path>/<name>` (`.env`, `.env.local`, whatever is
   there) goes to `~/<repo-path>/<name>` — 0600, back up any existing file to
   `<name>.pre-mirror` first, create the repo dir if the repo wasn't cloned.
   Do NOT print their contents or ask the user about them — they're placed, done.
9. **Secrets that did NOT travel, in one pass.** Walk `SECRETS-MAP.md` with the
   user for everything not already handled above — one item at a time: fresh
   `gh auth login` (if not done via the dashboard), a NEW SSH keypair (never
   reuse the laptop's — offer to generate one and print the public key for
   GitHub), and any `.env` files that are listed in `SECRETS-MAP.md` but have
   no `secure/env/` counterpart (i.e. the user saved a file instead of a direct
   upload, so the values stayed on the laptop) — help them recreate those by
   hand. Skip anything the user says they don't need.
   **Secrets-manager users are the easy case**: if `SECRETS-MAP.md` (or
   `packages/secrets-managers.txt`) names a CLI like Infisical or Doppler, the
   user's project secrets live in that service, not on any machine. Make sure
   the CLI is installed (step 3), then have them run its login once (e.g.
   `infisical login` — most use a browser/device flow, so give them the URL or
   code it prints). Verify with a harmless read (e.g. `infisical secrets` in a
   project) and you're done — never export or copy the manager's secrets into
   files the user didn't already keep in files.
10. **Verify, clean up, report.** Spot-check: shell opens clean, key tools run,
    agents are signed in, one or two repos build. Delete the tarball and the
    extracted tree (rule 2). Then write a migration report to
    `~/reports/mirror-report.html`: what was installed, what was skipped and
    why, which logins/history made it, redactions that occurred, and any
    follow-ups (pending secrets, dirty laptop repos). Share the report URL.

## Failure honesty

If a package, credential, or session can't be reproduced, that's a *finding*,
not a failure — put it in the report's "didn't map" table. The user should end
with a box they trust because the report is complete, not because it claims
100%.

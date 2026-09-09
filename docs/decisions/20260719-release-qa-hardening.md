# 2026-07-19 — Public-release QA hardening: dispositions and deliberate trade-offs

## Context

An independent release-QA audit of the public snapshot (commit `87dfc59`) returned
a NO-GO with 7 P1 blockers concentrated in installation, supply-chain hygiene, and
distribution compliance — the core cockpit, auth boundaries, and lifecycle recovery
all passed. This batch addresses the blockers plus the quick P2s. This doc records
*how* each was resolved and the trade-offs chosen, so the choices can be revisited
deliberately.

## Decisions

### 1. Bootstrap is non-destructive by construction (P1-01)

`--create-owner` previously `rm -rf`'d an existing destination checkout before
copying — a rerun of the documented bootstrap was a data-loss operation (wiped
`.env`, rotated both secrets). Now: an existing destination is **reused untouched**
(nothing copied, deleted, or chown'd); a destination that exists but is not a
ShellTeam checkout is a hard stop. Updates flow through `git pull` + re-run inside
the owner checkout, never through re-copy. Pinned by
`tests/test_install_bootstrap.py` (real bootstrap function, run twice as root in a
throwaway Docker container).

### 2. Dotfile edits by third-party installers are reverted, loudly (P1-02)

The uv and Antigravity installers append PATH lines to shell profiles, violating
the FOOTPRINT.md guarantee. Rather than trusting per-vendor opt-outs alone
(`UV_NO_MODIFY_PATH=1` is set, but Antigravity has no equivalent), the installer
now snapshots the common profile files around each third-party installer and
restores any modification with a visible warning. We restore rather than fail
because the binaries land in `~/.local/bin`, which the cockpit's rendered PATH
already includes — the profile edits are unnecessary, not fatal.

### 3. Package installs are noninteractive everywhere (P1-03)

`DEBIAN_FRONTEND=noninteractive` is exported and re-asserted through a single
`apt_get` wrapper used by every apt path (base packages, Node, gh, Caddy). On a
pristine box tzdata's "Geographic area" dialog hung a PTY install and garbled
`/etc/timezone` on a piped one.

### 4. `ws` ≥ 8.21.1 + dependency audits are CI gates (P1-04)

The cockpit's `ws` is bumped past CVE-2026-48779 / GHSA-96hv-2xvq-fx4p, and CI now
runs `npm audit --omit=dev --audit-level=high` and `pip-audit` as required steps —
a vulnerable pin can't ship silently again.

### 5. Python is locked; coding-agent CLIs deliberately are NOT pinned (P1-06)

`uv.lock` is now committed (removed from `.gitignore`), `.python-version` pins
3.12, `install.sh` and CI use `uv sync --frozen`, and the silent
`uv pip install -e .` fallback is gone (a release must be reproducible from its
commit; a failure is a hard stop, not a different dependency set).

The globally installed coding CLIs (`claude`, `codex`, `agy`, `opencode`) remain
**unpinned by design**: they are user-facing agent runtimes whose new releases are
required for new models to work at all (an outdated Codex CLI 400s on new OpenAI
models), and they are installed only when absent — an operator's existing installs
are never touched. Version policy: latest-at-install-time, upgraded by the
operator. Revisit if a CLI release ever breaks the cockpit adapters — that would
justify a tested-floor version check in the spawners, not an install-time pin.

### 6. Steel is pinned by digest and certified by a real session launch

`:latest` is replaced with the digest running in production. `/v1/health` can
return 200 while Chromium cannot launch, so provisioning now creates and releases
a real `/v1/sessions` session before declaring the browser up. Bumping the browser
runtime is now a deliberate act: pull the new tag, run browser QA, update the
digest. `--no-start` now also skips the Steel container (previously it started
anyway — "no-start" means nothing starts).

### 7. Public snapshot: scrub forward, no history rewrite (P1-07)

Instance-specific residue (production IP, real home paths, personal fixtures) is
replaced with RFC-reserved placeholders in the lab tree, private-ops decision docs
are excluded from the snapshot, and `make-public-snapshot.sh` gains fail-the-build
greps for the known identifiers. The already-public repo's history is **not**
rewritten: the audit's secret scan (full history) found zero credentials, the
residue is informational (an IP that's on the landing page's DNS anyway), and the
standing rule is that the public repo is never force-pushed (PR-ref caches leak
rewritten history anyway, making a rewrite security theater).

## What would make us revisit

- A CLI release breaking a cockpit adapter → tested-floor version checks.
- A real secret ever found in public history → immediate rotation (not rewrite).
- Steel digest aging (upstream security fixes) → scheduled QA'd digest bumps.

## Deferred (tracked, not in this batch)

- Full keyboard/ARIA/contrast pass on the dashboard (audit §06) — the three
  390px overflow clips are fixed; native tab/menu semantics, focus traps, and
  contrast tokens are a follow-up UI batch.
- Installer CI job that runs `install.sh` end-to-end on pristine containers
  (PTY + piped) and diffs operator-owned files — today covered by the extracted-
  function regression tests only.
- Removing dormant Cloud-era files from the OSS tree (audit P3).

## Addendum (2026-07-19, best-of-both merge)

Two independent fix branches were produced against the same audit (this one and
a Codex-authored one). They were merged file-by-file after a three-way review;
the combined result supersedes both. Decisions made in that merge:

- **Steel digest stays at `995a31d…`.** The newer upstream index
  (`1c988dc8…`) was QA'd on this box: `/v1/health` returns 200 but every
  `POST /v1/sessions` fails with Chromium `launch_failed` (3 retries) — the
  exact healthy-but-dead failure mode the session probe exists to catch. The
  probe now also dumps container logs and removes the broken container.
- **Coding-agent CLIs remain unpinned** (the Codex branch pinned exact npm
  versions and a sha512-pinned Antigravity archive). Pinning trades a
  supply-chain edge for guaranteed staleness: a fresh box would get CLIs that
  cannot speak to new models (a failure we have hit in production). The
  dotfile-preserving guard covers the actual audited risk. Pinned-archive
  install remains the documented fallback if a vendor bootstrap is ever
  compromised.
- **Deferred items now largely closed by the merge**: the full keyboard/ARIA/
  contrast pass, the dead-Cloud-surface removal (ORG-marker stripping +
  CLOUD_FILES deletion in the exporter), and an exporter CI job now exist —
  from the Codex branch, with two public-CI-breaking bugs fixed (the
  release-gates job and the marker-test lint line are ORG-stripped from the
  public snapshot, which cannot run them).

## Addendum 2 (2026-07-19, post-merge review by the Codex branch's author)

The author of the superseded branch reviewed the merged result and raised three
corrections. Two were confirmed by reading the relevant sources; both are fixed.

- **CLA wildcards were a real bypass — worse than reported.** `allowlist:` held
  `Claude *` and `employee *`. contributor-assistant's `checkAllowList.ts`
  converts any entry containing `*` into a regex and evaluates it with
  `new RegExp(regex).test(committer)` — **unanchored** — against
  `committer.login || committer.name` (`graphql.ts`). The fallback to the git
  author *name* applies to any author with no linked GitHub account, and that
  name is chosen by the author. So `git config user.name "x Claude y"` plus an
  unlinked email cleared the CLA gate, with the substring match not even
  requiring a prefix. `Claude *` was also never load-bearing: the action's
  GraphQL query reads only `commit.author` and `commit.committer` and never
  inspects `Co-Authored-By` trailers. The allowlist is now exact logins only;
  ShellTeam's own agent identity must commit as a GitHub-linked author instead.
- **ShellCheck had silently left public CI.** It was a step inside the
  ORG-stripped `release-gates` job, so the exported snapshot — whose front door
  *is* `install.sh` — ran no shell linting. ShellCheck is now its own job
  outside the ORG region; only the exporter (which deletes itself from the
  snapshot) stays lab-only.
- **CLI pinning: position unchanged, but the gap they identified was real.**
  Their argument that "install latest" does not solve the compatibility problem
  is correct — `install_cli` deliberately leaves an existing CLI untouched, so a
  box with an old CLI stays old. The fix is not to start mutating the user's
  tooling (that breaks the additive guarantee) and not a version database (which
  reintroduces the staleness it is meant to cure): the installer now logs each
  CLI's detected version and, when it leaves one alone, prints the exact upgrade
  command alongside the symptom that calls for it.

Both fixes are pinned by `tests/test_ci_gates.py`, verified to fail against the
pre-fix workflows.

Not adopted: an "optional latest channel" and minimum-version warnings. Both
require a per-CLI known-good version table that goes stale exactly as fast as
pins do, for a warning the upgrade hint already delivers without the upkeep.

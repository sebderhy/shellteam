# Changelog

All notable changes to ShellTeam are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Editor deep links (`/_editor/<path>`) no longer hang on "Select a file to
  edit" — the dashboard CSP was blocking Monaco on proxied pages.
- Fresh native installs no longer 500 on report publishing / profile saves
  (`DATA_DIR` defaulted to the Cloud-era `/data/users`).
- Per-tab composer drafts; stable tab titles that survive compaction; tabs no
  longer pop up from other views' status broadcasts.
- The installer verifies the stack after start (health probes, port preflight,
  DNS hard-fail, honest public-URL banner) instead of printing success over a
  dead service.
- In-box AI skills (tts/stt/image/docs) now reach the control plane on native
  boxes (they used Cloud's `host.docker.internal`).

### Added
- Context-budget meter in the cockpit status bar (tokens used vs the model's
  window, per tab).
- `npm test` for the cockpit; tests for the agent launch-layer flag seam and
  the installer; hermetic Python test env (no more phantom reds).
- `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, issue/PR templates.

### Removed
- Dead Cloud-era surfaces: `/internal/push`, `/internal/resolve`,
  `POST /api/computers/profile` (wrote user dotfiles), `qa/` (Supabase/docker
  QA), `registry/` (hosted-DNS provisioning), push + share-folder skills.

### Security
- `/internal/check-domain` restricted to loopback; terminal WS authenticates
  before accept; enrollment links pinned to `APP_DOMAIN`; nginx no longer
  follows non-owner symlinks (`~/public/x -> /etc/…` no longer serves).

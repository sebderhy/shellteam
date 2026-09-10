# Changelog

All notable changes to ShellTeam are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.26] - 2026-09-10

### Added
- **`INCLUDED_MODELS`: offer a box key "on us", limited to chosen models.**
  A key in `.env` used to read as the user's own: the cockpit skipped the
  setup screen and landed on the family's default (GPT-5.6 Sol for Codex)
  with every model one click away. Listing catalog ids in `INCLUDED_MODELS`
  flips that family to the "included" billing mode: the setup screen asks for
  the user's own subscription first and shows the included models as an
  "on us" button underneath; the picker lists only those models until a plan
  is connected; the server refuses any other model of that family; persisted
  defaults and tabs naming an excluded model are coerced, with a log line.
  Built for the live demo (a capped OpenAI key limited to GPT-5.6 Terra).
- **`PUBLIC_SHARING=off`: a box that can never make anything world-readable.**
  Public port toggles, signed share links (files and apps) and report
  publishing refuse with a clear 403, and the read side serves nothing as
  public even when a published set survives on disk. Unpublishing still works.
  For boxes strangers drive (the live demo), so a visitor cannot host a page
  on the operator's domain. Default on; sharing is unchanged for everyone else.

## [0.1.25] - 2026-09-10

### Fixed
- **Codex on an API key set in `.env` never authenticated.** The cockpit
  reported "codex=apikey" and passed `OPENAI_API_KEY` to the process, but only
  told Codex to use the OpenAI API provider when the key came from the Settings
  key file. A `.env`-keyed box (every provisioned box, the live demo) got 401
  "Missing bearer" on every Codex turn. The provider is now switched on
  whenever the spawn environment carries a key, which is exactly when the
  cockpit is in API-key mode.

### Added
- `scripts/qa/codex-steer.mjs`: drives a live cockpit with a real Codex process
  through the mid-turn cases (steer, Stop then send, burst, immediate
  follow-up, model switch, restart) and fails on any surfaced
  "already has an active writer" (docs/release-qa.md).

## [0.1.24] - 2026-09-10

### Fixed
- **Provisioned boxes had no in-box API secret.** `install.sh` only replaced an
  existing `SHELLTEAM_AI_TOKEN=` line; a `.env` written by hand or by a
  provisioner (owner keys only) never got one, so agents on the box could not
  share ports, publish reports or name apps. The installer now appends it.
- **The daily self-updater died on `sudo apt-get`.** Since v0.1.20 the owner
  loses sudo after the first install, and every re-run of `install.sh` still
  called apt unconditionally. It now skips apt when every package is present,
  and when something is missing without a usable sudo it stops with the exact
  root command instead of hanging.
- **Terminal reconnect flicker.** A dropped socket was retried every 2 s with
  the status line repainted each time. Retries now back off (2 s doubling to
  30 s), the line is written once per outage, and the frame no longer grows
  scrollbars from a 1 px viewport overflow.

## [0.1.23] - 2026-09-09

### Added
- **Named app routes.** Give an app running on a port a stable address:
  `https://<name>.<APP_DOMAIN>` -> port, registered from the box
  (`POST /internal/apps {"name","port"}`) or the Settings card ("App names").
  The name is served through the same gate as `<owner>-<port>`: private by
  default, a share link or the public toggle on the port applies to the name,
  and repointing the name to another port keeps the URL, installed PWAs and
  their localStorage. `POST /internal/ports/share` accepts `{"name": ...}` to
  mint the link on the named host. Reserved labels and `<label>-<digits>`
  names are refused; on-demand TLS issues certificates only for registered
  names. (docs/decisions/20260909-named-app-routes.md)

## [0.1.22] - 2026-09-09

### Added
- **Trial banner.** When `~/.shellteam/trial.json` exists (`ends_at`, `label`,
  `cta_url`, `cta_label`), the dashboard shows a countdown to `ends_at` and one
  link above the tabs. Written by whoever runs a time-boxed box (the
  shellteam.sh live demo); a box without the file renders nothing.

## [0.1.21] - 2026-09-09

### Changed
- **The public repository history starts fresh at this release.** Everything
  before v0.1.21 is now one commit; the code is unchanged. Boxes that sit
  exactly at a release tag (every managed box, every default install) follow
  the new lineage on their next update. A checkout carrying local commits is
  still refused, as before; move it by hand:
  `git fetch --tags && git checkout --detach v0.1.21 && ./install.sh <your flags>`.
- **The self-updater follows a restarted release lineage** when the checkout
  is clean and at a `v*` tag, instead of failing with "not an ancestor".

## [0.1.20] - 2026-09-07

### Changed
- **`--create-owner` no longer leaves agents with root.** The owner user it
  creates gets passwordless sudo for the install run only; the grant is
  removed when the run finishes, so agents on a shared box are confined to
  their own user. `--keep-sudo` keeps the old behaviour for a dedicated box.
  Re-run the installer later from a root shell:
  `sudo ./install.sh --create-owner <name> <flags>`. Existing boxes are
  untouched; to revoke by hand: `sudo rm /etc/sudoers.d/<name>`.
- **The docker group is only added by the browser module**, at the point of
  enabling it, with a note that Docker-socket access is root-equivalent.
  The install run uses `sudo docker` until the group lands.
- **SECURITY.md and the README now compare ShellTeam against running the
  CLI yourself** (approval prompts off, a token-gated web door, opt-in
  modules) instead of against container isolation, and give the recipe for
  sharing a box. The Apps tab states what connecting an app means for agents.

### Fixed
- **`--create-owner` forwarded environment variables were silently dropped.**
  The owner re-exec used `exec VAR=… ./install.sh`, which bash rejects, so
  `SHELLTEAM_ALLOW_UNPINNED_INSTALLERS=1` never reached the real install on
  the one path that provisions a fresh box. Now `exec env …`. Found by
  fresh-box QA of this release.

## [0.1.19] - 2026-09-07

### Fixed
- **Codex: a message sent while it is working no longer errors.** It is held
  until the running turn's process exits, then runs as its own turn, in order,
  like a mid-turn message with Claude Code. The second process used to die on
  the thread's writer lock and paint "already has an active writer" into the
  chat while the first kept running orphaned (SHE-107).
- **Spoken replies survive a phone going to sleep.** A reply that finished
  while the device was disconnected is read out once after the reconnect's
  history replay, for the tab that asked for it (SHE-104).
- **The cockpit can never signal its own session.** The process-tree kill
  helper refuses pids 0 and 1; a test's fake pid had reached `kill(-1)` and
  taken the whole user session down.

### Added
- **Apps tab** in the dashboard: connect GitHub and 500+ apps (Slack,
  Notion, Google Workspace, Jira, …) for every agent on the box. A curated
  shelf plus a search over Composio's whole catalog, one-click OAuth in a
  popup, connected apps listed with a Disconnect button, and a guided setup
  card when no Composio key is set yet. The GitHub card moved here from
  Settings.
- **Copy button on fenced code blocks** in agent replies, with a selection
  fallback on boxes reached over plain http (SHE-108).

## [0.1.18] - 2026-09-04

### Added
- **GPT-6 Astra in the Codex family.** `GPT-6 Astra (max)` (`gpt-6-astra`,
  1.05M context) heads the Codex model list. It needs Codex CLI 0.153.0 or
  newer, and OpenAI enables it per ChatGPT account over the days after launch:
  until yours is enabled the server answers a clear 400, so the Codex default
  stays GPT-5.6 Sol for now.

## [0.1.17] - 2026-09-03

### Added
- **Dreaming can run on Codex instead of Claude Code.** New `DREAM_ENGINE`
  (`claude` | `codex`), switchable from Settings → Dreaming and applied to the
  next sweep without a restart. The nightly knowledge extraction then runs
  `codex exec` on your ChatGPT plan (personal or enterprise), for boxes that
  have Codex but no Claude login. Optional `DREAM_CODEX_MODEL` pins a model;
  by default the Codex CLI's own default is used. Both `ANTHROPIC_API_KEY`
  and `OPENAI_API_KEY` are stripped from the extraction process whichever
  engine runs (docs/decisions/20260903-dreaming-engine-choice.md).

## [0.1.16] - 2026-09-02

### Changed
- **Fable 5.1 replaces Fable 5 as the Claude flagship model** (ID
  `claude-fable-5-1`, verified against the live Models API; 1M context, 128K
  output). Requires Claude Code 2.1.251 or newer — run `claude update` if the
  model is rejected with a version error.

### Added
- **Claude agents can now ask real multiple-choice questions in the chat.**
  AskUserQuestion works headless via the permission control protocol: the
  agent pauses mid-turn, the cockpit shows clickable options (plus a free-text
  answer), and the choice flows straight back into the same turn. Typing a
  normal message instead of clicking releases the agent with your text, and a
  pending question survives page reloads. Codex/OpenCode/Antigravity keep
  asking in plain text (no headless ask protocol exists for them yet — see
  docs/decisions/20260901-structured-questions-control-protocol.md).

### Fixed
- **Quota probes for "no data" providers are now skipped server-side too.**
  The 0.1.15 backoff only stopped an open page from re-polling; a fresh page
  load still respawned the provider CLIs and animated "Checking…" for up to
  ~24s. The control plane now reuses the cached "not reported" result for an
  hour, so the meter lands on the gray bar instantly; opening the quota panel
  still forces a real re-check.

## [0.1.15] - 2026-08-31

### Fixed
- **Quota meter stops re-probing a provider that doesn't report quota.** On
  plans that hide rate limits (seen with a business Codex subscription), the
  meter re-ran the provider probes every five minutes and animated "Checking…"
  forever. It now settles on the gray "not reported" bar after the first
  check, backs off to an hourly re-check so transient failures still
  self-heal, and a click on the meter always re-checks immediately.

## [0.1.14] - 2026-08-31

### Added
- **GLM 5.3 is OpenCode's default model**, replacing GLM 5.2 (near-frontier
  coding at a fraction of the premium-tier price), with **GLM 5.3 Flash** as
  the budget alternative at a tenth of its input price. Kimi K3 stays one
  click away as the premium pick. Both new models verified live through the
  Fireworks relay before shipping.

### Fixed
- **Browser tab: sign-in popups come to the front.** An OAuth popup (Google
  sign-in and friends) opens as a separate page; the tab bar previously only
  refreshed on a five-second poll and never switched to it, so the sign-in
  window sat unnoticed in a background tab. Tab discovery is now a persistent
  push socket and newly opened tabs are raised like a real browser would.
- **Browser tab: reconnects never dead-end.** A page that stops answering CDP
  wedges Steel's cast handler for minutes (it self-heals); the viewer's hard
  five-attempt retry cap turned that into a permanently dead tab with a
  "click to retry" message nothing was wired to. Reconnects now back off to
  30s and keep trying, with watchdogs that drop wedged sockets, verified to
  self-recover across a full control-plane restart with no page reload.
- **Browser tab: closing a background tab closed the active one instead**
  (Steel closes the page the socket is cast to, ignoring the requested id).
  Each close now targets the right tab.
- **CI: dependency audit unblocked.** `pip-audit` fails the public repo's CI
  on pip 26.1.2 (PYSEC-2026-3721); pip is bumped to 26.2.1.

## [0.1.13] - 2026-08-29

### Added
- **Reports tab.** Everything your agents wrote up, in one place: every report
  under `~/reports`, grouped by the workspace the agent was working in when it
  wrote it (recovered from write evidence in session transcripts), with
  search, keyboard-first navigation, a sandboxed preview, and one-click
  publish / expiring share links. Reveals itself once the first report exists;
  nightly dream reports get their own group.

### Security
- `/reports` joins the first-party shell CSP paths, with a regression test
  pinning the bug class that once shipped an unusable Knowledge tab.

## [0.1.12] - 2026-08-22

### Added
- **Audio replies.** A speaker toggle in the composer (Alt+A) delivers the
  agent's final reply as spoken audio alongside the text, powered by your
  ElevenLabs key — markdown, paths and code stripped to listenable prose.
- **Phone composer.** While typing on a phone, the attach/mic/audio buttons
  fold into one chevron so the text field gets its width back.

### Fixed
- Comment tray: comments no longer collapse to a clipped line after a tab
  switch, and hovering a comment no longer scrolls the transcript away.
- The GitHub card in Settings sizes its frame to fit — no more clipped repo
  list behind double scrollbars.
- Codex resume races ("thread already has an active writer") recover silently
  instead of painting a protocol error into the chat.
- One workspace picker: the header workspace button opens the same picker as
  the model menu.

## [0.1.11] - 2026-08-04

### Security
- **The publish toggle is origin-gated.** `POST /api/computers/reports`
  authenticates on the ambient master cookie, and `SameSite=lax` does not stop
  a *same-site* subdomain — the very origins that serve untrusted
  agent-generated HTML. It now refuses any origin but the dashboard, like the
  other capability routes. Previously the reports/+public/ confinement was the
  only thing bounding that gap.

### Fixed
- **The first-run wizard survives a page reload.** Connecting a provider in
  step 2 made the box look "already configured", so a reload before finishing
  (common right after the OAuth tab dance) silently marked onboarding done and
  skipped the GitHub and laptop-import steps. The wizard now remembers its
  step and resumes there.
- **A phantom `.git`** (a directory that is not a valid repository) no longer
  kills the whole laptop inventory.
- An import upload over the box's size cap now explains what to do instead of
  a bare "HTTP 413".

### Added
- **Pick your repos after connecting GitHub.** The GitHub card (onboarding and
  Settings) lists your repositories once signed in; tick the ones to bring
  over and they're cloned into your home folder with live progress. A repo
  whose name collides with an existing folder is flagged, never clobbered.
- **Publish any file from the editor.** The Files tab has a Private/Public
  toggle for the open file: one click (with a confirmation) makes it readable
  by anyone with the link and copies that link, another takes it back. The
  owner may publish anywhere in their home; in-box agents stay confined to
  `~/reports` and `~/public`, which is what those folders are for.
- **The laptop import asks which folder to scan** — your home by default; on
  WSL it also offers your Windows profile (`C:\Users\<you>`), where the real
  setup usually lives. `MIRROR_SCAN_HOME=<dir>` answers non-interactively, and
  repo discovery now covers `Documents\GitHub` and `source\repos`.
- **Folder upload** (SHE-99): the Files tab uploads a whole folder (button or
  drag-and-drop) with its structure intact, and a folder dropped into the chat
  is zipped in the browser and attached as one file.

### Changed
- The connect screen's agent tabs show provider logos with real names instead
  of "CC" / "CDX" (SHE-98).

## [0.1.10] - 2026-08-04

### Fixed
- **The import wizard no longer dies on a machine whose tools print control
  characters.** `manifest.json` was assembled by hand from raw command output,
  so an ANSI escape or CR in a `--version` line (seen on WSL) made it invalid
  JSON; the redaction pass then deleted it as unscrubbable and the wizard
  crashed on a missing file. Every value is now escaped and stripped of control
  characters, and a missing manifest fails loudly at the point it breaks.
- **The mirror stages your Claude account even when the login lives in a
  keystore.** `secure/logins/` only existed as a side effect of copying a
  credentials file, so on a machine where Claude Code keeps its login in
  Windows Credential Manager, or is simply signed out, the oauth-account
  extraction redirected into a directory that was not there: a raw "No such
  file or directory" on the terminal and the account identity silently
  dropped. The directory is now created up front, so the account is staged in
  both cases (including when `HOME` points at another profile, the documented
  way to mirror a Windows environment).

## [0.1.9] - 2026-08-04

### Fixed
- **Full-stack apps work on the box now** (frontend + backend as two ports —
  docs/decisions/20260804-fullstack-apps-on-the-box.md):
  - ShellTeam's own CORS middleware no longer answers (and 400s) the
    cross-subdomain preflights of proxied apps — a frontend on one port URL
    can finally POST to its backend on another; apps own their CORS policy.
  - The Steel browser container moved off `:3000` (Next.js/CRA's default —
    `npm run dev` died with EADDRINUSE on every `--full` box) to `STEEL_PORT`
    (default 3877, autopicked, in `.env`). Existing boxes migrate on their
    next install run.
  - ShellTeam's own service ports are reserved: they can't be flipped public
    (a public API_PORT would have served the control plane with the auth gate
    skipped) and `owner-<API_PORT>` no longer proxies the control plane into
    itself.
  - App-port responses stream through raw: SSE and chunked/long responses
    work, duplicate `Set-Cookie` headers are no longer merged (session +
    CSRF cookie pairs survive), and the 30s full-buffer cap is gone.
  - The WebSocket proxy negotiates subprotocols (Vite HMR's `vite-hmr`).
  - The cockpit's idle reaper no longer kills a CLI whose background Bash
    task (build, server) is still running — tracked from the stream, bounded
    by the same stale cap as subagents.
  - `sqlite3` is actually installed (the agent persona already claimed it).

### Added
- **Share a running app with an expiring link** — parity with file share
  links: `GET /api/auth/share?port=` (owner) / `POST /internal/ports/share`
  (agents). The link redeems into a cookie scoped to that one port subdomain
  and lapses on its own; rotating `OWNER_TOKEN` revokes all links. The
  fully-public port toggle remains for webhooks.
- The agent persona teaches the full-stack workflow: two port URLs, expiring
  share links first, and `systemd-run --user` so apps survive session cleanup
  and service restarts.

## [0.1.8] - 2026-08-03

### Fixed
- **Fresh installs no longer break when uv releases.** The uv installer was
  checksum-pinned against `https://astral.sh/uv/install.sh`, which always
  serves the *latest* release — so when Astral shipped uv 0.12.1 the pinned
  hash stopped matching and the guard (correctly) aborted every fresh install.
  The pin now targets the immutable versioned release artifact
  (`github.com/astral-sh/uv/releases/download/<version>/uv-installer.sh`), so
  it stays true until deliberately bumped
  (docs/decisions/20260803-pin-immutable-installer-artifacts.md). All three
  installer URLs are now constants quoted verbatim by `--plan`.
- **`SHELLTEAM_ALLOW_UNPINNED_INSTALLERS=1` now works with `--create-owner`.**
  The owner re-exec (`su -`, a login shell) wiped the environment, silently
  dropping the escape hatch our own mismatch error tells operators to use.
  Operator-facing variables are now forwarded across the re-exec explicitly.

### Changed
- **One brand type system across the cockpit** (Zilla Slab / Libre Franklin /
  Spline Sans Mono), self-hosted with vendored fonts and licenses — no
  third-party font CDN at runtime.

## [0.1.7] - 2026-07-28

### Security
- **`~/public` is no longer an ambient public mount.** Writing a file there no
  longer puts it on the internet — serving requires an explicit publish (the
  owner-authed toggle, which in-box agents can't call), closing a
  write-to-exfiltration path. `~/public` stays a staging convention; URLs are
  unchanged. Directories are now publishable in one action (segment-prefix
  match). Upgraded boxes migrate existing `~/public` content once so links
  survive, logging the full world-readable inventory
  (docs/decisions/20260728-no-ambient-public-grant.md).
- **Exposure inventory**: `GET /api/computers/exposure` and a boot log line list
  every world-readable path with per-directory file counts — exposure is no
  longer invisible.
- **noindex**: served home content carries `X-Robots-Tag: noindex, nofollow`;
  `/robots.txt` is served unauthenticated with `Disallow: /`.
- **Enumeration throttle**: a dedicated 20/min/IP limiter on unpublished-path
  reads; a private path stays byte-identical to a nonexistent one.
- **Third-party installer scripts are checksum-pinned.** NodeSource (runs as
  root), uv, and Antigravity are downloaded, verified against a pinned sha256,
  and only then executed — a changed upstream aborts the install
  (`SHELLTEAM_ALLOW_UNPINNED_INSTALLERS=1` is the explicit, warned override).
- **Dreaming hardened against memory poisoning**: the extraction prompts treat
  transcripts as untrusted data (dropping any planted "remember this" text),
  `DREAM_REVIEW=all` queues every proposal for owner review, and SECURITY.md
  documents the persistence threat model.

### Added
- **`install.sh --plan`**: prints every change the given flags would make to
  this box (packages, pinned fetches, systemd units, sudoers, Caddy, files,
  ports) and exits without touching anything — the executable FOOTPRINT.md.

### Changed
- The WebSocket terminal now runs on a native async PTY session
  (event-driven reads, no threads) instead of the leftover docker-py exec
  shim — OSS boxes carry no Docker code path for the terminal.

## [0.1.6] - 2026-07-28

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

### Security
- The laptop-side mirror scripts are now served **by your own box**
  (`/api/mirror/mirror-import.sh`, `/api/mirror/mirror-inventory.sh`) at
  exactly its installed version, instead of being fetched from the GitHub
  `main` branch — no mutable git ref or third party sits in the path of code
  that reads your laptop, and the script pair can never version-skew against
  the box (docs/decisions/20260728-wizard-scripts-served-from-box.md).

### Added
- The mirror detects secrets-manager CLIs (Infisical, Doppler, 1Password `op`,
  Vault, teller, chamber): users whose keys live in a service need the CLI
  installed plus one login on the box, and the `migrate` skill now knows that
  instead of walking them through `.env` recreation.
- **Environment Mirror**: `scripts/mirror-inventory.sh` inventories your laptop
  (macOS/Linux/WSL, read-only, secrets excluded + redacted) and the new
  `migrate` skill reproduces the setup on the box — packages, dotfiles, agent
  config, repos — with an honest report of what didn't map (INSTALL.md §5.1).
- **Import wizard** on top of the mirror: Settings (and the first-run wizard)
  mint a one-command import that opens a local checkbox UI on the laptop
  (`scripts/mirror-import.sh`) and uploads the selection over TLS to the box,
  which auto-starts the migration in a cockpit tab. Opt-in "direct only"
  sections carry Claude/Codex logins, authenticated MCPs, and chat history —
  never written into a shareable tarball (contract-tested); the command embeds
  a 24-hour purpose-bound upload pass, not the master token.
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

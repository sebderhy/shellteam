# Security model

ShellTeam is a cockpit for coding agents you already run: Claude Code, Codex,
Antigravity, OpenCode. It runs them **natively on the host**, as the Linux user
you install it as, with no container in between. That is the same footing those
CLIs have when you type them into a terminal on the box. Read this to know
exactly what changes when you run them through ShellTeam instead.

## What changes versus running the CLI yourself

The agent's power is the CLI's power: whatever the Linux user can do, the agent
can do. A planted instruction in a web page, a README, or an issue can steer a
CLI into a bad command in a terminal exactly as it can in ShellTeam. Three
things do change:

1. **Approval prompts are off.** In a terminal, Claude Code asks before it runs
   a command or edits a file, and you can say no. ShellTeam runs every agent in
   full-auto mode so it can work while you are on your phone or asleep. The
   human check that would catch a bad command is gone by design. If you would
   not run `claude --dangerously-skip-permissions` on a machine, do not run
   ShellTeam on it.
2. **The box gets a door on the web.** A URL with one token gives a shell on
   the box, and ShellTeam's own API and file server run as your user. That is a
   larger and younger attack surface than SSH keys. The default install keeps it
   off the public internet (everything binds `127.0.0.1`; reach it over
   Tailscale). The public bind is an explicit opt-in (`--remote` / `--domain`),
   and the sections below describe how that door is built.
3. **Optional modules add channels.** The browser module lets agents read any
   web page and needs Docker-socket access, which is root-equivalent. App
   connections (the Apps tab) let agents read your mail, chats and documents,
   and everything they read there is text they may act on. Both are off until
   you turn them on, and both are described in their own sections below.

Everything else is the CLI's own risk profile, unchanged.

## Sharing a box with other things

The clean answer is a dedicated VPS: agents live there 24/7, nothing else does,
and the box is rebuildable. If you install next to a production app, a client
project, or anything with secrets, the agent can reach whatever your Linux user
can reach. Two rules make that survivable:

- **Give agents their own user with no root.** `sudo ./install.sh --create-owner
  <name>` creates that user, uses root only for the install run, and removes
  the sudo grant when it finishes. Agents are then confined to that user's
  files and to services listening on localhost. Keep the other apps under other
  users with normal home-directory permissions. (`--keep-sudo` keeps root
  access for a dedicated box where the convenience is worth it; re-running the
  installer later is always `sudo ./install.sh --create-owner <name> <flags>`
  from a root shell.)
- **Skip the browser module on a shared box**, or accept that Docker-socket
  access makes that user root-equivalent.

This is a real wall, not a complete one: an agent can still talk to anything on
localhost that has no password, and to the network.

## The honest comparison: SSH vs a web command center

If you run agents over SSH + tmux today, you expose **one battle-hardened
protocol** with decades of scrutiny. ShellTeam in public mode exposes **a web
application** — auth logic, cookie handling, WebSocket upgrades, agent-generated
HTML served on your origins. That is a larger and younger attack surface, full
stop; we won't pretend otherwise.

Two things follow from taking that seriously:

- **The default install never exposes that surface to the internet.** Everything
  binds `127.0.0.1`; remote access for your own devices goes over
  Tailscale/WireGuard, where the web app is reachable only inside your private
  encrypted network — the public internet sees nothing, and there is no relay or
  third-party server in the path. In this mode you keep SSH's exposure profile
  *and* get the cockpit.
- **The public bind is a deliberate, flagged opt-in** (`--remote` / `--domain`),
  gated by a strong generated token over HTTPS, with the residual risks disclosed
  below (split credentials, the same-origin XSS residual, rate-limited auth). If
  you are security-paranoid or the box holds real secrets, don't take that
  trade — stay private. The docs will never nudge you toward the public bind.

## Controls

1. **The auth boundary is the crown jewel.** When bound to any non-localhost
   interface, `OWNER_TOKEN` is **required** (auto-generated, strong) and **HTTPS is
   mandatory** (via Caddy). There is no "open by default on a public IP."
   Localhost-trust applies only to `127.0.0.1`. `install.sh --remote` / `--domain`
   always generate a strong token — never replace it with a weak passphrase, and
   failed-token attempts are rate-limited per IP (escalating to HTTP 429) to blunt
   online brute-force.

2. **Split credentials — the master token never touches page JavaScript or
   URLs.** ShellTeam serves *agent-generated* HTML on its own origins, so the
   credential model assumes a served page can be hostile (XSS via a prompt-injected
   report, a compromised CDN script). The design
   ([decision](docs/decisions/20260702-split-credentials.md)):

   - The **master session** is an `HttpOnly`, **host-only** cookie on the
     dashboard origin. No page script — on any origin — can read it; content
     subdomains never even receive it. It alone unlocks the terminal, the API's
     mutating routes, and file writes.
   - Content origins (file/port subdomains) carry only a **derived, read-only
     credential** (`HMAC(master, "files-v1")`, also HttpOnly). A compromised
     served page downgrades from "owns the box" to "can read files the owner can
     read" — it cannot write files, and reaching the cockpit port with it
     requires a trusted browser `Origin` (the dashboard or the cockpit itself),
     so it can't be ridden cross-origin either.
   - **Named app routes** (`<name>.<APP_DOMAIN>` -> a registered port) are
     resolved to their port *before* the gate runs, so a name is exactly as
     private, shared or public as the port it points at; it is never a new
     trust edge. Names live on their own subdomain, never as a path on the
     dashboard host (that origin holds the master cookie). Only registered
     names get an on-demand certificate.
     (docs/decisions/20260909-named-app-routes.md)
   - **Sharing mints signed, expiring links** (`?sig=&exp=`, S3-presigned style):
     one path, limited time, all links revoked by rotating `OWNER_TOKEN`. A raw
     `?token=` in a URL is **never** accepted; the only URL-borne credentials are
     the single-use enrollment code and a one-time `GET /?token=` redemption that
     immediately sets the cookies and scrubs the query.
   - **`PUBLIC_SHARING=off` closes every anonymous door at once.** For a box a
     stranger drives (a live demo, a box you run for a colleague): public port
     toggles, share links and report publishing all refuse with a clear 403,
     and the read side treats nothing as public even if a published set is on
     disk. The visitor keeps everything they can reach signed in; they just
     cannot host a page on your domain.

   - **Served content is origin-sandboxed.** File URLs are main-domain paths, so
     an agent-written or `~/public` HTML file is served *on the dashboard origin*.
     Every such document is stamped with `Content-Security-Policy: sandbox` (no
     `allow-same-origin`), which forces it into an **opaque origin**: it still runs
     JS, submits forms, and opens links, but the browser no longer treats it as
     `APP_DOMAIN`, so the host-only master cookie is **never attached** to its
     fetches or WebSockets. That neutralises the whole pivot — a prompt-injected
     report or a lure in `~/public` can no longer ride your ambient cookie into
     the terminal, `/api/auth/enroll` (which *does* mint a durable session — the
     reason "can't steal a credential" was not sufficient on its own), `/share`,
     or `/_api/` writes. As a second layer those four capability sinks also reject
     the resulting `Origin: null` (and any non-dashboard origin), so a browser that
     ever mishandled the sandbox header still fails closed. ShellTeam's own
     first-party pages (the Monaco editor, the GitHub connect card) are served from
     dedicated, master-gated routes that are exempt — they need the real origin to
     function. See [decision](docs/decisions/20260717-served-content-sandbox.md).

   *Known residual:* a **same-origin** scripting bug in one of ShellTeam's *own*
   trusted, unsandboxed pages (the dashboard shell or the file-UI routes) would
   still run with your privileges — that is the irreducible core of same-origin
   XSS, now shrunk to first-party code only. One UX cost of the content sandbox:
   a **private** report that pulls in a **private** sibling asset (e.g. `report.html`
   loading a separate `chart.png` under `~/reports`) won't load that asset, because
   the opaque-origin page can't send the read cookie — inline the asset (data URI),
   or publish the report, and it works. Full origin isolation on a **separate**
   content domain (googleusercontent-style) remains a post-v1 candidate.

3. **Prefer private access to public exposure.** The safest way to reach the box
   remotely is **not** to put it on the public internet at all: a private overlay
   like **Tailscale**/WireGuard means only your own devices can reach the cockpit,
   with no public attack surface and no token to guess. Reserve the public URL
   (`--remote` / `--domain`) for when you genuinely need anywhere-access or to
   share — and accept that, behind a strong token + HTTPS, the box is then only as
   safe as that token and the agents you let run. See INSTALL.md "Giving ShellTeam
   a URL".

4. **Dedicated box by default, confined user otherwise.** See "Sharing a box
   with other things" above. Agents are meant to live on the box 24/7; treat it
   as semi-trusted and rebuildable.

5. **Least privilege where it's free.** The stack runs as a non-root user
   (`systemd --user` services), and the product itself never needs sudo: the
   API, the cockpit, nginx and self-update all run as that user. Root is used
   only by the installer (apt, Caddy, a systemd drop-in). `--create-owner`
   therefore grants sudo for the install run and removes it afterwards; the
   docker group is added only by the browser module, and only because the
   Docker socket is the one way to run its container.

6. **Prompt injection is the real residual risk, and it is the CLI's too.** An
   agent tricked by untrusted input has whatever the user has, in a terminal or
   here. What ShellTeam removes is the approval prompt, so: be deliberate about
   which untrusted inputs reach agents, watch what they do (the cockpit streams
   everything), and think before pointing one at an unknown repo or web page.
   The persona's Bash secret-scrub hook is **best-effort only**: it unsets keys
   for the child command, but an injected agent can still read them from the
   parent process env (`/proc/<ppid>/environ`) or `~/.env`. The real containment
   is the confined user or dedicated box (#4) and the opt-in sandbox (#7).

7. **Opt-in sandbox mode (roadmap).** For genuinely untrusted workloads, run a
   given agent inside a container or a `bubblewrap`/`firejail` jail. Off by default
   — it conflicts with the "command the whole VPS" mission — available when needed.

8. **Secrets at rest.** `.env` is `chmod 600` and never committed. `.gitignore`
   covers `.env` and `.mcp.json`. Audit it before any public push.

9. **Hostnames are public by construction.** Any publicly trusted TLS
   certificate lands in Certificate Transparency logs, so `APP_DOMAIN` and its
   subdomains are enumerable by anyone, forever. ShellTeam's security model
   never relies on a hostname being secret — everything 401s by default — but
   don't pick a box name you'd mind seeing in a public roster.

## Dreaming and memory poisoning (the `dreaming` module)

Nightly consolidation gives agents durable memory — which makes that memory a
**persistence target for prompt injection**. The attack: an agent reads a
poisoned input (web page, pasted doc, email), the injected text lands in a
session transcript, the nightly extract distills it into the knowledge tree,
and every future agent in that scope inherits it as trusted background. This
is the one place a one-shot injection could outlive its session, so it gets
named explicitly and defended in layers:

- **The extract prompt treats transcripts as untrusted data.** Anything in a
  transcript that addresses the extractor, asks to be remembered, or claims a
  standing rule the owner didn't state is instructed to be dropped as an
  attempted injection, at any confidence level.
- **Apply is deterministic and scope-enforced.** The LLM only proposes; the
  host-side apply engine enforces per-node scope, dedupes, caps, and
  changelogs every op. Low-confidence proposals queue for owner review instead
  of applying.
- **`DREAM_REVIEW=all`** (in `.env`) queues **every** proposal for review
  before it can influence future agents — choose this if your agents routinely
  ingest untrusted content.
- **Everything is auditable and reversible.** Each run leaves its prompts, raw
  responses, and applied deltas under `~/.shellteam/dream/runs/<stamp>/`, the
  knowledge tree is plain Markdown you can diff and edit, and the changelog
  records which run wrote which line.

Residual risk: with the default `DREAM_REVIEW=low`, a high-confidence-styled
injection that survives the prompt defense would apply without a human in the
loop until you read the morning dream report. If that's outside your risk
budget, set `DREAM_REVIEW=all` or don't enable the module.


## Independent security review (2026-07-18)

An owner-authorized grey-box assessment (live probing of a deployed box + a
white-box source review) found **no live-exploitable auth bypass, file-read,
SSRF, or RCE** against a correct deployment — path traversal, dotfile reads,
cross-origin writes, the port proxy, the WS gates, and the internal API all failed
closed. Its value was defense-in-depth and deployment-footgun hardening, since
several controls depended on the operator deploying correctly. Fixed in response,
so the *code* fails safe rather than trusting the operator:

- **In-box trust now derives from the validated transport peer** (uvicorn's
  `request.client.host`), not a raw `X-Forwarded-For` — a spoofed `127.0.0.1`
  can't claim owner trust even if the port is ever exposed.
- **Fail-closed on a tokenless public bind:** the control plane refuses to start
  when `APP_DOMAIN` is public but `OWNER_TOKEN` is empty (override:
  `ALLOW_TOKENLESS_PUBLIC=1` for a trusted private overlay).
- **The files credential is strictly read-only on the file host, and Origin-gated
  everywhere else.** The audit's first remedy (read-only on *every* port) was
  reverted after it broke the cockpit's own WebSocket — the cockpit is a
  cross-origin sibling, so the files credential is the only credential a browser
  holds there ([decision](docs/decisions/20260719-cockpit-ws-origin-boundary.md)).
  What actually stops a hostile served page from driving the agents is the
  origin boundary: served content runs in a sandboxed (opaque) origin, and the
  cockpit/app ports refuse any mutation or WebSocket whose Origin is not the
  page's own host or the dashboard — including requests with *no* Origin, which
  no legitimate browser flow produces for mutations. The session cookies are
  additionally never forwarded to proxied apps (HTTP forwarding strips them;
  WS forwarding sends no browser headers upstream), so the credential has no
  known exfiltration path a forged Origin could then exploit. The subdomain
  proxy strips client-supplied `X-Forwarded-*` trust headers.
- **Report publishing is confined** to `reports/**` and `public/**` (and rejects
  dotfiles), so a token-holder can't turn `~/id_rsa` into a public URL.
- **On-demand TLS is pinned to the owner's labels** (no stranger-triggered ACME
  cert-mill), **OpenAPI/docs are off by default**, and the dashboard ships
  `frame-ancestors`/`X-Frame-Options`/`Permissions-Policy` with the stack banner
  masked. Every shipped nginx file-server config carries the same hardening
  (`disable_symlinks`, no dotfile-suppressing `^~` prefixes), enforced by tests.

Deliberately **not** yet closed (documented residuals, tracked): a hard guest
isolation boundary (guest mode stays a soft boundary — see below), and full
symlink-canonicalization on the owner-authed cockpit write API.

## Footprint — what runs and what gets written

ShellTeam is additive: it **never writes to your coding-agent config or dotfiles**,
and everything it installs is namespaced and removable (`uninstall.sh`). The full,
audited manifest — including the few global changes it can make (e.g. masking the
system `nginx.service`, and only when no nginx was already in use) — is in
[docs/FOOTPRINT.md](docs/FOOTPRINT.md).

Stronger still, **the default install is pure core**: with no `MODULES=` enabled,
cockpit-spawned agents receive *zero* ShellTeam injection — no skills, no MCP
servers, no appended system prompt — bit-identical argv to a hand-run CLI, and a
contract test in CI keeps it that way
([decision](docs/decisions/20260704-purity-gate-modules.md)).

## A note on Composio

Composio is **opt-in** (enabled only when `COMPOSIO_API_KEY` is set; off
otherwise). Its managed OAuth routes app tokens through Composio's hosted backend
(`backend.composio.dev`). For an "own your data" product this must never be
mandatory — hence off by default, with bring-your-own-MCP as the always-available
alternative.

## Reporting a vulnerability

Please report security issues privately to the maintainer rather than opening a
public issue.

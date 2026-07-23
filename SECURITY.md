# Security model

ShellTeam's OSS edition runs **natively on the host with no container isolation**.
That is a deliberate design choice — the agents are meant to command the whole VPS
(install packages, manage services, edit anything). Because there is no container
wall, security must be explicit. Read this before exposing a box to the internet.

## Threat model

In the multi-tenant Cloud edition, Docker isolates one tenant from another. In the
single-user OSS edition **there are no other tenants**, so that rationale
disappears. The honest reframing: *container isolation was protecting other
tenants, not you from your own agents.*

The two real risks in single-user mode are:

1. **The internet-exposed command center.** Your cockpit can drive the whole box.
   Anyone who reaches it with valid credentials controls the VPS.
2. **An agent going wrong with full host access.** An agent that browses the web
   or ingests untrusted data can be steered (prompt injection) into running
   malicious commands — and there is no container to contain the blast radius.

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
   - **Sharing mints signed, expiring links** (`?sig=&exp=`, S3-presigned style):
     one path, limited time, all links revoked by rotating `OWNER_TOKEN`. A raw
     `?token=` in a URL is **never** accepted; the only URL-borne credentials are
     the single-use enrollment code and a one-time `GET /?token=` redemption that
     immediately sets the cookies and scrubs the query.

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

4. **Disposable-box discipline.** Run ShellTeam on a **dedicated VPS**, not your
   personal machine with unrelated secrets or production access. The right mental
   model: a box where autonomous agents live 24/7 — treat it as semi-trusted and
   rebuildable.

5. **Least privilege where it's free.** Run the stack as a non-root user (the
   `systemd --user` services do exactly this). Use sudo only where you explicitly
   want host management. Don't run agents as root by default. **Note on
   `--create-owner`:** the root-bootstrap flag grants the created owner
   passwordless sudo so the re-exec'd install (and day-2 `git pull`/`systemctl`)
   works unattended. On a box whose core function is running agents that execute
   shell as that user, that means an agent action is effectively root — acceptable
   for a dedicated, disposable ShellTeam VPS, but a conscious tradeoff. Prefer a
   pre-made non-root owner + a scoped sudoers entry if you want a privilege wall.

6. **Prompt injection is the real residual risk.** With no container wall, an
   agent tricked via untrusted input has the whole box. Mitigations: be deliberate
   about which untrusted inputs reach agents; watch what agents are doing (the
   cockpit streams everything); understand the risk before pointing an agent at
   untrusted repos or web content. Note that the persona's Bash secret-scrub hook
   is **best-effort only** — it unsets keys for the child command, but a
   determined injected agent on an unsandboxed box can still read them from the
   parent process env (`/proc/<ppid>/environ`) or `~/.env`. The real containment
   is the disposable box (#4) and the opt-in sandbox (#7), not the hook.

7. **Opt-in sandbox mode (roadmap).** For genuinely untrusted workloads, run a
   given agent inside a container or a `bubblewrap`/`firejail` jail. Off by default
   — it conflicts with the "command the whole VPS" mission — available when needed.

8. **Secrets at rest.** `.env` is `chmod 600` and never committed. `.gitignore`
   covers `.env` and `.mcp.json`. Audit it before any public push.


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

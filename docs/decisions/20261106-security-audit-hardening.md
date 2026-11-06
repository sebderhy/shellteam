# Security audit after the 2026-11-03 incident

Date: 2026-11-06. Tickets: SHE-143 (umbrella), SHE-144..148.

## Context

On 2026-11-03 an attacker on the host's Docker network reached the Steel
browser's DevTools port, stole the cockpit cookie and got a shell. v0.1.48
(SHE-136) closed that path. The owner then asked for an extensive audit. Five
parallel reviews covered auth and sessions, the proxy and file serving, the
cockpit service, secrets and internal APIs, and the install footprint. Each
finding was reproduced (TestClient, throwaway nginx, throwaway containers)
before being fixed; the auth fixes were then re-checked from a machine outside
the box.

## Decisions

1. **Every file document is content, wherever it is served.** The sandbox CSP
   now covers `/_files/` and `/_ls/` (they alias the whole home dir), SVG, XHTML
   and XML, and the owner file subdomain. Only the editor SPA and the GitHub
   widget keep the dashboard origin. The same-origin cockpit proxy serves only
   the GitHub widget.
2. **One cross-site guard instead of per-route checks.** Every state-changing
   request on a dashboard host with a foreign `Origin` is refused in one
   middleware. The per-route `require_trusted_origin` had missed the two cockpit
   proxies, which turned `text/plain` (a CORS simple request) into JSON.
   Token-less boxes also refuse unknown `Host` names (DNS rebinding).
3. **The cockpit gates itself.** It no longer relies on the proxy being the only
   way in (localhost installs, Tailscale, employee containers reach it
   directly): our `Host` only, and upgrades and writes need the cockpit's own
   origin (`<owner>-<port>.APP_DOMAIN` when proxied, the exact origin when direct).
4. **Raw HTML in agent markdown is text.** Prompt-injected pages could make an
   agent echo `<img onerror>`, which ran in the cockpit origin.
5. **The master token never reaches agents.** The cockpit drops `OWNER_TOKEN`
   from its own environment at start; dreaming and vault commands drop it too.
   The cockpit masks box credentials as well as vault values, on the terminal
   sockets too. The access log redacts `token=`, `sig=`, `code=`, `key=`.
6. **Enrolled devices inherit their parent session** (proof time, end date,
   revocation). A stolen cookie can no longer launder itself into a fresh,
   longer-lived session that survives revoking it.
7. **Auto-update installs only signed release tags.** The trusted signers come
   from `deploy/release-signers` of the version already installed. The key is
   `~/.config/shellteam-release/release_ed25519` on the release machine.
8. **The agent browser is firewalled from the host.** A root-owned unit (rules
   inline, never a script from the user-writable checkout) lets Steel's network
   reach only ports 80/443 of the host and drops the cloud metadata address.

## Deliberately not done

- **Agent-layer files at 0664**: they sit inside `~/.shellteam` (0700), and
  tightening them risks employee containers that read them as another uid.
- **`UMask=0077` on units**: agents create files that other tools (Docker
  bind mounts, other users) may need to read.
- **`__Host-` cookie prefix**: the only gain is against a sibling-subdomain
  logout nuisance; it would sign everyone out once.
- **Codex per-token masking**: a value split across streaming frames is not
  masked. The vault keeps values out of output by construction; the mask is
  the safety net.
- **Pinning agent CLI versions on managed boxes**: nightly `@latest` stays; the
  npm supply chain is the agents' own.

## Revisit when

- The release key moves off the VPS (it lives on the box that was breached;
  move it to a hardware key or the owner's laptop when releases leave this box).
- Docker changes how published ports are isolated (Steel relies on Docker 28+).
- A new route serves owner content on the dashboard origin: it must not join
  `_TRUSTED_FILE_UI_PREFIXES`.

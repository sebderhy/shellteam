# Security audit, round two (2026-11-10)

## Context

Four days after the first full audit (20261106-security-audit-hardening.md),
Seb asked for another one. Five read-only reviewers each took one surface:
sign-in and sessions, proxy and files, the cockpit, secrets and background
jobs, install and host. Every finding was read in the code by the maintainer
before it was accepted. Tickets: SHE-159 to SHE-164. Shipped in v0.1.55.

## What was fixed, and the rule behind each fix

1. **A preflight is answered, never forwarded whole (SHE-159).** The SHE-148
   fix let `OPTIONS` skip auth when it carried `Access-Control-Request-Method`.
   That header is the client's to set. Rule: an unauthenticated caller gets
   the app's `Access-Control-*` answer and the status. The app sees only the
   preflight headers: no body, no query string.
2. **The file API is the owner's (SHE-160).** `/_api/` on the main host takes
   the owner session for reads too. The files credential is for reading
   files, and `/_api/zip` is not a file.
3. **A release is a ref whose signed tag carries the same name (SHE-161).**
   `git verify-tag` checks the signature, not that the object signed as
   v0.1.50 sits under `refs/tags/v0.1.50`. The updater compares the two,
   never moves to an ancestor of the checkout, and picks the highest tag that
   is a release, so a forged tag neither installs nor blocks.
4. **Only the dashboard frames the cockpit (SHE-162).** `frame-ancestors`
   lists the dashboard origins, and the cockpit's message handler checks
   `e.origin`. One request that throws answers 500 for that request only.
5. **An origin is a host and a port (SHE-163).** `origin_is_trusted` accepts
   the exact host the request came to, the control plane's port, or https on
   the default port. Guest links are minted by POST.
6. **Token families are kept apart (SHE-164).** Per-user internal tokens are
   `HMAC(secret, "user-v1:" + id)`. Scoped tokens keep their own purposes, so
   one can never verify as the other.
7. **The daily check reads only what its own logger wrote (SHE-164).** A log
   line from another module can hold text an outsider chose.

## Deliberately not fixed in this round

- **Loopback is not a boundary on a shared box.** Any local account can reach
  the cockpit and the file server on 127.0.0.1. SECURITY.md says the box is
  single-user. A real fix is Unix sockets or a per-install hop secret; it
  touches nginx, the proxy and the cockpit and needs its own design.
- Small items: backoff on three master-token guess paths, unpinned global npm
  installs as root, tokens in a few scripts' argv.

## Fixed the same evening (v0.1.56)

- **The one-line installer** carries the signer key and installs the newest
  signed release (the script is served by shellteam.sh, the code by GitHub:
  two places an attacker must hold). The checkout must end ON the release,
  not merely contain it, because the branch itself is not signed.
- **Monaco** is staged by install.sh from the pinned `monaco-editor` npm
  package (integrity in package-lock.json) into the editor's directory.
- **MCP header values reach Codex through `env_http_headers`** and its
  environment (`codex/env.json`, 0600, in the agent layer), checked against a
  real Codex 0.159 run.
- **`--create-owner`** removes its sudoers file from a trap.
- **Public repo:** a ruleset forbids updating or deleting `v*` tags.

## What would make us revisit

- A report of any fixed path being reachable again.
- Multi-user boxes becoming a supported setup: the loopback item becomes
  urgent.
- A release key compromise: the tag-name check does not help there. Moving
  the key off the box is still open from round one.

# 2026-07-18 — Response to the grey-box security audit

## Context

An owner-authorized grey-box assessment (live probing of a deployed box + a
white-box review of ~40k LOC) produced a findings table: 4 High, 8 Medium, 10
Low/Info, and 20+ verified-sound controls. Its bottom line: **nothing was
live-exploitable against a correct deployment** — every auth bypass, file-read,
SSRF, and RCE attempt failed closed. The value was two-fold: one operational
issue on the owner's VPS (unrelated apps bound to `0.0.0.0`), and a set of
repo-hardening gaps that don't bite a correct install but would bite an operator
who deploys slightly wrong. The audit's structural theme: *security depended on a
correct deployment; make the safe path the only path.*

## Decision

Fix the repo-scoped findings so the code fails safe by default, with a regression
test per fix. Shipped in this batch:

| Finding | Fix |
|---|---|
| H1 raw `X-Forwarded-For` grants in-box trust | derive client IP from `request.client.host` / `scope["client"]` (uvicorn-validated) on both HTTP and WS gates |
| H2 (repo-side) / structural / L10 | refuse to boot on a public `APP_DOMAIN` with an empty `OWNER_TOKEN` (`ALLOW_TOKENLESS_PUBLIC=1` escape hatch) |
| H3 file-server nginx follows symlinks | `disable_symlinks if_not_owner;` added to every shipped file-server config; regression tests enumerate them |
| M1 files cred reaches cockpit write API; XFF-by not stripped | files credential is read-only on **every** port (not just `FILE_PORT`); strip all client `X-Forwarded-*` in the subdomain proxy — ⚠️ **the read-only-everywhere half was reverted on 2026-07-19: it broke the cockpit's own WebSocket. See [20260719-cockpit-ws-origin-boundary.md](20260719-cockpit-ws-origin-boundary.md). XFF stripping stands.** |
| M3/L5 report publish can expose any home file | confine `resolve_report_path` to `reports/**`+`public/**`, reject dotfile segments |
| M4 on-demand TLS cert-mill | pin the cert regex to `OWNER_USERNAME` labels |
| M6 token echoed to stdout | print the token only to an interactive TTY, else point at `.env` |
| M7 `^~` suppresses dotfile deny | plain prefixes for `/_ls/` `/_files/` in every file-server config; regression tests enumerate them |
| M8 docs/openapi open | `docs_url=redoc_url=openapi_url=None` unless `SHELLTEAM_DOCS=1` |
| L1 headers | `frame-ancestors`/`X-Frame-Options`/`Permissions-Policy`; mask the `Server` banner |
| L4 non-ASCII token 500 | bytes `compare_digest` in `token_is_owner`/`token_grants_files_read` |

## Deliberately deferred (documented residuals)

- **H4 hard guest isolation** — guest mode stays a soft boundary; SECURITY.md
  already says "don't ship guest mode expecting a boundary." Real fix (separate
  uid/namespace/jail) is the org module's job, tracked SHE-26.
- **M2 secret-scrub** — in-command `unset` can't hide keys from a determined
  injected agent on an unsandboxed box (`/proc/<ppid>/environ`). Documented as
  best-effort in SECURITY.md; the real containment is the disposable box + opt-in
  sandbox (SHE-28). A proper fix (spawn agents with secrets absent) is a larger
  change, not rushed here.
- **M5 passwordless root via `--create-owner`** — kept (day-2 ops need sudo);
  documented as an explicit threat-model tradeoff in SECURITY.md.
- **L6 `safePath` string-prefix** — owner-auth-gated; symlink-canonicalization
  against `realpath(HOME)` in a hot cockpit path carries real regression risk, so
  deferred rather than rushed.
- **H2 operational** (co-hosted apps bound to `0.0.0.0` on the same VPS) —
  operator action on the box, not a repo change.

## What would make us revisit

- If guest mode moves toward general availability, H4/M2/M5 become blocking (the
  soft boundary is only acceptable while guest mode is off-by-default and unshipped).
- If we ever front the control plane with a proxy that *replaces* (not appends)
  `X-Forwarded-For`, re-examine the H1 assumption (still safe: `request.client.host`
  comes from the validated peer regardless).

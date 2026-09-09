# Full-stack apps on the box: unbreak frontend+backend, make sharing safe

**Date:** 2026-08-04
**Status:** decided (implemented same day)

## Context

The GTM decided on 2026-08-03 sells persistence plus a live address: "what
they build is still there tomorrow", against vendor sandboxes where "a database
or dev server the session started does not survive". A code audit the next
morning asked the obvious follow-up: *can a user actually build and test a
conventional two-process app (frontend dev server + backend API) on a box
today?* The answer was no, three independent ways — every one of them fatal
before any amount of prompting or app-side configuration could help:

1. **ShellTeam's own CORS middleware killed the app's API calls.**
   `CORSMiddleware` was registered after `SubdomainProxyMiddleware`
   (Starlette: last added = outermost), so it wrapped the proxy and answered
   every cross-subdomain preflight itself with `400 Disallowed CORS origin`
   (`allow_origins` is exactly the dashboard host). A frontend on
   `owner-5173.APP_DOMAIN` POSTing JSON to `owner-8000.APP_DOMAIN` died at our
   edge; the user's backend never saw the OPTIONS. Verified live against the
   maintainer's own box before the fix.
2. **Steel squatted the most common dev port.** The browser container was
   hardcoded to `127.0.0.1:3000` — the default port of Next.js/CRA/Rails — so
   on any `--full` box `npm run dev` died with EADDRINUSE. And no ShellTeam
   port was reserved from the user in the other direction: `owner-8000`
   proxied the control plane into itself, and the ports API would happily
   flip API_PORT public — skipping the owner-auth gate entirely.
3. **The dev server died anyway.** The cockpit's idle reaper deferred only for
   Task subagents, so a CLI hosting a background Bash task (build, server) was
   SIGTERM'd after 10 quiet minutes; and everything an agent spawned lived in
   the service cgroup, killed by every `systemctl --user restart` (every .env
   edit, every install re-run, the 03:10 auto-update).

Plus fidelity defects on the same path: duplicate `Set-Cookie` headers were
dict-collapsed (corrupting session+CSRF pairs), bodies were fully buffered
with a 30s cap (no SSE, no streaming), and the WS proxy dropped the
`Sec-WebSocket-Protocol` negotiation (Vite HMR requires `vite-hmr`).
Sharing a running app existed only as an all-or-nothing public toggle with no
expiry — files had signed expiring links, ports had nothing. And the persona
told agents `sqlite3` was installed when `install.sh` never installed it.

## Decisions

1. **The proxy gets out of the way.** `SubdomainProxyMiddleware` is now
   outermost relative to CORS: proxied apps define their own CORS policy,
   ShellTeam imposes none. Our CORS still guards the control plane.
2. **Service ports are reserved, symmetrically.** `reserved_service_ports()`
   (API, cockpit, file server, Steel) can never be made public or shared;
   `owner-<API_PORT>` 404s on both HTTP and WS. And Steel moves off :3000 to
   `STEEL_PORT` (default **3877**, autopicked on collision, recorded in .env):
   the box's services must not squat the user's namespace. Existing boxes
   migrate on their next install run (the container is recreated each run;
   the API restarts if autopick moved the port).
3. **App ports stream raw.** Non-file-port responses pass through unbuffered
   (SSE/chunked/long downloads work) with duplicate headers preserved; the
   file-server path stays buffered because the share footer and image inliner
   rewrite bodies there. The WS proxy forwards the client's requested
   subprotocols and echoes the upstream's selection; it still forwards no
   request headers (the cookie-stripping contract test now covers the whole
   call, with `subprotocols` as the single documented exception).
4. **Sharing a running app = a signed expiring link,** exact parity with file
   share links: `GET /api/auth/share?port=` (owner) or `POST
   /internal/ports/share` (in-box agents, SHELLTEAM_AI_TOKEN). The first hit
   verifies `?sig=&exp=`, sets a host-only HttpOnly cookie scoped to that one
   port subdomain, and redirects with the sig scrubbed; assets, API calls and
   the app's own WebSockets ride the cookie until exp. All methods are
   granted on that single port — an app is interactive, a viewer must be able
   to POST to it — and nothing else on the box. Rotating OWNER_TOKEN revokes
   every outstanding link. The fully-public toggle stays for webhooks/APIs
   that need anonymous traffic indefinitely.
5. **Apps outlive sessions via transient user units, not cgroup tricks.** The
   persona now teaches `systemd-run --user --unit=app-<name>` for anything
   meant to stay up — its own scope, outside the service cgroup, survives
   every ShellTeam restart. The idle reaper additionally tracks background
   Bash tasks from the stream (launch = the tool_result announcing the bg ID,
   completion = the injected task-notification) and defers under the same
   1-hour stale cap as subagents — so a build survives, while a dev server
   mistakenly left in background Bash is bounded, not immortal.
   Deliberately NOT done: `KillMode=process` on the services (it would leak
   orphaned agent CLIs on every restart to save processes that now have a
   proper home).
6. **Claims are provisioned true.** `sqlite3` joins the install package list
   because the persona already promised it.

## What would make us revisit

- A user app that legitimately needs the file-port semantics (publish paths,
  share footer) on a custom port — today those are FILE_PORT-only.
- Port share links needing per-link revocation without an OWNER_TOKEN
  rotation — would need a registry like the guest one.
- Vite/Next HMR still failing through the WS proxy in live QA — the
  subprotocol negotiation is the known blocker fixed here; anything further
  (e.g. compression extensions) shows up in a real `npm run dev` smoke test.
- `STEEL_PORT` default colliding with something popular after all — it's one
  .env value.

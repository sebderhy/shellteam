# Release QA gates

The automated suites (`uv run pytest`, `npm test` in `computer/ai-chat`) run on
every push. This page lists the **release gates** — checks that exist because a
bug once shipped past a fully green suite, and that must be re-run before
tagging a release.

Each one is executable. None of them is a checklist item you can eyeball.

## Automated in CI

| Gate | Command | Catches |
|---|---|---|
| Fork-race behavioral | `node scripts/qa/fork-race-ws.mjs` | Two devices forking the same slot at the same instant collapsing into one tab. Drives real `server.mjs` over real WebSockets, so it covers the protocol wiring the unit suite can only emulate. |
| Search responsiveness | `node --test test/session-search-responsiveness-gate.test.mjs` (runs inside `npm test`) | A full-history session search freezing the shared cockpit event loop. Spawns real `server.mjs`, seeds ~300 MB of transcripts, and pings over a real WebSocket while a cold no-match search runs — fails if the worst ping round-trip exceeds 250 ms, or a superseded keystroke still answers. |
| Internal-endpoint CSRF | `node scripts/qa/internal-csrf.mjs` | A webpage the owner visits driving the cockpit's `/internal/*` routes. `/internal/mirror/kickoff` starts an agent from a caller-supplied prompt, and a cross-origin `fetch` with `Content-Type: text/plain` is a CORS-safelisted *simple* request — sent with no preflight, response opaque, side effect landed. Loopback is not a boundary here: the attacking browser runs on the box. |
| Subscription recovery | `node scripts/qa/subscription-recovery.mjs` | A provider blanking expired OAuth tokens while an API key is configured. Drives the real cockpit over WebSocket and requires a live transition from subscription to visibly metered fallback, then back to subscription after reconnect, without a restart. |

`fork-race-ws.mjs` is self-contained: it spawns its own cockpit on a throwaway
`HOME` and a free port, seeds one codex session as a fixture, and needs no agent
CLIs, no network, and no live box. The search-responsiveness gate is the same
shape: a throwaway `HOME`, a free port, a seeded large corpus, real WebSockets.
It exists because the round-7 audit found a two-character search blocked the
loop for 5.3 s on a mature history while both a green unit suite (tiny fixtures)
and a source-string wire assertion missed it — a static test cannot observe an
event-loop stall.

`internal-csrf.mjs` is the same shape and exists for the same reason: the fix
lives in a helper that unit tests cover well, but the vulnerability lived in a
*handler that never called it*. Only a real HTTP request replaying the exploit —
cross-origin simple request, no preflight — proves the route is closed, and the
gate also asserts the negative outcome that matters (no agent process spawned,
no tab state written) rather than just a status code.

## Manual — run before tagging

### Phone geometry

```bash
google-chrome --headless=new --remote-debugging-port=9222 &
BASE_URL=http://127.0.0.1:8000 AUTH_BEARER=$OWNER_TOKEN \
  node scripts/qa/phone-geometry.mjs
```

Loads first-party pages at 320/360/375/390 px and fails on any intrinsic
horizontal overflow or any primary action that is clipped or hidden. It also
opens the first-run wizard through the real product path on five short-phone
profiles (320×568 … 390×844) and fails if the modal opens pre-scrolled, the
title is off-screen, or a setup control's tap box is under 44 px — width-only
emulation reported green while short phones opened halfway through the risk
text (round-6 audit). It needs a
Chrome with a debugging port and a **running instance**, which is why it is not
in CI — and it must be pointed at the *deployed* box, not a dev tree: the Files
SPA once shipped a stale staged copy whose toolbar was unusable at 320 px while
every source-level suite stayed green.

### Codex mid-turn steering

```bash
node scripts/qa/codex-steer.mjs --url ws://127.0.0.1:3456/ws --model gpt-5.6-sol-max
```

Drives the **running** cockpit with a real Codex process: a message sent while
a tool call runs, Stop then send, two messages back-to-back, a follow-up the
instant a turn ends, and a same-family model switch mid-turn. Every case must
answer without "already has an active writer" in the chat (SHE-107/SHE-109).
It needs a Codex login or API key on the box and spends a few short turns,
which is why it is manual. `--scenario hold` then a cockpit restart then
`--scenario resume --slot N` covers the restart case.


## Why these are separate from the suites

Both gates exist because a static test cannot observe the property in question:
intrinsic layout width only exists in a real engine, and a race only exists
across real concurrent connections. When a bug survives a green suite, the fix
belongs here — not only in `test/`.

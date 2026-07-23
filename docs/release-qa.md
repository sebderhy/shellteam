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
| Public snapshot | `scripts/make-public-snapshot.sh` | Private content, residue, or a broken tree reaching the public repo. |

`fork-race-ws.mjs` is self-contained: it spawns its own cockpit on a throwaway
`HOME` and a free port, seeds one codex session as a fixture, and needs no agent
CLIs, no network, and no live box. The search-responsiveness gate is the same
shape: a throwaway `HOME`, a free port, a seeded large corpus, real WebSockets.
It exists because the round-7 audit found a two-character search blocked the
loop for 5.3 s on a mature history while both a green unit suite (tiny fixtures)
and a source-string wire assertion missed it — a static test cannot observe an
event-loop stall.

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


## Why these are separate from the suites

Both gates exist because a static test cannot observe the property in question:
intrinsic layout width only exists in a real engine, and a race only exists
across real concurrent connections. When a bug survives a green suite, the fix
belongs here — not only in `test/`.

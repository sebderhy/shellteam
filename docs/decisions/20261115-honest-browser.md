# The agent browser is honest, not disguised

Date: 2026-11-15 · Tickets: SHE-207 (this), SHE-170 (the browser beside the chat)

## Context

The owner: "our browser gets very easily blocked." We ran Steel with its
defaults: Chromium headless, with Steel's fingerprint injection on. Measured
from this server (OVH, France) on a copy of the pinned image, driven as agents
drive it (Playwright over CDP), on 12 common pages:

| Setting | Detector (BotD) | Refused on first load | Cloudflare check |
|---|---|---|---|
| Defaults | "headless Chrome" | 6 of 12 | spins for ever, a human click included |
| Windowed, no injection, timezone of the address | "headless Chrome" | 5 | same |
| The above + PDF viewer on (+ WebGL) | not a bot | 5 | shows its checkbox; one click passes |

What gave the default away, read from the page: no window; a 800x600 screen in
a 1920x1080 window; no WebGL; no plugins (Steel disables the PDF viewer); UTC
on a French address; "Chrome 139" on a Chromium 144 engine with empty brand
data. Outside evidence agrees: two 2026 studies found stealth features made
agents easier to detect, and a benchmark's datacenter control went from 2% to
50% of protected sites by leaving headless alone.

## Decision

1. **Honest, not disguised.** A real window on a virtual display (Xvfb), no
   fingerprint injection, WebGL through SwiftShader, the PDF viewer on (a
   managed policy, because Steel rewrites the preference), the timezone of the
   address (asked from ipinfo.io at start, the machine's own if that fails).
2. **One launch recipe**: `deploy/browser/run-steel.sh`. Every Steel container
   ShellTeam starts goes through it, and it alone names the image.
3. **The profile is on a volume** (`shellteam-browser-profile`). Sign-ins
   survive restarts and updates; the first update copies the old profile in.
4. **Pinned to Steel's build of 2026-10-30** (Chromium 156), not the newest:
   from the next upstream commit the live view answers no client. The Browser
   tab is that live view, and it is how the owner takes over.
5. **A bot check is the owner's turn.** Agents are told to stop and ask, not to
   retry or get around it; with an honest browser the owner's click passes.
   We do not solve captchas and do not add a solver service.
6. **Paying**: the agent may press the final button after the owner said yes
   in the chat to that shop and that total (owner's decision, 2026-11-15). It
   never types passwords, card numbers or one-time codes.
7. **Two release checks** look at the real browser: `scripts/browser-check.py`
   (what a site sees) and `scripts/qa/browser-live-view.mjs`.

## Why not the alternatives

- **More disguise** (stealth plugins, a Windows identity): the measurements and
  the studies say it is what gets caught, and it is an arms race we would lose.
- **A captcha solver service**: does not fix score-based refusals, costs per
  solve, and puts us on the wrong side of the sites' terms. A person clicking
  their own browser is neither.
- **Steel Cloud or another hosted browser**: their published pass rates on
  protected sites are 40 to 80%, they cost per hour, and the owner's sign-ins
  would live on someone else's machine. Kept as a possible later option.
- **The newest Steel build**: its live view is broken (see 4).

## What this does not fix

The address. Reddit refuses a signed-out visitor from a server, Ticketmaster
refused every load. No browser setting changes that; the plan's R5 (choose the
browser's address in Settings: a rented home-type address, or the owner's home
connection) is the next lever, decided from the 12-page run.

## What would make us revisit

- `browser-check.py` says the browser gives itself away again (a Chromium or
  Steel change): fix the recipe before releasing.
- Upstream fixes the live view: move the pin, after both checks pass.
- The 12-page count gets worse while the identity check stays clean: sites
  moved to weighing the address more, so R5 moves up.
- Steel stops publishing a usable open-source image: launch Chrome ourselves;
  the recipe is five flags and a display.

## Consequences

- The browser uses about the same memory windowed as headless (measured 550 MB
  against 715 MB for the old container after four days).
- One outbound request to ipinfo.io each time the browser container starts
  (docs/FOOTPRINT.md).
- An update restarts the browser, as before; a page an agent was on is lost.

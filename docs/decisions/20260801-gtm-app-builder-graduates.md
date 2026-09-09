# GTM: sell to app-builder graduates, keep OSS as the trust channel

**Date:** 2026-08-01
**Status:** decided

## Context

Three candidate go-to-market motions were on the table:

1. **Developers via the open-source repo** — get devs to install, monetize later.
2. **App-builder graduates** — people who outgrew Lovable/Replit/Base44-class
   tools: they have a real product, hit the platform's ceiling (credits,
   complexity, ownership), cannot run a VPS themselves, and want their app
   live on a machine that is theirs.
3. **"Solopreneurs"** — an umbrella covering both.

Evidence gathered through July 2026: the Show HN flopped; weeks of scout
sweeps on HN/Lobsters produced polite interest and zero buying intent; the
positioning research (`~/reports/shellteam-positioning-v2.html`) surfaced
acute, searchable pain in the graduate communities (r/lovable, r/vibecoding),
including users spending $25-100+/mo on credits and resenting it. OpenAI's
"The Shift to Agentic AI: Evidence from Codex" (June 2026) reports
non-developer individual users grew 137x in ten months, 1 in 5 of 5M weekly
users is a non-developer, adopting 3x faster than engineers.

## Decision

GTM aims squarely at **option 2: the app-builder graduate at the wall** — the
moment someone with a live product hits their platform's ceiling. The paid
offer is the hosted tier ($19/mo box with the harness pre-installed). The
open-source repo is retained as a **credibility and trust channel**
(top-of-funnel for occasional devs), not a revenue motion. The word
"solopreneur" does not appear in our copy.

## Reasoning

The discriminating question is not "who has the pain" but "who can only solve
it by paying us":

- **Developers** feel the pain but can self-solve (VPS, tmux, SSH) — that is
  why the repo is free for them. Conversion to the hosted tier is near zero
  by construction. We ran this experiment; it returned credibility, not
  customers.
- **Graduates** cannot self-solve. For them ShellTeam is not a 2x convenience
  but the difference between possible and impossible — a 10x wedge. They
  already pay $25-100+/mo for the pain we remove: $19 flat plus the Claude/
  ChatGPT plan they arguably should own anyway is cheaper than what they flee.
- **"Solopreneur"** is a demographic, not a pain. The dev solopreneur and the
  graduate need opposite messages; averaging two ICPs produces copy with no
  teeth.
- The pricing pillar is structural: credit-based platforms must meter because
  they pay API rates and resell them; ShellTeam passes through the user's own
  subscription. Competitors cannot copy this without breaking their margins.

The honest competitive frame: for this ICP the real competitor is
Replit-class cloud platforms (their agent, their runtime, metered effort),
not terminal UIs. Our wedge is subscription pass-through and agent freedom.
(Brand rule: competitor names stay out of public copy.)

## Consequences

- Landing page rewritten around the graduate: their app live on their own
  cloud computer, hosted tier as the primary CTA, open source demoted to a
  trust badge.
- Scout repointed at r/lovable, r/vibecoding, r/SideProject-class communities.
  Implemented 2026-08-02 in `~/scout`: sources now split into **neutral ground**
  (Reddit, HN) where a reply from Seb is legitimate, and **listening posts**
  (Replit, Bubble, Glide, Softr, WeWeb community forums) which are read-only by
  policy and feed a new "voice of the customer" section that hands back verbatim
  ICP language for the landing copy. Lobsters and GitHub issues were dropped:
  developer-only supply, and the ranking question is now "who can only solve
  this by paying us". Reddit stays dark until a free script-app API key is
  added (`~/scout/.env`), which is currently the biggest hole in coverage.
- Roadmap items serving this ICP (import/onboarding wizard, in-app domain
  search + wiring, non-dev-safe cockpit defaults) are load-bearing for the
  GTM, not polish.
- Selected the Cloud edition user-facing features may be reintroduced into
  the OSS/hosted stack where they reduce the terminal-skill requirement.

## What would make us revisit

- 3 months of graduate-focused GTM (landing + scout + communities) yields no
  paying customers.
- A credit-based platform ships subscription pass-through (frontier models at
  the user's own plan price), collapsing the pricing wedge.
- The OSS repo unexpectedly starts converting installs into hosted-tier
  demand at a meaningful rate.

# GTM: sell on the far side of the switch, not the near side

**Date:** 2026-08-03
**Status:** decided
**Refines:** [20260801-gtm-app-builder-graduates.md](20260801-gtm-app-builder-graduates.md)

## Context

Two days after the graduate GTM was decided, the question was put more
precisely: *do we target people while they are tired of their app builder, or
after they have already switched to a real coding agent and are working
locally?*

The 2026-08-01 doc framed the ICP as "the app-builder graduate at the wall" and
ranked cohorts by "who can only solve this by paying us". That ranking put
developers last (they can self-solve) and graduates first (they cannot). The
landing page was rewritten accordingly: the hero argued against app builders,
and the ledger compared "on the app builder" with "on your own computer".

Two facts that ranking did not weigh:

1. **The product has a hard prerequisite.** ShellTeam requires the buyer to
   bring a Claude or ChatGPT subscription. Someone still on an app builder does
   not have one. Selling to them needs three separate yeses: accept that the
   answer is a real computer rather than a different builder, buy a $20/mo AI
   plan, then buy the box. Someone already running Claude Code or Codex needs
   one yes.
2. **We cannot yet serve the cohort we ranked first.** The 2026-08-01 doc lists
   the import/onboarding wizard, in-app domain wiring and non-dev-safe cockpit
   defaults as "load-bearing, not polish". They are also unbuilt. A
   non-technical refugee dropped onto a Linux box today is churn and support
   load, not revenue.

There is also a category problem. A frustrated app-builder user's next search
is for another app builder, because that is the category they are shopping in.
Aiming at them means competing to be their *second builder*, which ShellTeam
is not.

## Decision

The graduation moment stays the ICP frame, but it is the **qualifying event,
not the target**. We sell to people on the **far side** of it: they have
already switched to a real coding agent and are running it on their own laptop.

The pain we promise to fix is therefore **the laptop wall**, not the
app-builder wall:

- the run dies when they close the lid
- what they built is at `localhost:3000`, so showing anyone means stopping to
  deploy
- the terminal is on their desk and the idea arrives at 9pm
- a VPS fixes it in theory and costs a weekend in practice, redone on every
  rebuild

The still-on-a-builder cohort is retained as **top-of-funnel content**, not a
sales target. We grow into them once the onboarding gaps close.

## Reasoning

The 2026-08-01 ranking question ("who can only solve this by paying us") is
still the right question, but it has a second term that was left out: *who can
we serve today, and who has already paid the entry fee.*

| | Still on a builder | Already switched, local |
|---|---|---|
| Pain | vague ("credits, limits") | specific ("it stops when I close the laptop") |
| Has the AI subscription | no | yes |
| Next thing they would buy | another builder | somewhere to run their agent |
| Can self-solve | no | yes, and some will |
| Needs onboarding we have not built | yes | no |

The honest tension is the fourth row: the already-switched cohort *can* rent a
VPS themselves, and a slice of them will self-host for free. That is accepted.
The AGPL edition is a credibility asset, and a self-hoster who talks about the
project is worth more than the $19 we did not collect. The $19 tier is sold
explicitly as the weekend they do not spend, plus the rebuild they do not
repeat, which is a convenience claim we can make honestly rather than a
capability claim we cannot.

The pricing pillar is unchanged and if anything sharper for this cohort: they
already own the subscription, so "no markup on the AI" is a comparison they can
verify against their own bill.

## Consequences

- **Landing page rewritten again** (deployed 2026-08-03, live at
  `https://shellteam.sh`):
  - hero kicker "for people already running claude code or codex"; H1 "You
    moved to real agents. Now move them off your laptop."
  - a "works with" strip directly under the hero (Claude Code, Codex,
    Antigravity, OpenCode) as the qualifying signal, so the visitor recognises
    their own setup before reading an argument
  - "the wall" section rebuilt as the laptop wall; the ledger now compares
    "on your laptop" with "on your own computer"
  - secondary hero CTA changed to "Why not just rent a VPS?", which is this
    cohort's real objection, and the FAQ leads with the answer
  - "Can I move my existing app over?" (prose-only, no demo behind it) replaced
    by "Can I move my current project over?" answered with `git clone`, which
    is true by construction on a real machine
  - new FAQ "Does my Claude Code login work on a server?" (headless sign-in is
    the concrete thing this cohort worries about)
  - pricing comparison relabelled from "the app-builder way" to "the metered
    way", and the self-host escape hatch stated in the pricing note
- **Scout sources need repointing again.** The 2026-08-02 change aimed it at
  r/lovable, r/vibecoding and builder-platform forums. Those become listening
  posts for language, not lead sources; the neutral ground that matters now is
  where people discuss running agents. Not yet implemented.
- The import/onboarding wizard drops from load-bearing to sequenced: it is what
  unlocks the *next* cohort, not this one.
- The "outgrew the app builder" story survives in copy as an identity note, not
  as the pain. It flatters and identifies; it does not sell.

## Addendum (same day): the vendor clouds changed the lead claim

Deep research into Anthropic's and OpenAI's hosted runtimes (verified against
their primary docs as of 2026-08-03) found that the morning rewrite's bolded
hero promise was already commoditized:

- **Claude Code on the web and Codex cloud both survive laptop-close**, at no
  separate compute charge, drawing on the user's existing subscription quota.
  "Keeps working after you close the lid" is therefore not a differentiator.
- But both are **repo-scoped ephemeral sandboxes, not machines**: fresh VM or
  container per session; Claude persists only a setup-script snapshot that
  expires in about 7 days, Codex caches a container for at most 12 hours; a
  database or dev server the session started does not survive; **no public URL
  for a running service is documented on either** (and it is actively
  requested, anthropics/claude-code#58255); no shell into Anthropic's VM;
  egress proxied and allowlist-gated by default; Anthropic caps sessions at
  about 4 vCPU / 16 GB / 30 GB and its docs tell heavier users to run on
  their own hardware (Remote Control, whose own docs suggest tmux on a remote
  machine you keep on).

Copy consequences, deployed same day:

- Hero promise re-led with **persistence plus the live address** ("what they
  build is still there tomorrow"); lid-close demoted to a supporting clause.
- Secondary CTA changed from "Why not just rent a VPS?" to **"Doesn't Claude
  already do this?"**, because that is the objection a qualified visitor now
  raises first; the VPS answer stays as an FAQ.
- "The wall" retitled "Your agent needs a computer. A sandbox isn't one." and
  its second paragraph concedes the vendor clouds are genuinely good for
  repo-scoped tasks before stating what resets.
- New first FAQ answers the vendor-cloud question with a factual capability
  table (survives lid-close: both; persistence, services, public URL, shell,
  non-repo work: box only).
- The one-agent-per-sandbox limitation of the vendor clouds makes **portable
  sessions** (core, no module needed) the sharpest technical contrast; the
  feature grid now says it concretely ("hit your Claude limit at 4pm, switch
  to Codex mid-conversation").

A deliberate not-doing: we do not claim the injected agent layer makes agents
"more powerful and reliable". A code audit the same day found no eval or
benchmark anywhere in the repo supporting a quality claim, and the shared
harness only exists with `--full` (default install injects nothing by design).
Marketing claims stay on what is core and demonstrable: persistence, live
URLs, and cross-agent session handoff.

Lead to verify (single third-party source, low confidence): Codex Remote plus
a DigitalOcean plugin reportedly one-click-provisions a customer-owned Droplet
as a remote workspace. If real, it attacks the preconfiguration pitch, which
is the revisit trigger below.

## What would make us revisit

- The already-switched cohort converts, but overwhelmingly to self-hosting
  rather than the $19 tier, at a ratio that makes the hosted tier unviable.
- The onboarding gaps close (import, domain wiring, safe defaults), at which
  point the still-on-a-builder cohort becomes servable and the larger market
  is worth a second landing page rather than a rewritten one.
- An agent CLI ships first-party remote/cloud execution good enough that "move
  it off your laptop" stops being a purchase (this is the standing threat
  recorded in the competitive notes).

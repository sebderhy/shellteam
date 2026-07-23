# CLA (not DCO) for external contributions

**Date:** 2026-07-17
**Status:** Decided, shipped (CLA.md + `.github/workflows/cla.yml`)
**Supersedes:** the DCO half of
[20260712-agpl-and-dco.md](20260712-agpl-and-dco.md)

## Context

ShellTeam is AGPL-3.0, and the maintainer runs (and plans to sell) editions
that are not open source. The post-launch development flow makes the public
repo the primary one, with its code merged onward into private editions —
so **external contributions would flow into trees that commercial products
build on**.

The 2026-07-12 decision adopted a DCO sign-off, reasoning it kept
"dual-licensing possible". That reasoning was wrong: the DCO only asserts
*provenance* ("I have the right to submit this"). It grants the maintainer
**no relicensing rights whatsoever** — an external AGPL contribution under
DCO could never legally be incorporated into a proprietary edition without
hunting down the contributor for permission, one by one, forever.

## Decision

Adopt a **Contributor License Agreement** ([CLA.md](../../CLA.md)), enforced
per-PR by the self-contained `contributor-assistant` GitHub Action (signatures
committed to the repo's own `cla-signatures` branch — no external service, no
secrets). Drop the DCO `Signed-off-by:` requirement: the CLA's "original
creation / right to submit" clause covers provenance, and one signature beats
a flag on every commit.

The CLA is deliberately short and symmetric: contributors keep their
copyright, the contribution stays AGPL for everyone, and the maintainer gains
the right to also license it under other terms.

## Why now

A CLA only works if it covers contribution #1 — retrofitting one after PRs
have merged means chasing every past contributor. Shipping it before the repo
is public costs nothing.

## Trade-offs

- Some contributors dislike CLAs (asymmetric-rights argument). Accepted: this
  is the standard arrangement for maintainer-funded AGPL projects (Grafana,
  MongoDB, Elastic), and the CLA text is honest about why.
- The signing bot adds one comment of friction to a first PR. Accepted.

## Revisit if

- The commercial editions are abandoned → a plain DCO would be lighter.
- A foundation/multi-maintainer structure emerges → re-home the CLA grantee.

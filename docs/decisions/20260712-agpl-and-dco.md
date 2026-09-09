# Decision: AGPL-3.0 license + DCO sign-off on contributions

- **Date:** 2026-07-12
- **Status:** Accepted (LICENSE is AGPL-3.0; DCO required in CONTRIBUTING.md)
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [20260712-public-snapshot-release-process.md](20260712-public-snapshot-release-process.md)

## Context

`LICENSE` is AGPL-3.0 and the public launch is imminent. The maintainer plans
a commercial product on top of the OSS core — a hosted edition and the AI-org
layer. The license and contribution policy have to protect that plan *before*
the first external contribution arrives, because they are much harder to
change after.

## Decision

Keep **AGPL-3.0**, and require a **DCO sign-off** (`git commit -s`,
[developercertificate.org](https://developercertificate.org)) on every
contribution.

## Reasoning

- **AGPL blocks closed-source hosted resale by third parties** — anyone
  offering ShellTeam as a service must publish their modifications — while the
  copyright holder remains free to **dual-license** and sell commercial terms.
  This is the Grafana/MinIO/Plausible model, and it fits a project whose
  natural competitor is "someone else hosts it for you."
- **DCO, not a heavyweight CLA.** A CLA is friction that kills drive-by
  contributions; the DCO is one flag on `git commit`. What dual-licensing
  actually needs is clean provenance — a signed assertion that each
  contributor had the right to submit their code — and the DCO provides
  exactly that, so the option to offer commercial licenses survives external
  contributions.

## Tradeoff acknowledged

Some companies categorically avoid AGPL dependencies, so adoption will be
narrower than under MIT/Apache. Accepted: ShellTeam is a self-hosted product
for individuals and small teams, not a library that needs to be embedded
everywhere.

## What would make us revisit

1. Enterprise adoption is blocked *specifically* by AGPL — repeated, concrete
   "we'd deploy this but legal says no AGPL" signals.
2. The commercial layer is abandoned — with no dual-licensing to protect,
   relicensing to Apache-2.0 becomes safe and widens the funnel.

## Consequences

- CONTRIBUTING.md carries a Sign-off (DCO) section; unsigned PRs get asked to
  amend.
- All contributions land under AGPL-3.0 with clean provenance, so the
  maintainer's dual-licensing ability is preserved indefinitely.
- README/launch copy should state the license plainly — AGPL surprises people
  more in discovery than in disclosure.

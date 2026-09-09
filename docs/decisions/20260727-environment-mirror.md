# Environment Mirror: free onboarding migration, not a paid setup service

**Date:** 2026-07-27
**Status:** accepted (v1 shipped: `scripts/mirror-inventory.sh` + `migrate` skill)

## Context

The #1 objection to moving from a laptop (macOS / WSL) to a ShellTeam box is
not price or capability but sunk cost: dotfiles, brew packages, agent config
(`~/.claude`, MCP servers, skills), repos, toolchains. Competitors (Coder,
Gitpod, Codespaces) solve environment reproduction at the *repo* level with
devcontainers; nobody solves it at the *person* level. This is an agent-shaped
problem — a script can't faithfully translate a bespoke mac setup to Ubuntu,
but an agent consuming a structured inventory can.

The original proposal (via a friend of Seb's) was to sell the migration as a
paid upfront service.

## Decision

1. **Build it, free, as the headline onboarding step** ("Environment Mirror"):
   a read-only inventory script the user runs on their laptop
   (`scripts/mirror-inventory.sh`, curl-able from the public repo) producing a
   `shellteam-mirror-*.tar.gz`, plus a `migrate` persona skill on the box that
   reproduces the environment with agent judgment (brew→apt translation,
   mac-ism adaptation, repo cloning, additive dotfile install).
2. **No upfront setup fee.** The migration is the conversion wedge and the
   retention moat (a migrated user's environment lives on the box); the
   subscription captures the value. Charging ~$150 setup on a $19/mo product
   would tax exactly the friction moment we're trying to remove, against a $0
   market anchor (devs believe their setup is "just my dotfiles repo").
3. **Honest framing: functional migration, not a byte mirror.** GUI apps,
   casks, and ARM/x86 differences don't map; the skill reports what didn't map
   instead of claiming 100%.
4. **Secrets never travel.** Credential files are excluded by whitelist
   construction, staged content is redacted line-wise by pattern scan, and a
   `SECRETS-MAP.md` (paths only) drives a single interactive re-provisioning
   step on the box (fresh `gh auth login`, NEW ssh keypair, keys re-pasted).
   Contract-tested in `tests/test_mirror_inventory.py`.

## What would make us revisit

- Real demand for hand-held migrations of gnarly setups → a paid "concierge
  migration" tier (agent-driven, human backup), or free-migration-with-annual.
- Users asking for laptop↔box *sync* (two-way) — explicitly out of scope for
  v1; it's a different, much harder product.
- The inventory whitelist proving too narrow in practice (support signal:
  "my X didn't come across").

## Consequences

- `mirror-inventory.sh` ships in the public repo's `scripts/` (raw-GitHub
  curl-able); it must stay dependency-free (bash 3.2 compatible for stock
  macOS) and strictly read-only on the source machine.
- The `migrate` skill ships with the `persona` module; pure core is unaffected
  (purity gate untouched).
- Marketing copy must sell the *action*, not a parity claim: "bring your dev
  setup in one command", positioned as Migration Assistant for your cloud
  computer. Never promise a 1:1 mirror — "Environment Mirror" is the feature
  name, and every surface that uses it must in the same breath say what
  travels (tools, dotfiles, agent config, repos) and that the agent reports
  what didn't map.

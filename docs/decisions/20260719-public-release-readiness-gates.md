# Public release readiness is enforced, not inferred

**Date:** 2026-07-19

**Status:** Accepted

## Context

A clean application test suite was not enough to establish that the public
repository was releasable. Fresh-box QA found failure modes outside normal unit
coverage: a root bootstrap could replace an existing checkout, package setup
could prompt indefinitely at a TTY, dependency resolution was not reproducible,
an outdated WebSocket dependency had a published advisory, redistributed assets
lacked complete license records, and the private-to-public transform could leave
lab-only code or references behind.

The public edition also has a narrower architecture than the lab tree: native,
single-owner runtime plus one optional Steel browser container. A release must
prove that this transformed tree stands alone rather than merely proving that the
larger private tree works.

## Decision

Public releases have the following mandatory gates:

1. Python installs use the committed `uv.lock` with Python 3.12 and
   `uv sync --frozen`; cockpit installs use `npm ci`. Dependency audits run for
   both ecosystems.
2. Missing coding-agent CLIs are installed at explicit release-tested versions.
   Existing user-managed CLIs remain untouched. Steel uses a reviewed immutable,
   multi-architecture image digest and must launch a real browser session before
   the optional module is reported healthy.
3. The installer may reuse a recognizable owner checkout but may never replace
   it or recursively change its ownership on a re-run. Third-party bootstrap
   installers run in an isolated temporary home when they would otherwise edit
   shell profiles.
4. Every redistributed vendor asset has a version, upstream source, license
   file, and SHA-256 digest in `third_party/vendor-manifest.json`.
5. CI builds the public snapshot from tracked `HEAD`, removes the lab-only org
   and Cloud surfaces, strips marked shared-code regions, regenerates the public
   lock, checks references to deleted modules, scans for secrets/private residue,
   imports the app, and runs both complete test suites in the transformed tree.
6. ShellCheck runs over every tracked shell script. Ruff rejects syntax and
   undefined-name failures repository-wide. Full Ruff formatting remains scoped
   to newly added release tests until the pre-existing private tree has a
   dedicated formatting migration.
7. Accessibility and narrow-layout behavior are release criteria. Static
   contracts are backed by browser-level Axe, geometry, focus, keyboard, and
   hostile-filename checks during release QA.

## Why

These gates test the artifacts and workflows users actually receive: a fresh
installer, a legally redistributable tree, deterministic dependencies, and the
post-transform public application. Immutable inputs make failures reproducible;
fail-closed export checks prevent a warning from becoming an accidental leak;
and preserving existing tools/configuration keeps ShellTeam additive to the box.

The temporary narrow Ruff policy is deliberate. Enabling repository-wide style
and formatting enforcement in this hardening change would rewrite unrelated lab
code and obscure the release fixes. Critical correctness diagnostics still run
everywhere, while new QA code is fully formatted.

## Revisit when

- a pinned CLI or Steel digest needs an upgrade: update it only with fresh-box,
  architecture, health, and regression evidence;
- the lab and public runtime boundaries move: update the deletion inventory and
  marker contracts in the same change;
- the private tree completes a repository-wide Ruff cleanup: replace the
  baseline-compatible lint step with full `ruff check .` and
  `ruff format --check .`;
- the snapshot becomes a separately maintained source repository: replace the
  transform gate with an equivalently strict synchronization and provenance
  check.

## Consequences

Release preparation takes longer and intentionally fails on stale inventories,
lock drift, missing licenses, vulnerable dependencies, or transformed-tree test
failures. In return, “green” now describes the public artifact—not only the
private source tree—and installer re-runs no longer put existing user state at
risk.

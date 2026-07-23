# 2026-07-20 — Release-QA follow-up: the blocker batch and the three owner decisions

## Context

The independent release-QA agent re-audited the public-release candidate
(lab `cb54dd0`, public `bcc558e`) and returned **NO-GO** with one P0, four
P1s, and eight P2s (`~/reports/shellteam-release-qa-followup-20260720.md`).
Every claim was re-verified against the actual sources/live systems before
fixing; all reproduced.

## What was fixed (branch agent/qa-followup-blockers)

- **QA-01 (P0)** — `frontend/static/meeting-summary.html` was a real internal
  meeting summary (named participants, business metrics), public on GitHub and
  served unauthenticated at `/static`. Contained immediately: deleted from the
  live tree (404 verified), removed from public `main` (`840034e`), removed
  from lab. The residue scanner could never catch it (no secret shapes, no
  private names) — `tests/test_static_inventory.py` now pins an approved
  static inventory and bans document formats on the mount outright.
- **QA-02** — `cli_version` probes now run against a disposable
  HOME/CODEX_HOME/XDG_*; behavioral test drives the real function with a
  hostile CLI and asserts the owner home stays byte-identical.
- **QA-03** — `uninstall.sh` fails closed without a user bus, proves every
  unit stopped before deleting anything, and verifies units+ports down before
  claiming success. Shimmed-systemctl lifecycle tests cover bus-down /
  stop-refused / clean paths.
- **QA-04** — Impeccable (Apache-2.0) redistribution completed: exact upstream
  LICENSE + NOTICE vendored at pinned revision `0a1e1f5`, root NOTICE section,
  manifest entry with per-file SHA-256 for all 32 files, compliance test now
  inventories `.agents/skills`.
- **QA-05** — composer send/attach/mic carry `aria-label` + `type=button`
  (Send was an unnamed button — WCAG 4.1.2); node test pins them.
- **QA-06** — INSTALL.md example now RFC 5737; scanner catches dashed
  sslip/nip IPv4 hostnames via normalize + `is_global`.
- **QA-08** — contributor-assistant pinned to the commit behind v2.6.1.
- **QA-09** — `--no-server-header` in the API unit; verified live: exactly one
  `server: ShellTeam`, direct and through Caddy.
- **QA-10** — dashboard deep links validate against actual tab visibility
  (module-aware) after awaiting the knowledge probe; `#knowledge` works.
- **QA-12** — `SuccessExitStatus=143`; verified live: restart logs no failure.
- **QA-13** — dead `site/index.html` removed.

## Deliberately not done in this batch

- **QA-11 (44px touch targets)** — real product-design work on the phone
  header; doing it blind inside a security batch risks the visual system the
  audit scored 17/20. Next UI iteration, with the reviewer's suggested
  `/harden` → `/adapt` → `/audit` loop.
- **Full-VPS install/uninstall rehearsal + real-DNS `--remote` TLS QA** —
  needs a disposable real box; bundle with the Hetzner provisioning rehearsal.

## The three owner decisions (explicitly NOT taken autonomously)

1. **Public-history containment.** The leaked artifact remains in the public
   repo's two pre-removal commits. Options: (a) leave — content is
   low-sensitivity business notes, HEAD is clean, discoverability near zero;
   (b) delete + recreate the repo from a clean snapshot — loses stars/links,
   fully removes history (force-push is banned: refs/pull caches leak);
   plus GitHub's sensitive-data removal process for cached views.
   The owner hadindependently asked about restarting history for cosmetic reasons;
   with a real leak the case is stronger.
2. **QA-07: public repo settings** (branch protection, secret scanning, push
   protection, vulnerability alerts, required checks) — GitHub mutations on
   the public repo; commands ready.
3. **Hero image**: `docs/assets/hero.png` visibly contains the owner's real
   product domain and home path (text scanners cannot inspect pixels) — but
   its caption sells "not a mockup — a real session". Redaction trades
   authenticity for the no-real-domains rule. Brand call.

## Revisit triggers

- Any new file class lands under `frontend/static` → extend the inventory.
- The skills set changes → re-pin manifest digests + lock hashes together.
- A real-VPS lifecycle rehearsal exists → wire it into the release runbook.

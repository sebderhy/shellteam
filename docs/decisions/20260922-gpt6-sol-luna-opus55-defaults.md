# GPT-6 Sol as the Codex default, Opus 5.5 as the Claude default

Date: 2026-09-22

## Context

Two model launches landed the same day: Anthropic's Claude Opus 5.5
(`claude-opus-5-5`, $4/$20 per 1M tokens, 1M context, "Fable-level on most
work at 40% less than Opus 5") and OpenAI's GPT-6 Sol (`gpt-6-sol`, $2/$10,
1.05M context, "balanced model for interactive and agentic coding") and GPT-6
Luna (`gpt-6-luna`, $0.10/$0.50, the cheap tier). Both were checked against the
live provider model lists and each was driven end to end from this box before
the catalog changed.

Two facts shaped the decision:

- **New models need new CLIs.** Claude Code 2.1.263 refused Opus 5.5 with a
  400 naming 2.1.280 as the minimum. Codex 0.153.2 sent GPT-6 Sol and Luna
  without metadata and the server refused both on a ChatGPT login ("not
  supported when using Codex with a ChatGPT account"); the same login answers
  on Codex 0.156.0. A plain API key answered on both versions. This is the
  third time a launch has hinged on a CLI version (Fable 5.1 needed 2.1.251,
  Astra needed Codex 0.153.0).
- **The catalog is a menu, not an archive.** Every GPT-6 model beats its
  GPT-5.6 namesake at half the price with 2.6x the context; Opus 5.5 beats
  Opus 5 at 80% of the price. A superseded entry is strictly worse on every
  axis the picker shows.

## Decision

1. **Claude Code default: Opus 5.5.** Fable 5.1 stays first in the list as the
   top tier; Sonnet 5 and Haiku 4.5 stay. Opus 5 is retired.
2. **Codex default: GPT-6 Sol (max).** GPT-6 Astra stays first as the
   flagship, Sol also ships at `ultra` (the 4-agent effort, verified accepted),
   Luna (max) is the cheap tier. The whole GPT-5.6 family is retired. Sol, not
   Astra, is the default for the same reason Opus, not Fable, is the Claude
   default: on a subscription the flagship burns the plan's quota about five
   times faster, and the balanced model is the one to reach for by default.
3. **ShellTeam does not upgrade a CLI it finds on the box.** `install.sh`
   installs coding-agent CLIs at latest only when they are missing; an
   existing CLI belongs to the user (docs/design/vps-footprint.md). The
   cockpit surfaces the provider's version error verbatim, which already names
   the fix (`claude update`; `npm install -g @openai/codex@latest`), and the
   changelog states the minimum versions. Operators of managed boxes upgrade
   the CLIs as part of the rollout.

## What would make us revisit

- A GPT-6 Terra ships: it would slot between Sol and Luna and the default is
  worth re-checking against its price.
- Anthropic's Sonnet 5.5 / Haiku 5.5 ship ("in the coming weeks" per the
  announcement): each retires its 5.x predecessor the same day.
- CLI version drift starts breaking default models on auto-updating boxes in
  practice. Then a ShellTeam-installed CLI (one `install.sh` put there itself)
  could be upgraded by the self-update step while user-installed CLIs stay
  untouched; the marker to tell them apart does not exist today.

## Consequences

- Boxes on Claude Code < 2.1.280 or Codex < 0.156.0 see a clear 400 on the
  new defaults until the CLI is updated; the older models in the picker keep
  working.
- Saved tabs pinned to a retired id migrate to the family default on the next
  cockpit start (`resolveModelId`), so the removal is safe by construction.
- The live-demo box's on-us model moves from GPT-5.6 Terra to GPT-6 Sol,
  cheaper than Terra was and verified on the demo key.

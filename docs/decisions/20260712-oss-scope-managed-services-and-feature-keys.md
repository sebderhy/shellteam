# Decision: OSS scope — drop managed media services, keep three feature keys

- **Date:** 2026-07-12
- **Status:** Implemented (commit `eaa5b9e` on `release-prep`)
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [20260702-core-plus-modules.md](20260702-core-plus-modules.md),
  [20260704-purity-gate-modules.md](20260704-purity-gate-modules.md),
  [20260708-dreaming-v1.md](20260708-dreaming-v1.md)

## Context

Pre-launch scope pass. The repo carried a tray of "managed" AI-generation
services inherited from the Cloud edition — media-generation skills paired with
`/internal/ai` endpoints, each dragging its own provider key — plus dead
endpoints with zero callers. Every one of them widened the key surface a fresh
install has to understand, and none of them is what ShellTeam *is*: a cockpit
for coding agents, not a managed media API.

## Decision

The OSS edition removes all managed media/AI-generation services:

- **Deleted pairwise (skill + `/internal/ai` endpoint):** `generate-image`,
  `edit-image`, `tts`, `dialogue`, `generate-document`, `x-search`.
- **Deleted dead endpoints:** `ma-chat` (and its whole multi-provider chat
  table), `dream-extract`, `dream-digest` (dreaming runs on `claude -p`, not a
  hosted model).

Skills are the **user's own to define** — an agent on the box can write a
skill against any API the user brings a key for. ShellTeam ships only the
skills that are conventions of the product itself: `frontend-design`,
`external-apps`, the `gws-*` family, and the reports conventions.

**Kept AI plumbing** (core UX or agent enablement, not media generation):

- **STT** (ElevenLabs) — cockpit voice input is core UX and in the demo.
- **The Fireworks proxy** — enables the OpenCode agent.

**Feature keys reduced to exactly three**, each settable from the
Settings/onboarding UI:

| Key | Enables |
|---|---|
| `FIREWORKS_API_KEY` | OpenCode agent |
| `COMPOSIO_API_KEY` | App connections module |
| `ELEVENLABS_API_KEY` | Voice input (STT) |

TTS/dialogue are deliberately dropped even though the *same* ElevenLabs key
covers them: the key is justified by voice input, not by media-generation
skills. A user who wants TTS adds a small skill against their own key.

**Dreaming needs no key.** It runs headless `claude -p` on the owner's Claude
subscription — which requires the Claude CLI on the box, a documented
limitation.

## What would make us revisit

1. Users repeatedly ask for built-in image/TTS skills — demand would justify
   re-shipping a curated pair or two.
2. A credible BYO-key skill marketplace pattern emerges — distribution would
   beat bundling, and the "skills are the user's own" stance gets tooling.

## Consequences

- `api/routers/ai_tools.py` shrank 1035 → 203 lines; `anthropic` + `openai`
  Python deps dropped.
- `.env.example` / `install.sh` / onboarding now speak exactly three feature
  keys (plus the coding-agent `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` fallbacks).
- The Show HN copy can no longer claim built-in media generation — and doesn't
  need to.

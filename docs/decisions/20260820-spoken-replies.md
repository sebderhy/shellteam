# Spoken agent replies: a mode, split between the agent and the box

**Date:** 2026-08-20
**Status:** Adopted, shipped in the cockpit composer.

## Context

The cockpit could already listen (mic button → ElevenLabs Scribe → the composer)
but could not speak. The ask was the mirror image: a way to say "answer me out
loud" and get audio back, for the times you are cooking, walking or driving and
cannot read a screen.

The obvious implementation is one of two extremes, and both are wrong on their
own:

- **Purely agent-driven** (a header in the prompt, the agent calls a TTS tool).
  Depends on the agent remembering, every turn, on every CLI. A skipped tool
  call is a silently broken feature.
- **Purely mechanical** (the box speaks whatever text lands, no prompt change).
  Deterministic, and unlistenable: a reply written for the eye is a table, three
  code blocks and a URL. Read aloud it is noise.

## Decision

Ship it as **one mode, two halves, split along the line between judgment and
mechanism** — the same split this codebase already uses elsewhere: the LLM owns
understanding, the host owns what must always happen.

**The agent's half (judgment).** The composer's speaker toggle appends
`[Audio reply: …]` to the message, in the same bracketed convention as
`[Attached file: …]`. It asks for spoken prose: answer first, a few sentences,
no markdown, no tables, no code blocks. Only the agent can decide what the
listenable version of an answer is.

**The box's half (mechanism).** `computer/shared/speakable.mjs` strips markdown
to prose before anything is synthesised — code fences, tables, URLs, path-shaped
inline code, heading and bullet markers — and trims to 2400 characters at a
sentence boundary. This runs whether or not the agent cooperated, which is what
makes the feature reliable rather than best-effort. It is also why the header
can promise that paths and links may stay in the text: they survive on screen
and never reach the ear.

**Audio accompanies the reply, it does not replace it.** The player is inserted
above the text; the text stays. A transcript you can skim, search, copy and
scroll back through is the thing that makes a cockpit usable, and 30 seconds of
audio is a bad way to answer "what was that file path again?".

Other choices worth recording:

- **`eleven_flash_v2_5`, voice "River"**, both overridable via
  `SHELLTEAM_TTS_VOICE` / `SHELLTEAM_TTS_MODEL`. Flash is the low-latency model
  and half the credit cost of `eleven_v3`; a reply lands mid-conversation, so
  latency beats expressiveness.
- **The last `text_done` of a turn is what gets spoken**, not every text block.
  Agents narrate between tool calls; the closing block is the answer.
- **A reply with nothing sayable in it returns 204**, and no player appears.
  Spending quota to synthesise silence, or printing an error under a perfectly
  good reply, are both worse than saying nothing.
- **The mode is sticky** (localStorage). It reflects a situation you are in for
  an afternoon, not a per-message choice.
- **Its own rate limit** (300/day) rather than sharing the 50/day `_ai_limit`
  with transcription. Voice input happens a few times a day; voice output
  happens every turn, and one counter for both would go quiet by mid-afternoon.

## What this does NOT change

- **The guest STT token still buys exactly transcription.** `/internal/ai/tts`
  is behind `_verify_token` (master only), and an employee cockpit reports
  `tts: false`, which is the truth rather than a button that 401s on first use.
  Lending voice output to employees means minting a token for it, never
  widening the voice-input one. Pinned by
  `test_never_speaks_on_the_owners_quota`.
- **Managed relay boxes get no voice output.** The relay contract in `stt.py`
  exposes `/stt` only. Calling a `/tts` that may not exist there would fail
  mid-reply on someone else's box, so those installs say "add a key" instead.
  Revisit when the relay grows a `/tts` endpoint.

## Known gap, deliberately not closed here

`POST /speak` is as exposed as `POST /transcribe` and `POST /upload`: any page
the owner visits can call them cross-origin and burn a little quota, because
[loopback is not a boundary](20260717-served-content-sandbox.md) — the
attacking browser runs on the box. A same-origin check on `/speak` alone would
be both inconsistent and risky to get right in isolation: the cockpit is reached
through Caddy and the control plane, so `Origin` and `Host` legitimately differ
and a naive comparison would break proxied access. The fix belongs at the layer
that knows the real origin set, applied to all three routes at once. Logged
here rather than left implicit.

## What would make us revisit

- Latency complaints on long replies → stream synthesis instead of waiting for
  the full turn, or switch the trim to speak the first paragraph immediately.
- Agents ignoring the header often enough that replies still sound like
  documents → move the instruction into the agent layer's system prompt rather
  than the message.
- A second consumer of `speakable()` (a skill, a digest, the dreaming summary)
  → the transform is already a standalone module for exactly that.

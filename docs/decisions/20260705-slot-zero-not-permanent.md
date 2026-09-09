# Slot 0 is a cold-start default, not a runtime invariant

*2026-07-05*

## Context

The cockpit's conversation tabs are "slots". Historically **slot 0 was treated
as permanent**: `session-manager.mjs` calls `ensureSlot(0)` at module load, the
query getters default to `slotId = 0`, `server.mjs`'s `close_tab` handler
refused to close slot 0 (`if (slot !== 0)`), and `restoreSlots()` always
re-created it. The client also bootstraps a local slot 0 on page load so there's
a tab to type into before the WebSocket connects.

This produced **SHE-50**: a user who closed their first tab saw it reappear.
The client removed the tab locally and told the server, but the server kept
slot 0 and re-materialized it on the next status broadcast; a restart restored
it from the legacy session file. Even after the first fix, a subtler vector
remained — `buildStatus()` read top-level state via `getCwd(0)`/`getSessionId(0)`
/…, and those getters call `ensureSlot(0)`, **re-creating slot 0 as a read side
effect**. So any status broadcast after a close resurrected the tab and
re-persisted it to `TABS_FILE`.

## Decision

**The invariant is "at least one user-visible slot exists", NOT "slot 0
exists".** Any tab, including slot 0, is closable as long as one user slot
survives.

Concretely:
- `close_tab` deletes any slot while `userSlots.length > 1`; a refused close is
  logged and answered with a fresh status broadcast (never a silent no-op).
- `buildStatus()` reads its legacy top-level fields from the **lowest existing**
  user slot (`listSlots()[0]`), never a hardcoded `getCwd(0)` — reads must not
  resurrect a slot.
- `restoreSlots()` only re-creates slot 0 when it was among the saved tabs (or
  when nothing was saved, as the cold-start fallback); it drops the pristine
  startup slot 0 when the user's saved set omits it.
- The client drops its pristine bootstrap slot 0 on the first snapshot when the
  server has none (guarding against discarding a draft the user is mid-typing).
- `ensureSlot(0)` at module load stays — it seeds the very first tab on a fresh
  box, which is the only place slot 0 is still special.

## Consequences

- Users can close any tab; nothing reappears within a session or across a
  restart on a single device.
- Code must **not** assume slot 0 exists at runtime. New top-level/default-arg
  reads against slot 0 are a regression risk — read an existing slot id.

## Known limitation (deliberately not fixed here)

**Multi-device / reconnect resurrection.** On reconnect the client re-sends
`create_tab` for every local slot. If device B still holds a (non-pristine)
slot 0 that device A closed while B was offline, B's re-push re-creates it
server-side and it reappears on A. Fixing this correctly needs a closed-slot
tombstone or a fully server-authoritative slot model (the client renders no tab
until the first snapshot). That is a larger design change than the reported
single-device bug warrants; tracked as a follow-up. **Revisit if** multi-device
use becomes common or a tombstone/authoritative-slots refactor lands.

# A gate between agents and the browser

Date: 2026-11-15 · Ticket: SHE-170 · Plan: docs/plans/active/browser-handoff/prd.md

## Context

Agents drive the box's one browser over CDP, through Playwright's MCP server,
which spoke to the browser directly. The owner could already click in the live
view. So an agent could click while the owner typed a password, two chats
browsing at once shared one page, the cockpit could not know which chat was
browsing, and an agent had no way to say "your turn" and stop.

## Decision

1. **Agents' browser tools connect to a gate, not to the browser.** The gate
   (`computer/ai-chat/lib/browser-gate.mjs`) runs inside the cockpit service
   on loopback (`BROWSER_GATE_PORT`, 3878) and forwards to Steel. The launch
   layer names the gate's port and never Steel's.
2. **The owner's turn is enforced there.** While the owner has control, every
   command an agent sends is answered with a refusal in words and never
   reaches the browser. Events still flow, so the agent's view is current
   when control comes back.
3. **One chat browses at a time.** The first chat to send a command holds the
   browser while it is working (or for 3 minutes of silence at most); another
   chat is refused with the holder's name.
4. **A connection is matched to its chat by the process tree.** The cockpit
   starts each agent with `SHELLTEAM_CHAT=<slot>`; the gate finds the process
   behind a connection's source port and walks its ancestors. Nothing is asked
   of the agent, it works the same for all four, and a process cannot pass for
   another chat.
5. **Asking for the owner's turn is a shell command**, `shellteam-browser ask
   "<one sentence>"`, which posts to the gate (same identification). The chat
   reads "Needs you" until the owner hands the browser back or writes to it.
6. **The hand back resumes the agent** with a cockpit notice telling it to
   look at the page again before acting.
7. **The live view gates the owner too**: until they take control their
   clicks and keys are not sent. One side drives at a time, and the bar says
   which.
8. **The bar lives in the live view page**, the state comes from the cockpit
   through the dashboard over a same-origin BroadcastChannel (the live view
   and the dashboard share an origin; the cockpit is another).

## Why

- **Why a proxy and not a rule in the prompt.** A rule is a hope. The plan
  requires that an agent's click be refused, including when a page tells it
  to continue; only something in the path can do that.
- **Why inside the cockpit.** It already knows the chats, their state and the
  pages to tell. A separate service would need all of that passed to it.
- **Why the process tree and not a chat id in the tool's address.** The
  tool's config is one static file per agent type; a per-chat address means
  four different spawn-time mechanisms (and Codex filters the environment it
  gives its tools). The process tree needs none, and cannot be spoofed by an
  agent passing another chat's number.
- **Why a shell command for "ask" and not a fifth MCP server.** Every agent
  can run a command; an MCP server is a process per chat and a config per
  agent type for one call.
- **Why refuse everything, reads included.** During the owner's turn they may
  be typing a password or reading their bank. An agent that can still take
  snapshots is watching. Other products stop capturing during a take-over
  for the same reason.
- **Why page scripts are answered as a script that threw.** Measured with the
  real tool: Playwright retries a protocol error on evaluations until its own
  30 s timeout and reports "Timeout", so the agent waited and never learned
  why. Answered as an exception, the reason comes back in milliseconds.

## What would make us revisit

- Playwright MCP changes how it reports errors: `scripts/qa/browser-gate-e2e.mjs`
  fails, fix the refusal shape.
- A browser per chat (plan item B15): the "one chat at a time" rule goes, the
  gate routes each chat to its own browser instead.
- An agent type that starts its tools outside its own process tree (a daemon):
  the chat is not found; give that agent an explicit chat header instead.
- Owners find "Take control" before every click tedious: let a click in the
  live view take control by itself.

## Consequences

- If the cockpit is down, agents cannot browse (they run in it anyway). If the
  gate cannot listen, the cockpit says so loudly in its log.
- Agents started from the terminal are one anonymous "terminal" chat: gated
  like the others, but they cannot ask for the owner's turn.
- An employee's cockpit keeps reaching its own browser sidecar directly.
- The 20-run checkout test (the agent stops before paying, every time) has
  not been run; it needs a real agent and a test shop.

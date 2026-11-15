# Keys stay with ShellTeam: an MCP relay, and one list for every key

Date: 2026-11-15. Ticket: SHE-203. Builds on `20261105-secrets-vault.md`.

## Context

On 14 Nov 2026 a research agent opened the Antigravity plugin's
`mcp_config.json` to see how it was built, and the Composio key was printed in
full into its transcript. The key was in that file because ShellTeam wrote the
Composio and Linear keys, in plain text, into every launch-layer file that
configures an MCP server: about 35 files on the owner's box, read by every
agent.

The owner then replaced the key in Settings → Secrets and found the old one had
never been there: ShellTeam's own keys had a separate "Feature keys" card that
wrote `.env` only. Checking the two copies also showed the vault's
`OPENAI_API_KEY` was dead (OpenAI answered 401) while ShellTeam's copy worked.

The owner's ask (15 Nov): the secrets feature should be both very convenient
and very secure, and any trade-off between the two should come to him.

## Decision

- **MCP relay.** Servers that need a key are reached at
  `http://127.0.0.1:<API_PORT>/internal/mcp/<server>[/<project>]`. The relay:
  - adds the key when it forwards (Composio's `x-api-key`; Linear's
    `Authorization`, with the project's own key when the project has one);
  - reads the key from ShellTeam's `.env` at that moment, so a replaced key
    works on the next call with no rebuild or restart;
  - forwards streamable HTTP as is (POST, the GET event stream, DELETE, and
    the session headers both ways);
  - answers only on loopback, and only to a token derived for this purpose
    (`internal_auth.mcp_relay_token`) that opens nothing else.
  The launch layer carries that token and the address, never a key. A build
  deletes runtime configs written before. The cockpit (Node) builds the
  per-project Linear server from `layer.json`'s `mcp_relay` entry. An employee
  box has no relay: the key it uses is its own project's.
- **One list.** ShellTeam's own keys (Fireworks, ElevenLabs, Composio, and now
  Linear) are entered in Settings → Secrets like every other key:
  - a pasted one is checked with its provider first (refused = kept nowhere);
  - it is kept in the vault, written to ShellTeam's `.env`, and live in the
    API at once;
  - turning a module on or off still needs a restart, and the result says so.
  The Feature keys card and `/api/settings/feature-keys` are removed. Features
  without a key are listed at the top of Secrets.
- **Adoption.** At start, keys found in ShellTeam's `.env` join the vault. A
  vault value that differs from ShellTeam's copy is shown on its row, never
  overwritten: which one is right is the owner's call. ShellTeam's sign-in
  token and internal credentials are not adopted.

## Why

- A relay is the only way to keep a key out of what agents read while still
  letting agents use the tool. It follows the existing `/internal/ai` pattern.
- Reading the key at forward time makes rotation instant: better UX and
  better security together.
- One list removes the gap that hid the Composio key and let two OpenAI keys
  drift apart.

## Limits (stated plainly)

- Agents run as the owner's Linux user. `.env` and the vault file stay
  readable to an agent that sets out to read them. The relay and the vault
  stop accidental exposure (a file opened to inspect it, a log, a
  screenshot); they don't stop a determined agent. Closing that would mean
  running agents as another user, a large change to the "agents command the
  whole box" design: a product trade-off for the owner.
- Keys the owner's own apps need still live in those apps' `.env` files, by
  design (the vault writes them there).

## Revisit when

- Another MCP server needs a key: add it to `mcp_relay.SERVERS`, never to a
  layer file. `tests/test_mcp_relay.py` fails if a key value appears in any
  layer file.
- The owner asks for keys hidden from agents entirely: separate Linux user for
  agents, or a placeholder-and-proxy scheme for apps.

## Consequences

- On the owner's box on 15 Nov: zero layer files hold a key (was about 35).
  Claude Code used Linear and Composio through the relay. Gemini, ElevenLabs
  and Linear keys were adopted into Secrets. The dead vault OpenAI key was
  replaced with the working one.
- The cockpit service must restart once for per-project Linear servers to use
  the relay (until then the old cockpit code writes them as before).

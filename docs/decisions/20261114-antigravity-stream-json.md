# Antigravity: live streaming, current Gemini models, refusals in plain words

Date: 2026-11-14. Ticket: SHE-113.

## Context

The Antigravity adapter was built in July for agy 1.0.16, which returned one
JSON blob per turn: the tab showed nothing until the whole answer landed. On
14 Nov the owner's box runs agy 1.5.9, and both models in our catalog
("Gemini 3.1 Pro (High)", "Gemini 3.6 Flash (Medium)") are names agy no longer
accepts, so every Antigravity tab failed.

Separately, every Gemini model on the owner's box is refused by Google with
`FAILED_PRECONDITION (code 400): User location is not supported for the API
use`, while the Claude and GPT-OSS models agy offers answer on the same
sign-in. The account is on Google AI Pro, and the box is an OVH server in
France, a supported country.

## What we found (14 Nov 2026)

- **The refusal (sourced, cause not confirmed by Google).** Google checks each
  Gemini request against the network it comes from and the account's country.
  Reports with our exact symptom (Gemini refused, Claude fine, same login)
  started around 1 to 3 Oct 2026, from OVH, from a US server, and in one case
  from a home connection. Google's only answer was "eligibility check failed".
  Sources: discuss.ai.google.dev threads 178242, 186288, 182733;
  github.com/google-antigravity/antigravity-cli issue 1155. It is not the EU
  rule (France is on the supported list) and not the free tier.
- **No legitimate fix for a subscription on a server.** Every workaround
  reported to work from a server is a VPN or proxy that hides where the
  traffic comes from. We do not ship that. The paths that do not use the
  subscription (a Gemini API key, or a Google Cloud project) were out of scope:
  the owner asked for the subscription to work and accepted that API keys may
  not.
- **agy 1.5.9** streams with `--output-format stream-json`: an `init` event that
  carries the conversation id, `step_update` events per step (`agent_response`
  with `text_delta`, `tool` with name, parameters and output), and a `result`.
  A failed turn exits 3 with an `AGY_ERROR:` line on stderr. `--model` takes
  the names `agy models` prints, effort included (`gemini-4-argon-high`).
- **agy now speaks ACP** natively and fully (models, resume, images, steering,
  permission prompts). That meets revisit trigger 3 of
  `20260702-not-using-acp.md` for Antigravity.

## Decision

- **Streaming, one process per turn** (`agy -p … --output-format stream-json`,
  resumed with `--conversation`), the same shape as Codex. Text streams, tools
  show live under the cockpit's names (shell commands as Bash, files as
  Read/Edit/Write, MCP calls as `mcp__server__tool`), and the context meter gets
  the last request's size (agy's result sums every step of the turn).
- **Gemini only** (owner, 14 Nov 2026): Gemini 4 Argon (high), Gemini 4
  Hydrogen (xhigh), Gemini 4 Hydrogen (high), Gemini 3.8 Flash (medium). The
  catalog id is agy's own model name, effort included, so the `cli` display
  name field is gone. The two retired ids point to their successors with
  `replaces`.
- **A refusal reads in plain words.** The location refusal says Google refused
  Gemini for this server's location and keeps Google's own sentence. Any other
  agy error shows as agy said it. A conversation agy no longer knows (it
  silently starts a new one) is said in the chat.
- **Not ACP yet.** Per-turn streaming matches the other agents and was a small
  change. Moving Antigravity to ACP is the first test of SHE-35, done once
  Gemini actually answers on a ShellTeam box, so the gain can be measured on
  the models we offer.

## Revisit when

- Gemini answers on the owner's box (Google lifts the check): run the live
  checks (`test/fixtures/agy/` shapes, a pasted image, resume) on Gemini, then
  evaluate ACP.
- Owners ask for Antigravity on a Gemini API key or a Google Cloud project:
  agy supports both (`modelProvider` setting, `AGY_ADC_AUTH`), the adapter
  strips Google keys today on purpose.
- `agy models` lists new Gemini names: the catalog is data, add them.

## Consequences

- Antigravity tabs work again on boxes where Google serves Gemini, and stream
  like the other agents. On the owner's box they show the plain refusal on the
  first message.
- Verified live on 14 Nov with agy 1.5.9: the refusal on Gemini 4 Argon, and a
  full streamed turn (shell command, ShellTeam's own MCP server through the
  launch layer, usage) on a model that answers here, driven through the adapter.

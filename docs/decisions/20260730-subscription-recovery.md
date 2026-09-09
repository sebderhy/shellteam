# Decision: Subscription health is separate from active billing mode

- **Date:** 2026-07-30
- **Status:** Accepted
- **Deciders:** Seb + Codex
- **Area:** Cockpit authentication, provider Settings, billing warnings
- **Applies to:** Claude Code, Codex/OpenAI, Antigravity/Google

## Context

Claude Code rewrote `~/.claude/.credentials.json` after an OAuth refresh failure,
leaving subscription metadata but blank access and refresh tokens. ShellTeam
correctly fell back to the configured Anthropic API key, but the UI only modeled
the credential that would run. It did not model the failed subscription that had
previously been preferred.

That created two product failures:

1. metered API billing could begin without a prominent warning;
2. Settings treated file existence or any alternate key as "connected" and hid
   the subscription login action behind a subtle "Change credentials" link.

Codex has an additional edge case: its auth file may retain apparently usable
tokens after the provider rejects a refresh token as expired, reused, or revoked.
File inspection alone cannot detect that state. Antigravity has the same general
recovery requirement even though it has no API-key fallback.

## Decision

Model two independent dimensions for every subscription-backed provider:

| Dimension | Values | Meaning |
|---|---|---|
| `authMode` | `subscription`, `apikey`, `included`, `none` | The credential that will actually run and pay |
| `subscriptionStatus` | `connected`, `expired`, `none` | Whether the user's subscription login is healthy |

An expired subscription does not become a billing mode. For example, Claude with
expired OAuth and a configured Anthropic key is:

```json
{
  "authMode": { "claude": "apikey" },
  "subscriptionStatus": { "claude": "expired" }
}
```

ShellTeam classifies OAuth files by usable token material and known expiry data,
not by file existence. It also records a non-secret, credential-fingerprinted
failure marker when a provider CLI reports a known permanent OAuth error. A new
credential fingerprint clears that marker automatically, including when the user
logs in through the CLI outside ShellTeam.

The cockpit shows a persistent amber warning whenever any subscription is
expired. If a key took over, the warning explicitly says it is metered. Every
warning action opens Settings on the correct provider. Settings always keeps the
subscription connect or reconnect button visible for Claude, OpenAI, and Google,
including while another credential is active.

## Reasoning

- Billing and credential health answer different questions. Combining them loses
  the fact that an API fallback was caused by a failed subscription.
- Provider-neutral semantics prevent Claude from receiving a one-off fix while
  Codex and Antigravity retain the same failure mode.
- A fingerprinted runtime marker covers provider-side refresh rejection without
  storing tokens or permanently mistrusting newly written credentials.
- Keeping the existing fallback preserves availability. Making it loud preserves
  cost control and user intent.
- Reconnect belongs in Settings because it is the durable credential-management
  surface. The cockpit warning is a direct route into that existing flow.

## Consequences

- Status payloads gain `subscriptionStatus`; `authMode` remains backward
  compatible and continues to control launch environment stripping.
- Blank, expired, or permanently rejected OAuth credentials no longer render as
  connected.
- API-key fallback remains automatic, but it is visibly labeled in the header,
  warning banner, Info panel, model picker, and Settings.
- Google has no fallback, so an expired Antigravity login is shown as unavailable
  until reconnected.
- Credential files are polled so provider-driven changes appear without a cockpit
  restart.

## What would make us revisit

- A provider exposes a supported local auth-status API that is more authoritative
  than token inspection and CLI errors.
- Automatic fallback proves too risky even with a persistent warning, in which
  case require explicit opt-in before switching from subscription to API billing.
- Providers standardize a shared OAuth lifecycle contract that makes the
  provider-specific classifiers unnecessary.

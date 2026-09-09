# Decision: provider-reported usage monitor

## Context

ShellTeam launches Claude Code, Codex, and Antigravity with the owner's native
subscription credentials. The first usage view lived only in Dashboard →
Settings and required a manual refresh. That hid an operational constraint the
owner needs while choosing and working with an agent. Its Codex collector also
opened `/usage` in the TUI, which reports activity by default rather than the
actual rate-limit windows; Antigravity could silently fall through to an empty
card during its first-run sign-in flow.

## Decision

Keep the Settings view, and add a compact monitor directly below the selected
model's green `Subscription` badge. It shows the most constrained live window
(percent used, a horizontal meter, and reset time); tapping it performs a fresh
check. The Info panel retains the fuller selected-provider detail.

Collect and normalize provider data once on the cockpit host, cache it for five
minutes, and use it for both surfaces:

- Claude Code `/usage` for rolling session and weekly windows.
- Codex's local `app-server` `account/rateLimits/read` protocol for structured
  five-hour / weekly percent windows, plan, and available reset count. The
  older `/usage` reset screen remains only as a fallback for old CLIs.
- Antigravity `/credits` for credits, plan, and percentage windows when its CLI
  has completed sign-in. Its sign-in/onboarding screen maps to an explicit
  `setup_required` state rather than a fabricated or blank quota.

The browser receives normalized, provider-reported values only. Credentials,
opaque reset-credit IDs, and raw terminal output stay in the cockpit process.
Unsupported or temporarily unavailable values are shown as such instead of
being estimated from local token logs.

## Reasoning

Quota semantics differ by provider and can change independently. Anthropic's
subscription quota is shared across Claude surfaces; OpenAI's Codex limits vary
by model and plan; Antigravity combines dynamic baseline quota and optional AI
credits. Provider-native output is therefore more trustworthy than a local
token-to-quota estimate. The installed Codex app-server already exposes the
same structured rate-limit snapshot used by its own UI, so it is strictly more
reliable than keyboard-driving the TUI. Raw TUI output can include unrelated
prompt/UI text, so it is not an appropriate browser-facing diagnostic surface.

## Revisit triggers

Revisit this adapter layer when a provider publishes a stable authenticated usage
API, changes its CLI command, or exposes structured quota data through the agent
protocol. In particular, replace Antigravity's interactive `/credits` path when
it offers a supported non-interactive quota command or API.

## Consequences

The first automatic check may take up to the slowest provider CLI timeout, but
the five-minute host cache prevents every rendered cockpit from spawning the
provider commands again. A manual refresh bypasses that cache. Some providers
can return a live status without structured percentages; the UI displays their
actual credits/reset information or an actionable setup state, never a made-up
progress bar. Antigravity's terms/sign-in consent remains an owner action.

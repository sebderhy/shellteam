# Decision: an Apps tab for app connections, built on the existing Composio module

- **Date:** 2026-09-07
- **Status:** Implemented (branch `feat/apps-tab`)
- **Deciders:** Seb + Claude (cockpit session)
- **Related:** [20260712-oss-scope-managed-services-and-feature-keys.md](20260712-oss-scope-managed-services-and-feature-keys.md),
  [20260704-purity-gate-modules.md](20260704-purity-gate-modules.md)

## Context

Seb asked whether we can give users an easy way to connect their agents to
apps (Slack, Notion, Google, Jira, ...) from the dashboard, "maybe with
Composio", pointing at the Cloud edition for inspiration.

The OSS box already had the whole backend for this and no UI in front of it:

- `api/services/composio.py` + `api/routers/integrations.py`: list
  connections, start an OAuth flow, sync CLI credentials, disconnect.
- The `composio` module (opt-in through the Composio feature key in Settings)
  puts Composio's Tool Router MCP in the agent layer, so every cockpit agent
  sees `COMPOSIO_SEARCH_TOOLS` / `COMPOSIO_MANAGE_CONNECTIONS` and can already
  connect apps from a chat.
- GitHub had its own device-flow card, in Settings.

The Cloud edition (`~/shellteam-cloud`) had a "Connected Apps" settings section
with a hand-drawn grid of ~10 apps (inline SVG logos), a `prompt()` for
"other app", and an OAuth return that landed on the dashboard root.

## Decision

1. **Ship an Apps tab** in the dashboard (its own shell page, `/apps`, like
   Reports and Knowledge) rather than another Settings card. Settings is box
   configuration; Apps is "what my agents can reach", and it is the thing a
   new user goes looking for. The GitHub card moves there from Settings (the
   first-run wizard keeps its own copy of the same shared frame).
2. **Stay on Composio** for the third-party sign-ins. The alternative,
   self-hosting Nango or registering an OAuth app per provider, was already
   weighed in Feb 2026 (Cloud `inspiration/composio-vs-nango.md`): Composio's
   pre-registered OAuth apps are the only way a self-hoster gets one-click
   Slack/Notion/Google without creating developer apps at every vendor. The
   cost is a Composio account (free tier) and app tokens living on Composio's
   side, both already disclosed in `SECURITY.md`. Nothing in this change
   deepens that dependency: it is a UI over endpoints that existed.
3. **Search the whole catalog** instead of a fixed grid. A curated shelf of
   14 apps developers use (Google Workspace, Slack, Notion, Linear, Jira,
   Sentry, Supabase, Stripe, Figma, Discord, Asana, Airtable, HubSpot,
   Dropbox) plus a search box over Composio's toolkit API
   (`GET /api/integrations/toolkits?q=`). Logos come from Composio's CDN but
   are **relayed through the control plane** (`/api/integrations/logo/<slug>`,
   cached in-process): the dashboard's cross-origin isolation blocks foreign
   images anyway, and the owner's browser should not fan out to a third party
   to draw a grid.
4. **Only Composio-hosted OAuth gets a Connect button.** Toolkits without a
   managed OAuth app (API-key apps, vendor MCP endpoints with dynamic client
   registration) show "Set up via an agent": the Tool Router's own
   manage-connections flow already walks the user through a key from the
   chat, and duplicating that in the page would mean a second credential
   entry surface.
5. **The OAuth return lands on `/apps?app_connected=<slug>`**, not `/`. The
   page syncs CLI credentials (which also rebuilds the agent layer so new
   sessions get the refreshed MCP), then closes itself when it is the popup
   the tab opened. The tab polls the connections list meanwhile, so the grid
   flips to Connected without a reload.
6. **No Composio key yet: the tab teaches instead of hiding.** GitHub still
   works, and a setup card explains what Composio is, links to it, takes the
   key inline (same `POST /api/settings/feature-keys` as Settings) and shows
   the one restart command. Pasting the key is the opt-in consent for the
   module, unchanged from the feature-key decision.

## What would make us revisit

1. Composio pricing or terms turn hostile to self-hosters, or the free tier
   disappears: then Nango self-hosted (ELv2, free) with per-provider OAuth
   apps becomes the fallback, and this tab's grid would need a "register your
   own app" path.
2. Composio's Tool Router grows a first-party embeddable connect UI that is
   better than ours: swap the grid for it, keep the tab.
3. Users ask for per-agent or per-project scoping of connections (the org
   module's AI-employee model): connections are per owner today.

## Consequences

- New shell route `/apps` (in `_CSP_PATHS`, asset-versioned like the others);
  new endpoints `GET /api/integrations/toolkits` and
  `GET /api/integrations/logo/{slug}`; connect callback path changed.
- `frontend/static/github-frame.js` is the one GitHub-card mount, used by the
  wizard and the Apps page (the dashboard's inline copy was removed).
- The `external-apps` skill and README now point users at the Apps tab.
- Completing an OAuth grant needs the owner's own vendor login, so the
  end-to-end flow was verified up to the vendor's consent page and back from
  the return URL; the click in between is the owner's.

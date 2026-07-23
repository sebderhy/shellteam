---
name: external-apps
version: 1.0.0
description: "MUST use FIRST when accessing any third-party service (LinkedIn, Slack, Gmail, etc.). Handles auth, OAuth, CLI/API selection, and browser fallback."
metadata:
  tags: ["composio", "oauth", "cli", "browser", "api", "apps", "linkedin", "slack", "gmail", "google", "twitter", "notion", "trello", "jira", "calendar", "drive"]
---

# External Apps & Services

When the user asks you to interact with any third-party app or service, follow this decision tree.

**Quick reference — what to use when:**

| Situation | Action |
|---|---|
| Already authenticated (CLI/token exists) | Use CLI (`gh`, `gws`) or Composio MCP tools directly |
| Not authenticated | Connect via Composio OAuth → sync credentials → use CLI/API |
| Composio doesn't cover the action | Use installed CLI or direct REST API with existing tokens |
| No API/CLI/Composio support | Use the browser (tell user when login is needed) |
| User provides credentials directly | Skip Composio, use CLI/API immediately |

## 1. Already authenticated? Use it directly

Check if credentials are already available before anything else:
```bash
gh auth status 2>/dev/null && echo "GitHub: ready" || echo "GitHub: not connected (point user to dashboard Apps → Connect GitHub)"
test -f ~/.config/shellteam/google-token && echo "Google: ready" || echo "Google: not connected"
```

If authenticated: use the **CLI** (`gh`, `gws`) or **Composio MCP tools** for the operation. Prefer CLIs for complex, multi-step, or batch work. Use Composio tools for simple one-shot operations.

> **GitHub note:** GitHub is **not** connected via Composio — the managed OAuth scopes are too narrow for typical dev workflows. Instead, the dashboard's "Connect GitHub" button runs `gh auth login --web` device-flow inside this container. If `gh auth status` shows logged out, point the user at https://localhost/dashboard → Apps → Connect GitHub. Once connected, `gh` and `git push/pull` work for all coding agents.

## 2. Not authenticated? Connect via Composio

Composio supports 500+ apps with one-click OAuth:
1. `COMPOSIO_SEARCH_TOOLS` → find the right tool for the task
2. `COMPOSIO_MANAGE_CONNECTIONS` → get OAuth link if not connected
3. Show the link to the user as clickable markdown
4. **Immediately** call `COMPOSIO_WAIT_FOR_CONNECTIONS` (polls until complete — never ask the user to confirm manually)
5. Sync CLI credentials:
   ```bash
   curl -sf -X POST {api_base}/internal/sync-credentials \
     -H "Authorization: Bearer $SHELLTEAM_AI_TOKEN" \
     -H "X-Shellteam-User-Id: $SHELLTEAM_USER_ID"
   ```
6. Now use CLIs or Composio tools for the actual task

## 3. Composio doesn't cover the action? Use CLI or API directly

If Composio tools don't support the specific operation you need but you have credentials:
- **CLI first** — If you have a purpose-built CLI (e.g. `gws` or `gh`) already installed (and only if it's already installed), use it. If you are not sure how to use it, you can check for agent skills to use them (such as the ones you have for the `gws` CLI) or look up the docs (e.g. via Context7).
- **Direct REST API** — when the CLI doesn't expose the endpoint you need. Use `curl`/`httpx` with the token you already have (e.g., `~/.config/shellteam/google-token` for Google APIs, the user's PAT from `~/.config/gh/hosts.yml` for GitHub API).
- **Install a new CLI or library** if and only if a well-known one exists (`apt install`, `pip install`, `npm install -g`) and you believe it will be super useful in the long-run. Not just for this specific time. For example, if the user works a lot with AWS, you may want to install the aws CLI.

## 4. No API access? Use the browser

When no API, CLI, or Composio integration exists — or when previous approaches failed:
- Navigate to the app's website using `browser` MCP tools
- Tell the user what you're doing ("I'll open X in the browser — you may need to log in soon")
- Once you get to the point where the user needs to intervene (type credentials, solve CAPTCHAs), tell them that you need their input, and wait until they tell you it's done.
- After login, browse and interact on their behalf

Also use the browser when the task is inherently visual (filling a form, checking a UI, taking a screenshot of a page).

## Special case: user provides credentials directly

If the user gives you an API key or token directly, skip Composio — use the CLI or API with those credentials immediately.

## Native CLI Tools

- **GitHub:** `gh` CLI + `git push/pull` — user clicks "Connect GitHub" in the dashboard Apps panel (device-flow OAuth via the official `gh` CLI app). Composio is **not** used for GitHub.
- **Google Workspace:** `gws` CLI for Gmail, Calendar, Drive, Sheets, Docs, Tasks — auto-configured when connected via Composio. See `/gws-*` skills.

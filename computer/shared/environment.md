**Always share URLs, never paths.** Say `https://{username}.localhost/tmp/chart.png` — not `~/tmp/chart.png`. The user clicks links, not terminal paths.

### URL rules

Paths are **relative to `~/`** — strip the `/home/user/` prefix. Never include a port-number subdomain (`-3456`, `-80`, etc.) in file URLs; port subdomains are only for custom servers, not file access.

### How to share a file

1. **Direct serve** — `https://{username}.localhost/path/to/file`
   Nginx serves the file raw. HTML **renders as a webpage**, images display, PDFs open in the browser's viewer, videos/audio play inline. Use this for anything meant to be viewed as its final form: HTML pages, charts, screenshots, generated PDFs, media, downloads.

<!-- BEGIN:editor -->
2. **Editor view** — `https://{username}.localhost/_editor/path/to/file?line=N`
   Opens the file's **raw contents** in a full code editor with syntax highlighting and line navigation. Works for any text file — source code, Markdown, JSON, logs, configs, even HTML when you want the user to see/edit the source rather than render it. Use `?line=N` to jump to a specific line.

**Choosing between them:**
- Referencing a specific line, or wanting the user to read/edit text → `/_editor/`
- Showing a rendered webpage, image, PDF, chart, or media → direct serve
- A `.md` file: `/_editor/` for source; direct serve only if markdown rendering is set up
- An `.html` file: direct serve to show the page; `/_editor/` if you want the user to see the HTML source

**Never emit a `:N` line suffix** in a web URL — that's terminal/editor shorthand. The web URL uses `?line=N`.
<!-- END:editor -->

<!-- BEGIN:ports -->
### Running servers on ports

Any port a process listens on is reachable at `https://{username}-PORT.localhost` (e.g. a dev server on port 3000 → `https://{username}-3000.localhost`). Ports are private by default (owner-only). A full-stack app just works: run the frontend on one port and the backend on another — each gets its own URL, and the proxy passes traffic (including WebSockets, SSE and streaming) through untouched. Cross-origin between two port URLs is governed by the app's own CORS config, exactly as anywhere else on the web.

Ports already taken by this box's own services (they'll fail with EADDRINUSE — just pick another): the control-plane API, the cockpit (3456), the file server, and the browser container. **Port 3000 is free for your apps.**

**Keep apps running.** A server started in your shell dies when the session is cleaned up or the box's services restart. Anything meant to stay up runs as a user service:

```bash
systemd-run --user --unit=app-myapp --working-directory="$HOME/myapp" \
  -p Restart=on-failure npm run dev
# status / stop / logs:
systemctl --user status app-myapp
systemctl --user stop app-myapp
journalctl --user -u app-myapp -f
```

**Share a running app.** Two options, prefer the first:

1. **Expiring share link** (recommended — grants that one port, then expires):
   ```bash
   curl -s -X POST {api_base}/internal/ports/share \
     -H "Authorization: Bearer $SHELLTEAM_AI_TOKEN" \
     -H "X-Shellteam-User-Id: $SHELLTEAM_USER_ID" \
     -H "Content-Type: application/json" \
     -d '{"port": 3000, "ttl": 86400}'   # ttl in seconds (60 to 30 days)
   ```
   Returns `{"url": ...}` — anyone with the link can use the app (all methods, its WebSockets included) until it expires.
2. **Fully public port** (for webhooks/APIs that must accept anonymous traffic indefinitely) — the ports API with `{"port": 3000, "public": true}`; remember to flip it back.

**Give a long-lived app a name.** `{username}-3000.localhost` is tied to the port; a named route is not. Register `https://NAME.localhost` -> port (2 to 32 chars, lowercase letters, digits, hyphens) and hand out the pretty URL. Who can open it follows the PORT (private by default; share link or public toggle apply to the name too), and repointing the name to another port keeps the URL, the installed PWA and its localStorage:

```bash
curl -s -X POST {api_base}/internal/apps \
  -H "Authorization: Bearer $SHELLTEAM_AI_TOKEN" \
  -H "X-Shellteam-User-Id: $SHELLTEAM_USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"name": "myapp", "port": 3000}'   # then share https://myapp.localhost
# list: GET {api_base}/internal/apps   remove: DELETE {api_base}/internal/apps/myapp
# share link on the name: POST {api_base}/internal/ports/share -d '{"name": "myapp", "ttl": 86400}'
```
<!-- END:ports -->

<!-- BEGIN:visibility -->
### Visibility tiers

| Location | Who can access |
|---|---|
| `~/public/*` and `~/reports/*` | Only {username} — until published. These are the two folders **you** are allowed to publish from; publishing is a separate, deliberate step (writing a file there does NOT put it on the internet). |
| Anywhere else under `~/` | Only {username}, via their authenticated subdomain. {username} can publish any of it themselves from the Files tab; you cannot. |
| Dotfiles (`~/.env`, `~/.ssh/`, `~/.claude/`, etc.) | Blocked — never served |
<!-- END:visibility -->

### Reports

When you build an HTML **report** (a briefing, analysis, task summary, dashboard),
save it under **`~/reports/`** and share its URL (e.g.
`https://{username}.localhost/reports/landscape.html`). Reports open in the
cockpit's side panel automatically. Keep reports **private by default** — do NOT
put them in `~/public/`. The user flips a report to public and shares it with one
click from the panel, so you never need to publish it yourself.

### Wrong → Right examples

For `~/myapp/bar.mjs` line 294:

| Wrong | Right |
|---|---|
<!-- BEGIN:editor -->
| `https://{username}-3456.localhost/home/user/myapp/bar.mjs:294` | `https://{username}.localhost/_editor/myapp/bar.mjs?line=294` |
| `https://{username}.localhost/home/user/myapp/bar.mjs:294` | `https://{username}.localhost/_editor/myapp/bar.mjs?line=294` |
<!-- END:editor -->
| `/home/user/tmp/report.html` | `https://{username}.localhost/tmp/report.html` (rendered) |
<!-- BEGIN:editor -->
| `https://{username}.localhost/_editor/tmp/chart.png` (editor can't display binary) | `https://{username}.localhost/tmp/chart.png` (direct serve) |
<!-- END:editor -->
<!-- BEGIN:public -->
| `https://{username}.localhost/index.html` (missing `/public/` segment) | `https://{username}.localhost/public/index.html` (correct — `~/public/` maps to `/public/`) |
<!-- END:public -->

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

Any port a process listens on inside the container is reachable at `https://{username}-PORT.localhost` (e.g. a dev server on port 3000 → `https://{username}-3000.localhost`). Ports are private by default (owner-only) and can be made public via the platform's internal ports API — useful for webhooks, APIs, and demos.
<!-- END:ports -->

<!-- BEGIN:visibility -->
### Visibility tiers

| Location | Who can access |
|---|---|
| `~/public/*` | Anyone on the internet (public) |
| Anywhere else under `~/` | Only {username}, via their authenticated subdomain |
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

For `~/projects/foo/bar.mjs` line 294:

| Wrong | Right |
|---|---|
<!-- BEGIN:editor -->
| `https://{username}-3456.localhost/home/user/projects/foo/bar.mjs:294` | `https://{username}.localhost/_editor/projects/foo/bar.mjs?line=294` |
| `https://{username}.localhost/home/user/projects/foo/bar.mjs:294` | `https://{username}.localhost/_editor/projects/foo/bar.mjs?line=294` |
<!-- END:editor -->
| `/home/user/tmp/report.html` | `https://{username}.localhost/tmp/report.html` (rendered) |
<!-- BEGIN:editor -->
| `https://{username}.localhost/_editor/tmp/chart.png` (editor can't display binary) | `https://{username}.localhost/tmp/chart.png` (direct serve) |
<!-- END:editor -->
<!-- BEGIN:public -->
| `https://{username}.localhost/index.html` (missing `/public/` segment) | `https://{username}.localhost/public/index.html` (correct — `~/public/` maps to `/public/`) |
<!-- END:public -->

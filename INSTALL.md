# Installing ShellTeam

> **If you are a coding agent asked to "install ShellTeam":** read this file top
> to bottom and execute it. It is written so you can complete the install with no
> further input from the human — except for the things only they can provide:
> **how the box should be accessed and pure core vs full harness** (ask the two
> questions in §1 before you start), a domain's DNS, and the LLM sign-in/keys.
> Those are called out explicitly below.

ShellTeam OSS runs **natively** on a single Linux box (no Docker). It installs as
a set of `systemd --user` services owned by one non-root user. See
[SECURITY.md](SECURITY.md) for the threat model before exposing it to the internet.

---

## 0. Prerequisites

| Requirement | Why | How to check |
|---|---|---|
| Ubuntu 22.04+ or Debian 12+ | The installer uses `apt` | `cat /etc/os-release` |
| A **non-root** user | Services run as `systemd --user`; install refuses root | `id -u` (must NOT be 0) |
| **Passwordless `sudo`** for that user | The installer uses `sudo` for apt/setcap/linger and won't be able to answer a password prompt unattended | `sudo -n true && echo ok` |
| `systemd` with user lingering allowed | Keeps services up after logout / across reboots | `systemctl --user` works |
| Outbound internet | Fetches Node, uv, npm CLIs | — |
| Free ports `8000`, `3456`, `80` | API, cockpit, file server | `ss -ltnp` |

> Ports taken? All three are configurable in `.env` (`API_PORT`, `AI_CHAT_PORT`,
> `FILE_PORT`) — see [§6 Changing ports](#changing-ports). You don't need the
> defaults free; just pick free ones.

If `sudo -n true` fails, ask the human to grant passwordless sudo
(`echo "$USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/$USER`) or run the
`sudo` steps yourself interactively. Everything else is automatic.

---

## 1. Choose the install mode

Every install starts the same way — the **localhost install** (§2), which is safe,
reversible, and the base for everything. The only thing you need from the human up
front is the answer to **two questions**.

**Question ①  — "How will you reach the box?"** There are **exactly three**
answers. **Present all three, every time, as three separate options** — even when
conditions on the box change how one of them would be implemented. A constraint
(an occupied `:80`/`:443`, DNS pointing elsewhere, no domain owned yet) changes
the *route* to an option, never the *menu*: annotate the affected option with the
implication ("would run behind your existing nginx, §4.5") and let the human
choose. Never merge two options or drop one because you judged it non-viable —
in particular, 2 and 3 stay distinct even when both would be implemented via
§4.5, because they differ in what the human ends up with (a free generic
hostname vs their own branded domain), not just in mechanics:

| Answer | Flag | Section |
|---|---|---|
| **1. Private** — just this box (add your own devices later via Tailscale) | *(none — plain `./install.sh`)* | §2 |
| **2. A public HTTPS URL, no domain to buy** | `--remote` | §4.2 |
| **3. My own domain** | `--domain example.com` (needs `A` + `*.A` DNS) | §4.3 |

- Answer **1** is the plain localhost install — no TLS, no `OWNER_TOKEN`. **Tailscale
  is not a fourth option; it's a follow-up to answer 1**: after the install, offer to
  add it (§4.1) so they can reach the box from their laptop/phone over a private
  WireGuard network without ever touching the public internet. Don't list it as its
  own access mode.
- Answers **2** and **3** put the box on the public internet, protected **only** by a
  strong auto-generated `OWNER_TOKEN` + HTTPS (no container isolation — treat it
  deliberately; see [SECURITY.md](SECURITY.md)).

> **Already running nginx/Apache/Caddy on `:80`/`:443`?** That does **not** remove
> answers 2 or 3. The flag-driven Caddy path can't seize those ports, but public
> access is still on the table: install on localhost (§2), then put ShellTeam behind
> your existing server per **§4.5** — it works for both a real domain and a free
> `sslip.io` hostname. Never drop the public option just because `:80` is taken; it
> simply moves to §4.5.

**Question ②  — "Pure core, or the full harness?"** Pure core keeps the agents as
stock CLIs; the full harness (`--full`) teaches them the box (live URLs, HTML
reports, a shared browser, nightly knowledge). Reassure the human that **both are
additive** — ShellTeam never modifies their existing agent setup (`~/.claude`,
`~/.codex`, …); the harness applies only to agents run *through* ShellTeam, and a
CLI they run by hand behaves exactly as before.

If the human is unreachable, default to **localhost + pure core** and tell them
afterwards how to add either. A human running `./install.sh` by hand is asked these
same two questions interactively on first run; non-interactive runs (piping stdin,
like a coding agent) never prompt — so just pass the flags that match the answers.

---

## 2. Localhost install (always do this first)

```bash
# From the repo root (where install.sh lives):
./install.sh
```

That's the whole install. On a **first interactive run** it asks two questions —
how you'll access the box (private / free HTTPS URL / your own domain) and which
install (pure core / full harness) — and every answer maps to
a flag (`--remote`, `--domain`, `--full`), so non-interactive runs and re-runs
never prompt. The script is idempotent — re-run it after `git pull`. It will:

1. Install system packages (`nginx`, Python 3, `libcap2-bin`) + Node 20+ (fetches
   Node 22 only if the box has nothing ≥ 20) + `uv`.
2. Sync Python deps and the ai-chat Node deps.
3. Install the coding-agent CLIs: `claude` (`@anthropic-ai/claude-code`), `codex`
   (`@openai/codex`), and `opencode` (`opencode-ai`) globally via npm, plus `agy`
   (the Antigravity CLI) via its official installer into `~/.local/bin`
   (failures are reported at the end — the rest of the install continues).
4. Create `.env` from `.env.example` and auto-generate `SHELLTEAM_AI_TOKEN`.
5. Grant nginx `cap_net_bind_service` so a `--user` unit can bind port 80.
6. Check the API/cockpit/file ports are actually free (fails loudly if not).
7. Install + enable + start the `systemd --user` services — then **verify them**
   (`/health`, cockpit, file server); a service that crashed on boot fails the
   install with its journal excerpt instead of a fake success banner.
8. Point you at the dashboard sign-in for a subscription login (the recommended
   way to run the agents — API keys are optional, for headless/CI use).

The plain `./install.sh` above is the **pure core** — no modules, zero agent
injection, zero Docker (`--minimal` is an explicit alias for it). Modules add
superpowers:

```bash
./install.sh --minimal        # pure core (the default, spelled out)
./install.sh --full           # persona (skills/system prompt/docs MCP) + browser + dreaming
# Granular module control: edit MODULES= in .env (persona,browser,composio,
# linear,dreaming), then re-run ./install.sh
```

The **Browser tab / `browser` MCP** (part of `--full`) runs a
loopback-only [Steel](https://github.com/steel-dev/steel-browser) container on
`:3000` (bundles its own pinned Chromium). This is the one piece that needs
**Docker** on the box — if Docker is absent the installer warns and skips it;
everything else is Docker-free.

Then go to [§3 Verify](#3-verify-the-install) and [§5 Sign in to the agents](#5-sign-in-to-the-agents).

---

## 3. Verify the install

The installer already verified the services (step 7 above) — if it printed
"ShellTeam installed", the stack answered on its ports. For a manual re-check
(or after editing `.env`), run these and confirm the expected output:

```bash
# Services should all be "active (running)":
systemctl --user status shellteam-api shellteam-ai-chat shellteam-nginx --no-pager | grep -E 'Active|●'

# Health endpoint:
curl -fsS http://127.0.0.1:8000/health        # → {"status":"ok"}

# Dashboard renders the tab shell (Agents/Terminal/Files/Browser/Settings, plus a
# hidden Knowledge tab that appears only with the dreaming module):
curl -fsS -H "Host: localhost" http://127.0.0.1:8000/ | grep -c '<button class="tab'   # → 6

# Cockpit (ai-chat) is up on its own port:
curl -fsS http://127.0.0.1:3456/ >/dev/null && echo "cockpit ok"

# File server: a bare `curl http://127.0.0.1:80/` returns 403/404 — that is
# CORRECT, not a failure. Your home dir is token-gated; only ~/public and
# published reports are open. Confirm it serves a public file instead:
curl -fsS http://127.0.0.1:80/public/ >/dev/null 2>&1 && echo "file server ok" || echo "(add a file under ~/public to test)"
```

If anything fails, read the logs (they are verbose by design):

```bash
journalctl --user -u shellteam-api -n 80 --no-pager
journalctl --user -u shellteam-ai-chat -n 80 --no-pager
journalctl --user -u shellteam-nginx -n 80 --no-pager
```

The dashboard is served at `http://127.0.0.1:8000` — the **Agents** tab is the
cockpit (ai-chat), and the web terminal is the **Terminal** tab (also at
`/terminal`).

---

## 4. Giving ShellTeam a URL (remote access)

The localhost install reaches the box only on `127.0.0.1`. To reach it from
elsewhere you have three options. **Read this security note first**, because the OSS edition has **no
container isolation** (see [SECURITY.md](SECURITY.md)) — anyone who reaches the
cockpit with the token can drive the whole VPS.

> **Pick by trust, not convenience:**
> - **Just you, from your own devices → Tailscale (§4.1, recommended).** The box is
>   never exposed to the open internet and there's no token to brute-force.
> - **Reachable from anywhere / shareable → a public HTTPS URL (§4.2–4.3).** Either
>   a free no-domain URL or your own domain. The box is on the public internet, so
>   it's protected **only** by a strong `OWNER_TOKEN` + HTTPS. The installer
>   auto-generates that token; never weaken it.

### 4.1 Tailscale — private, recommended

[Tailscale](https://tailscale.com) puts the box on a private WireGuard network only
your devices can see. No public exposure, no `OWNER_TOKEN` to guess, no Caddy.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                       # follow the printed login link
tailscale ip -4                         # → your box's tailnet IP, e.g. 100.x.y.z
```

The services bind to `127.0.0.1` (they have no auth of their own — never expose
them on a public interface). Bridge the **dashboard** and **cockpit** ports onto
your tailnet with `tailscale serve` (raw TCP, so the dashboard still sees the bare
tailnet IP as the host and the Agents tab routes over the sibling cockpit port):

```bash
# Read the ports from .env (defaults: API 8000, cockpit 3456) so the snippet is
# copy-pasteable as-is:
API_PORT=$(grep '^API_PORT=' .env | cut -d= -f2); API_PORT=${API_PORT:-8000}
AI_CHAT_PORT=$(grep '^AI_CHAT_PORT=' .env | cut -d= -f2); AI_CHAT_PORT=${AI_CHAT_PORT:-3456}
sudo tailscale serve --bg --tcp "$API_PORT"     "tcp://localhost:$API_PORT"      # dashboard
sudo tailscale serve --bg --tcp "$AI_CHAT_PORT" "tcp://localhost:$AI_CHAT_PORT"  # cockpit
```

Then register the tailnet IP as a dashboard host (so the host-check accepts it and
the CSP allows framing the sibling cockpit port) and restart the control plane:

```bash
echo "EXTRA_MAIN_HOSTS=$(tailscale ip -4)" >> .env
systemctl --user restart shellteam-api
```

Reach it from any device on your tailnet at `http://<tailnet-ip>:<API_PORT>`. The
traffic is WireGuard-encrypted end to end, so plain HTTP over the tailnet is fine,
and the **Agents** + **Terminal** tabs work with no wildcard DNS. (The **Files**
tab needs `owner.<domain>` wildcard DNS, so over a bare IP it won't route — use a
domain via §4.3 if you need it.)

Tailscale's **Funnel** can expose one port publicly, but it gives a single hostname
(no wildcard), so the Agents tab and app-previews won't route — use §4.2/§4.3 for a
real public URL.

### 4.2 Instant public URL — no domain needed

One command gives any VPS a real wildcard HTTPS URL with **no domain to buy**, using
free wildcard DNS ([sslip.io](https://sslip.io): `<ip>.sslip.io` and any prefix
resolve to that IP) plus Caddy on-demand TLS:

```bash
./install.sh --remote
```

It detects your public IP, sets `APP_DOMAIN=<dashed-ip>.sslip.io`, **auto-generates a
strong `OWNER_TOKEN`**, moves the file server off `:80` so Caddy can bind `:80/:443`,
installs + configures Caddy, and prints your URL + token at the end:

```
https://203-0-113-10.sslip.io            ← open this; first load asks for the token
```

Open ports `80` and `443` in any cloud firewall first, or Caddy can't get a cert.

> **nip.io fallback.** `nip.io` is the same service as `sslip.io`. If a cert is ever
> rate-limited, swap `sslip.io`→`nip.io` in `.env` (`APP_DOMAIN`) and in
> `/etc/caddy/Caddyfile`, then `./install.sh --remote` again (or just
> `sudo systemctl reload caddy`).

### 4.3 Your own domain (branded URL)

If you own a domain, point **two** records at the VPS (the wildcard is required so
owner subdomains `<name>.example.com` / `<name>-<port>.example.com` resolve):

```
A      example.com        → <this VPS public IP>
A      *.example.com      → <this VPS public IP>     (wildcard)
```

Confirm DNS, then run one command:

```bash
DOMAIN=example.com
dig +short "$DOMAIN" ; dig +short "anything.$DOMAIN"   # both must print the VPS IP
./install.sh --domain "$DOMAIN"
```

Same as `--remote` but with your domain: it sets `APP_DOMAIN`, auto-generates a
strong `OWNER_TOKEN`, and installs + renders + validates Caddy (TLS via the official
apt build). The Caddyfile only needs the domain — `OWNER_TOKEN` lives only in `.env`,
enforced by the app. Set a friendlier owner name if you like:

```bash
sed -i "s|^OWNER_USERNAME=.*|OWNER_USERNAME=me|" .env   # → me.example.com ; re-run ./install.sh
```

### 4.4 Verify the public deploy

```bash
DOMAIN=example.com                                 # or <dashed-ip>.sslip.io
TOKEN="$(grep ^OWNER_TOKEN= .env | cut -d= -f2)"
curl -fsS "https://${DOMAIN}/health"               # → {"status":"ok"}
curl -fsS "https://${DOMAIN}/" -H "Authorization: Bearer ${TOKEN}" | grep -c '<button class="tab'   # → 6
sudo journalctl -u caddy -n 50 --no-pager          # confirm a cert was issued, no errors
```

Open `https://<domain>` in a browser — the first load shows a login prompt for the
`OWNER_TOKEN`. Enter it once; the server sets HttpOnly session cookies (the master
stays on the dashboard origin; subdomain tabs get a derived read-only credential —
page JavaScript can never read either), so subsequent visits are seamless. (You can
also open `https://<domain>/?token=<OWNER_TOKEN>` once — it is redeemed into the
session cookies and immediately stripped from the URL.)

Open `https://<domain>` in a browser. The first load asks for the `OWNER_TOKEN`.

### 4.5 Behind an existing web server (nginx/Apache/your own Caddy)

If something already serves `:80`/`:443`, **don't fight it** — `--remote`/`--domain`
deliberately refuse to seize those ports. Keep your web server as the TLS front and
proxy it to ShellTeam instead. The whole app (dashboard, cockpit, files, port
previews) is one upstream: `127.0.0.1:$API_PORT`.

1. **Point DNS at this box — the hostname *and* its `*.` wildcard.** Add **two**
   `A` records so both the dashboard and the subdomains resolve here:

   ```
   A   example.com      → <this VPS public IP>
   A   *.example.com    → <this VPS public IP>     (wildcard)
   ```

   The wildcard is what makes **port previews** work (an agent builds an app on
   `:3000` → `owner-3000.example.com`). Skip it and everything canonical still
   works — dashboard, cockpit, and file URLs are all main-domain paths — you lose
   *only* the port-preview subdomains. `dig +short example.com` and
   `dig +short anything.example.com` must both print this box's IP before you
   continue (a mismatch is why certbot would fail).

2. **Set a strong `OWNER_TOKEN` first — this step is not optional.** Behind a proxy
   ShellTeam still binds localhost, so it can't detect it's publicly reachable; an
   empty token would leave the box wide open through your proxy:

   ```bash
   sed -i "s|^OWNER_TOKEN=.*|OWNER_TOKEN=$(openssl rand -hex 32)|" .env
   sed -i "s|^APP_DOMAIN=.*|APP_DOMAIN=example.com|" .env
   grep ^OWNER_TOKEN= .env        # save this — it's your login
   systemctl --user restart shellteam-api shellteam-ai-chat
   ```

3. **Add a vhost forwarding your hostname — and its `*.` wildcard — to ShellTeam.**
   Routing is `Host`-header based, so pass `Host` through and enable WebSocket
   upgrades. nginx example (Apache/Caddy equivalents are the same idea):

   ```nginx
   map $http_upgrade $connection_upgrade { default upgrade; "" close; }

   server {
       listen 443 ssl;
       server_name example.com *.example.com;
       # ssl_certificate / ssl_certificate_key: your certs (see the wildcard note)

       location / {
           proxy_pass http://127.0.0.1:8000;        # = API_PORT in .env
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection $connection_upgrade;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 3600s;
           proxy_buffering off;                     # agent output streams
       }
   }
   ```

4. **Certificates.** A plain certbot cert covers `example.com` and everything
   canonical works (dashboard, cockpit, file URLs — they're all main-domain paths).
   The `*.example.com` entries (port previews like `owner-3000.example.com`) need a
   **wildcard** cert, which certbot only issues via a DNS-01 challenge (a DNS-provider
   plugin). If that's a hassle, skip the wildcard — you lose only the port-preview
   subdomains, nothing else.

   > ⚠️ **Don't use certbot's `--manual` TXT challenge for the wildcard.** A
   > hand-entered DNS-01 challenge **does not auto-renew** — the cert silently
   > expires in ~90 days and port previews break with no warning. Use a challenge
   > that renews unattended: certbot's DNS plugin for your provider if one exists
   > (`certbot-dns-cloudflare`, `-route53`, `-digitalocean`, …), or
   > [`acme.sh`](https://github.com/acmesh-official/acme.sh), which has native
   > DNS-API support for ~150 providers (incl. Namecheap, which certbot has no
   > plugin for) and installs its own renewal cron. If your DNS provider has no
   > API, just skip the wildcard rather than pin a manual cert you'll forget to renew.

5. Verify like §4.4: `curl -fsS https://example.com/health`, then log in with the
   `OWNER_TOKEN`.

> The other route — if the existing web server is just a distro default page and
> serves nothing you care about — is simpler: `sudo systemctl disable --now nginx`
> (the binary must stay installed; ShellTeam's own file server runs it as a user
> service on a different port), then `./install.sh --domain example.com` and let
> Caddy own `:80`/`:443` with automatic wildcard TLS.

---

## 5. Sign in to the agents

The **recommended** way to run the coding agents is a **subscription login** — no
API key needed. Open the dashboard, go to **Settings → AI providers**, and sign in
with your Claude and/or Codex subscription (Antigravity uses its own Google OAuth
flow from the cockpit). This uses your existing plan and keeps a stray API key from
ever silently billing you.

**API keys are optional** — they're the fallback for headless/CI boxes where no
interactive browser sign-in is possible. If you want them, keys live in `.env`,
read by the `/internal/ai` proxy **and** the agent CLIs (via the environment) —
setting the var is enough, no per-CLI config files needed:

```bash
cd /path/to/shellteam
sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=sk-ant-...|' .env   # for Claude Code
sed -i 's|^OPENAI_API_KEY=.*|OPENAI_API_KEY=sk-...|'           .env   # for Codex
systemctl --user restart shellteam-api shellteam-ai-chat
```

Other optional keys in `.env`: `FIREWORKS_API_KEY` (enables the OpenCode agent),
`ELEVENLABS_API_KEY` (voice input — speech-to-text in the cockpit),
`COMPOSIO_API_KEY` (500+ app integrations over MCP — off unless set),
`LINEAR_API_KEY` (for the `linear` module).

---

## 6. Day-2 operations

```bash
# Update to the latest code (install.sh is idempotent):
git pull && ./install.sh
```

**Automatic updates (opt-in):** set `AUTO_UPDATE=daily` (or `weekly`) in `.env`
— or flip it in dashboard **Settings → Automatic updates**. A nightly timer
(03:10 local) then fast-forwards the checkout to the latest release tag and
re-runs `install.sh` (services restart), rolling back automatically if the
update doesn't come up healthy. It refuses to touch a checkout with local
changes. Off by default; the last outcome shows in Settings and in
`journalctl --user -u shellteam-update`.

```bash
# Restart / stop / start:
systemctl --user restart shellteam-api shellteam-ai-chat shellteam-nginx
systemctl --user stop    shellteam-api shellteam-ai-chat shellteam-nginx

# Tail logs:
journalctl --user -u shellteam-ai-chat -f
```

<a id="changing-ports"></a>
### Changing ports

The three service ports all live in `.env` — there is **one** place to change each,
and **one** command to apply them all:

| Port | `.env` var | Default | Notes |
|---|---|---|---|
| Control plane (dashboard + API) | `API_PORT` | `8000` | On a public domain, `./install.sh --domain` re-renders the Caddyfile to match; if you edit `.env` by hand, update the `reverse_proxy` targets too. |
| Cockpit (ai-chat) | `AI_CHAT_PORT` | `3456` | — |
| File server (nginx, serves `$HOME`) | `FILE_PORT` | `80` | Any free port works. `>= 1024` needs no privileged bind, so the installer skips `setcap`. |

To change any of them:

```bash
cd /path/to/shellteam
sed -i 's|^FILE_PORT=.*|FILE_PORT=8081|'   .env   # example: move the file server off :80
sed -i 's|^API_PORT=.*|API_PORT=8001|'     .env   # example: move the API off :8000
./install.sh                                       # re-render units + nginx, restart everything
```

Re-running `./install.sh` is the canonical "apply" step — it's idempotent and
re-renders the nginx config (whose `listen` port is baked in at install time).
`API_PORT` and `AI_CHAT_PORT` also take effect on a bare
`systemctl --user restart shellteam-api shellteam-ai-chat` (they're read from
`.env` at process start), but `FILE_PORT` needs the re-render — so when in doubt,
just re-run `./install.sh`.

If you're on a public domain and changed `API_PORT`, re-run `./install.sh --domain
<your-domain>` (it re-renders the Caddyfile to the new port), or update it by hand:

```bash
sudo sed -i 's|127.0.0.1:8000|127.0.0.1:8001|g' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `install.sh` exits "Run as your normal (non-root) user" | Ran as root | Re-run as the non-root owner user |
| `install.sh` hangs / fails on a `sudo` step | No passwordless sudo | See §0; grant NOPASSWD or run interactively |
| `/health` refused | API not running | `journalctl --user -u shellteam-api -n 80` — usually a `.env` syntax error or missing dep |
| Dashboard 404 / wrong host | Request `Host` not in `MAIN_HOSTS` | Localhost: use `127.0.0.1`/`localhost`. Domain: ensure `APP_DOMAIN` + `VPS_IP` are set in `.env` and services restarted |
| Installer says "moving `API_PORT`/`FILE_PORT` to :NNNN" | A default port was already taken | Nothing to do — ShellTeam auto-picks the next free port and records it in `.env`. Override in `.env` + re-run if you want a specific port (see [§6 Changing ports](#changing-ports)) |
| `--remote` / `--domain` refuses: "something other than Caddy serves :80/:443" | You already run a web server / reverse proxy there | Expected — ShellTeam won't seize those ports. Follow **§4.5**: install without the flag, set `OWNER_TOKEN` + `APP_DOMAIN` in `.env`, and add the vhost on your existing proxy |
| `--remote` / `--domain` refuses: "Refusing to overwrite the existing /etc/caddy/Caddyfile" | You already manage Caddy for your own site | Expected safety stop — your Caddyfile was backed up, not touched. Add a ShellTeam site block (reverse-proxy your hostname to `127.0.0.1:$API_PORT`) to your own Caddyfile, or move it aside to let ShellTeam manage Caddy |
| nginx won't bind `FILE_PORT` (privileged `:80`) | `setcap` didn't apply | Re-run `sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v nginx)")"` then restart `shellteam-nginx` — or set `FILE_PORT` ≥ 1024 in `.env` and re-run `./install.sh` (no setcap needed) |
| Services die after logout | Linger not enabled | `sudo loginctl enable-linger "$USER"` |
| Caddy: no certificate | DNS not pointing at VPS yet, or port 80/443 blocked | Verify the §4.3 `dig` check, open the firewall for 80/443, check `journalctl -u caddy` |
| 401 on every request (domain mode) | `OWNER_TOKEN` set (correct) but not presented | Send `Authorization: Bearer <token>` (curl) or log in via the browser prompt (`?token=` is only redeemed once on `GET /` — it is not a general auth param) |
| Agents tab blank on domain | Owner subdomain didn't resolve | Confirm the **wildcard** `*.example.com` A record exists (the GitHub connect card no longer needs it, but agent port-previews do) |
| `systemctl --user` / `journalctl --user` fails "Failed to connect to bus: No medium found" | You `su`'d to the owner (e.g. after `--create-owner`) without a login session, so there's no user D-Bus | Export the runtime dir first: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`. One-shot from another user: `sudo -u <owner> XDG_RUNTIME_DIR=/run/user/$(id -u <owner>) systemctl --user status shellteam-api`. Or just `su - <owner>` (login shell) to get one for free |

---

## 8. Uninstall

```bash
./uninstall.sh            # remove ShellTeam's services, state, agent layer, browser
./uninstall.sh --purge    # ALSO remove ~/.shellteam (incl. your knowledge layer)
```

`uninstall.sh` removes everything ShellTeam added that's purely its own, and
unmasks the system `nginx.service` it had masked. It deliberately **leaves your
stuff and shared packages in place**: the repo + `.env`, your coding-agent dotfiles
(`~/.claude`, `~/.codex`, … — ShellTeam never owned them), apt packages (nginx,
nodejs), the coding-agent CLIs, and Caddy. The complete manifest of what gets
installed and what gets removed is in [docs/FOOTPRINT.md](docs/FOOTPRINT.md).

> **Coming from an older build?** Early versions injected ShellTeam's template into
> `~/.claude` / `~/.claude.json`. The current edition never does. Revert the
> leftovers once (backed up, reversible):
> `uv run python scripts/cleanup-legacy-agent-config.py` (add `--dry-run` to preview).

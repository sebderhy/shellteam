import { isIP } from "node:net";

/**
 * The cockpit's own gate against other websites (SHE-145).
 *
 * The cockpit has no login of its own: on a domain install the FastAPI proxy
 * authenticates every request before forwarding it here. But on a localhost
 * install, over Tailscale (`tailscale serve --tcp 3456`), and inside employee
 * containers, a browser reaches this port directly. Then any page the owner
 * (or the agent's own browser) opens could:
 *  - open `/ws/shell` (WebSockets ignore CORS) and type commands, or
 *  - send a `text/plain` POST (a CORS "simple" request, no preflight) to
 *    `/api/gateway` and point every agent at an attacker's model endpoint, or
 *  - rebind its own name to 127.0.0.1 and read everything same-origin.
 *
 * Two locks, both cheap:
 *  1. Host must be one of ours: loopback, a bare IP (tailnet), APP_DOMAIN or a
 *     subdomain of it, or EXTRA_MAIN_HOSTS. A rebound name never is.
 *  2. A browser `Origin`, when present on an upgrade or a state-changing
 *     request, must be the cockpit itself: the exact origin the request came
 *     to (direct use), or the cockpit's own `<owner>-<PORT>.APP_DOMAIN`
 *     subdomain (proxied: the proxy rewrote Host to loopback and already
 *     checked that Origin). No Origin means a non-browser client.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostnameOf(hostHeader) {
  if (!hostHeader) return "";
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function appDomain() {
  return (process.env.APP_DOMAIN || "localhost").toLowerCase();
}

function extraHosts() {
  return (process.env.EXTRA_MAIN_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function hostIsOurs(hostHeader) {
  const host = hostnameOf(hostHeader);
  if (!host) return false;
  const domain = appDomain();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    isIP(host) !== 0 ||
    host === domain ||
    host.endsWith(`.${domain}`) ||
    extraHosts().includes(host)
  );
}

function portOf(hostHeader, fallback) {
  try {
    return new URL(`http://${hostHeader}`).port || String(fallback);
  } catch {
    return String(fallback);
  }
}

export function originIsCockpit(origin, hostHeader, port) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the sandboxed "null" origin
  }
  if (url.host.toLowerCase() === String(hostHeader || "").toLowerCase()) return true;
  // Proxied: the proxy connects to 127.0.0.1:<port it targets>, which is the
  // port in the cockpit subdomain (an employee's host port maps to its 3456).
  const domain = appDomain();
  const host = url.hostname.toLowerCase();
  const label = host.endsWith(`.${domain}`) ? host.slice(0, -(`.${domain}`).length) : "";
  // Exactly `<owner>-<port>`, as api/main.py builds the cockpit URL (mirrors
  // its `OWNER_USERNAME` default); a named app route like `foo-3456` is not it.
  const owner = (process.env.SHELLTEAM_USERNAME ?? process.env.OWNER_USERNAME ?? "owner").toLowerCase();
  return label === `${owner}-${portOf(hostHeader, port)}`;
}

/**
 * Returns null when the request may proceed, else a short reason (logged).
 * `upgrade` marks WebSocket upgrades, which are always checked like writes.
 */
export function refuseCrossSite(req, port, { upgrade = false } = {}) {
  if (!hostIsOurs(req.headers.host)) return `unknown Host ${req.headers.host}`;
  if (!upgrade && SAFE_METHODS.has(req.method)) return null;
  const origin = req.headers.origin;
  if (origin && !originIsCockpit(origin, req.headers.host, port)) return `cross-site Origin ${origin}`;
  return null;
}

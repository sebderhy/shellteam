// Reverse-proxy the employee's OWN Steel browser sidecar through the cockpit,
// so the guest shell can show a "Browser" tab (Steel's built-in /ui viewer)
// WITHOUT the sidecar ever publishing a host port.
//
// The sidecar is reachable only on the employee's Docker network — the cockpit
// IS on that network, so it forwards /ui/* and /v1/* to it. Security is
// INHERITED: the guest reaches this cockpit only through the guest-cookie-gated
// port proxy, and this cockpit forwards only to ITS OWN sidecar. No new
// main-box auth surface, no host-exposed sidecar.
//
// Inert unless STEEL_BROWSER_URL is set (only browser-enabled employee
// containers set it) — so the owner cockpit is completely unaffected.

import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// Read lazily (not at import) so it works regardless of import order and is
// testable. e.g. http://st-emp-<folder>-browser:3000
function sidecar() {
  return process.env.STEEL_BROWSER_URL || "";
}
const PREFIXES = ["/ui", "/v1"];

export function browserProxyEnabled() {
  return Boolean(sidecar());
}

function isProxyPath(pathname) {
  return PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Returns true if it handled the request (proxied it), false to fall through.
export function proxyBrowserHttp(req, res) {
  const SIDECAR = sidecar();
  if (!SIDECAR) return false;
  const u = new URL(req.url, "http://localhost");
  if (!isProxyPath(u.pathname)) return false;

  const target = new URL(SIDECAR);
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`browser sidecar unavailable: ${err.message}`);
  });
  req.pipe(upstream);
  return true;
}

const proxyWSS = new WebSocketServer({ noServer: true });

// Returns true if it handled (proxied) the upgrade, false to fall through.
export function proxyBrowserUpgrade(req, socket, head) {
  const SIDECAR = sidecar();
  if (!SIDECAR) return false;
  const u = new URL(req.url, "http://localhost");
  if (!isProxyPath(u.pathname)) return false;

  const target = SIDECAR.replace(/^http/, "ws") + req.url;
  proxyWSS.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(target);
    const pending = [];
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });
    upstream.on("open", () => {
      for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
      pending.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    const close = () => {
      try { client.close(); } catch {}
      try { upstream.close(); } catch {}
    };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  });
  return true;
}

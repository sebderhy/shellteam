/**
 * browser-gate.mjs — the gate between agents and the box's browser (SHE-170).
 *
 * Agents drive the browser over CDP. Before this, their tool spoke to the
 * browser directly, so nothing could stop an agent while the owner was typing
 * a password in the live view, two chats browsing at once clicked on each
 * other's page, and the cockpit could not know which chat was browsing.
 *
 * Every agent's browser tool now connects here instead, and the gate forwards
 * to the browser. Three things it adds, and nothing else:
 *
 *  1. The owner's turn. While the owner holds control, every command an agent
 *     sends is answered with a refusal that says why, and never reaches the
 *     browser. Events still flow, so the agent's view of the page is current
 *     the moment control comes back.
 *  2. One chat at a time. The first chat to browse holds the browser while it
 *     works; another chat is told who has it instead of clicking on its page.
 *  3. Who is browsing. A connection is matched to its chat by the process
 *     that opened it (see peer-chat.mjs), so no agent has to say who it is and
 *     none can claim to be another.
 *
 * It also takes one request over plain HTTP, `POST /ask`: an agent asking for
 * the owner's turn ("sign in to this shop"). Same identification.
 *
 * Loopback only. It carries no secret: what it guards is order, and the
 * browser behind it is reachable by the same local processes anyway.
 */
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export const OWNER_HAS_CONTROL =
  "The owner has taken control of the browser, so you cannot act in it right now. " +
  "Do not retry. Tell the owner in one sentence what you were about to do, then end your turn: " +
  "you will get a message when they hand the browser back. Look at the page again before acting then.";

export const busyMessage = (who) =>
  `The browser is in use by another chat (${who}). There is one browser on this computer. ` +
  "Do not retry in a loop: tell the owner, and try again when that chat has finished browsing.";

// A chat keeps the browser this long after its last command, as long as it is
// still working. Long enough to read a page and think; short enough that a
// chat which moved on does not lock the others out.
const HOLD_MS = 3 * 60 * 1000;

/** The answer to a refused command. A protocol error says why for most
 *  commands. Page scripts are the exception: Playwright retries a failed
 *  evaluation until its own 30 s timeout and then reports only "Timeout",
 *  so the agent waited half a minute and never learned why (seen with a real
 *  browser_snapshot, 2026-11-15). Answered as a script that threw, the reason
 *  comes back at once, in words. */
function refusal(method, why) {
  if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
    return { result: {
      result: { type: "object", subtype: "error", className: "Error", description: `Error: ${why}` },
      exceptionDetails: { exceptionId: 1, text: "Uncaught", lineNumber: 0, columnNumber: 0,
        exception: { type: "object", subtype: "error", className: "Error", description: `Error: ${why}` } },
    } };
  }
  return { error: { code: -32000, message: why } };
}
const MAX_ASK_CHARS = 300;

/**
 * @param {object} o
 * @param {string} o.upstream          the browser's CDP websocket, e.g. ws://127.0.0.1:3877
 * @param {(port:number)=>string|null} o.identify  chat of the local process behind a source port
 * @param {(chat:string)=>string} o.chatName        how to name a chat to another agent
 * @param {(chat:string)=>boolean|null} o.isWorking is that chat's agent mid-turn (null = unknown)
 * @param {(event:object)=>void} o.onChange
 */
export function createBrowserGate({ upstream, identify, chatName = (c) => c, isWorking = () => null, onChange = () => {}, now = Date.now }) {
  let control = "agent";           // "agent" | "owner"
  let holder = null;               // { chat, since, lastAt }
  const refused = new Set();       // chats told "the owner has control" since it was taken
  const connections = new Set();

  const holderActive = () => {
    if (!holder) return false;
    if (now() - holder.lastAt > HOLD_MS) return false;
    return isWorking(holder.chat) !== false;
  };
  const state = () => ({
    control,
    holder: holderActive() ? holder.chat : null,
    holderSince: holderActive() ? holder.since : 0,
  });
  const emit = (event) => { try { onChange({ ...event, state: state() }); } catch (e) { console.error(`[browser-gate] onChange failed: ${e.message}`); } };

  /** null = let it through; a string = the refusal to answer with. */
  function verdict(chat) {
    if (control === "owner") {
      refused.add(chat);
      return OWNER_HAS_CONTROL;
    }
    if (holderActive() && holder.chat !== chat) return busyMessage(chatName(holder.chat));
    if (!holder || holder.chat !== chat || !holderActive()) {
      holder = { chat, since: now(), lastAt: now() };
      console.log(`[browser-gate] chat ${chat} is browsing`);
      emit({ type: "browsing", chat });
    } else {
      holder.lastAt = now();
    }
    return null;
  }

  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    // A page in some browser must never drive this: agents call it from a shell.
    if (req.headers.origin) return reply(403, { error: "not for browsers" });
    if (req.method === "POST" && req.url === "/ask") {
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on("end", () => {
        let what = "";
        try { what = String(JSON.parse(body).what || "").trim().slice(0, MAX_ASK_CHARS); } catch { /* handled below */ }
        const chat = identify(req.socket.remotePort);
        if (!what) return reply(400, { error: 'say what you need: {"what": "..."}' });
        if (!chat) return reply(409, { error: "This command works from an agent started in the cockpit: the chat could not be identified." });
        console.log(`[browser-gate] chat ${chat} asks for the owner's turn`);
        emit({ type: "ask", chat, what });
        reply(200, { ok: true, next: "The owner has been asked. End your turn now: you will get a message when they hand the browser back." });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/state") return reply(200, state());
    reply(404, { error: "not found" });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.headers.origin) { socket.destroy(); return; }
    const chat = identify(req.socket.remotePort) || "terminal";
    wss.handleUpgrade(req, socket, head, (client) => {
      const target = new WebSocket(upstream.replace(/\/$/, "") + (req.url || "/"), { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      const pending = [];
      const conn = { chat, client };
      connections.add(conn);
      const close = () => {
        if (!connections.delete(conn)) return;
        try { client.close(); } catch { /* already closed */ }
        try { target.close(); } catch { /* already closed */ }
        // The last connection of the chat that held the browser frees it.
        if (holder?.chat === chat && ![...connections].some((c) => c.chat === chat)) {
          holder = null;
          emit({ type: "released", chat });
        }
      };
      target.on("open", () => { for (const m of pending.splice(0)) target.send(m.data, { binary: m.isBinary }); });
      target.on("message", (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
      target.on("close", close);
      target.on("error", (e) => { console.error(`[browser-gate] the browser refused the connection: ${e.message}`); close(); });
      client.on("close", close);
      client.on("error", close);
      client.on("message", (data, isBinary) => {
        let msg = null;
        if (!isBinary) { try { msg = JSON.parse(data.toString()); } catch { /* not a command */ } }
        if (msg && Number.isInteger(msg.id) && typeof msg.method === "string") {
          const no = verdict(chat);
          if (no) {
            if (process.env.BROWSER_GATE_DEBUG) console.log(`[browser-gate] refused ${msg.method} from chat ${chat}`);
            client.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), ...refusal(msg.method, no) }));
            return;
          }
        }
        if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
        else pending.push({ data, isBinary });
      });
    });
  });

  return {
    server,
    listen: (port, host = "127.0.0.1") => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server.address().port)); }),
    close: () => new Promise((resolve) => { for (const c of [...connections]) c.client.terminate(); wss.close(); server.close(() => resolve()); }),
    state,
    /** The owner takes the browser: from now on agents are refused. */
    takeControl() {
      if (control === "owner") return;
      control = "owner";
      refused.clear();
      console.log("[browser-gate] the owner took control");
      emit({ type: "control" });
    },
    /** The owner hands it back. Returns the chats that were refused meanwhile,
     *  plus the one that was browsing: they are the ones to tell. */
    handBack() {
      if (control === "agent") return [];
      control = "agent";
      const tell = new Set(refused);
      if (holder) { tell.add(holder.chat); holder.lastAt = now(); }
      refused.clear();
      console.log(`[browser-gate] the owner handed the browser back (to tell: ${[...tell].join(", ") || "nobody"})`);
      emit({ type: "control" });
      return [...tell].filter((c) => c !== "terminal");
    },
  };
}

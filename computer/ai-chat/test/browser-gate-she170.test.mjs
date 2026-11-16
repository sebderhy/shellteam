/**
 * SHE-170 — the gate between agents and the browser.
 *
 * Before it, an agent's browser tool spoke to the browser directly: nothing
 * could stop an agent while the owner typed a password in the live view, two
 * chats browsing at once clicked on each other's page, and the cockpit could
 * not tell which chat was browsing.
 *
 * Driven here over real WebSockets against a stand-in browser; the chat behind
 * a connection is found from a real child process (ss + /proc), as on a box.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { createBrowserGate, OWNER_HAS_CONTROL } from "../lib/browser-gate.mjs";
import { chatOfLocalPort, chatOfPid } from "../lib/peer-chat.mjs";

// A stand-in browser: answers every command, and can push an event.
const browser = new WebSocketServer({ port: 0, host: "127.0.0.1" });
const seen = [];
let browserSockets = [];
browser.on("connection", (ws, req) => {
  browserSockets.push(ws);
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); seen.push({ ...m, path: req.url }); ws.send(JSON.stringify({ id: m.id, result: { ok: m.method } })); });
});
await new Promise((r) => browser.on("listening", r));

let nextChat = "1";
let working = {};
const events = [];
let clock = 1_000_000;
const gate = createBrowserGate({
  upstream: `ws://127.0.0.1:${browser.address().port}`,
  identify: () => nextChat,
  chatName: (c) => `chat-${c}`,
  isWorking: (c) => working[c] ?? null,
  onChange: (e) => events.push(e),
  now: () => clock,
});
const port = await gate.listen(0);
after(async () => { await gate.close(); browser.close(); });

async function agent(chat, path = "/") {
  nextChat = chat;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0;
  const call = async (method, extra = {}) => {
    const mine = ++id * 1000 + Number(chat || 0);
    ws.send(JSON.stringify({ id: mine, method, ...extra }));
    for (let i = 0; i < 200; i++) { const hit = inbox.find((m) => m.id === mine); if (hit) return hit; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error(`no answer to ${method}`);
  };
  return { ws, inbox, call, close: () => new Promise((r) => { ws.on("close", r); ws.close(); }) };
}

test("commands reach the browser and answers come back; the cockpit learns which chat is browsing", async () => {
  const a = await agent("1", "/devtools/browser/abc?x=1");
  const res = await a.call("Page.navigate", { params: { url: "https://example.com" } });
  assert.deepEqual(res.result, { ok: "Page.navigate" });
  assert.equal(seen.at(-1).path, "/devtools/browser/abc?x=1", "the path the tool asked for is kept");
  assert.deepEqual(events.filter((e) => e.type === "browsing").map((e) => e.chat), ["1"]);
  assert.equal(gate.state().holder, "1");
  await a.call("Runtime.evaluate");
  assert.equal(events.filter((e) => e.type === "browsing").length, 1, "said once, not on every command");
  await a.close();
});

test("while the owner holds control an agent's command never reaches the browser, and it is told why", async () => {
  const a = await agent("1");
  await a.call("Page.reload");
  gate.takeControl();
  assert.equal(gate.state().control, "owner");
  const before = seen.length;
  const res = await a.call("Input.dispatchMouseEvent", { sessionId: "S1" });
  assert.equal(seen.length, before, "nothing was forwarded");
  assert.equal(res.error.message, OWNER_HAS_CONTROL);
  assert.equal(res.sessionId, "S1", "the refusal answers in the session the command came from");
  assert.match(OWNER_HAS_CONTROL, /Do not retry/);
  // A page script (what a snapshot, a click's lookup and a screenshot run) is
  // answered as a script that threw: Playwright retries a protocol error on
  // those until its 30 s timeout and then says only "Timeout".
  for (const method of ["Runtime.callFunctionOn", "Runtime.evaluate"]) {
    const thrown = await a.call(method);
    assert.equal(thrown.error, undefined);
    assert.equal(thrown.result.exceptionDetails.exception.description, `Error: ${OWNER_HAS_CONTROL}`);
  }
  assert.equal(seen.length, before, "nor were those forwarded");
  // The page the owner changes is still reported: the agent's view stays current.
  for (const s of browserSockets) if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ method: "Page.frameNavigated", params: {} }));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(a.inbox.some((m) => m.method === "Page.frameNavigated"));

  assert.deepEqual(gate.handBack(), ["1"], "the chat that was refused is the one to tell");
  assert.equal((await a.call("Page.reload")).result.ok, "Page.reload", "after the hand back it works again");
  assert.deepEqual(gate.handBack(), [], "handing back twice tells nobody");
  await a.close();
});

test("one chat at a time: a second chat is told who has the browser, and gets it when the first is done", async () => {
  const a = await agent("1");
  const b = await agent("2");
  working = { 1: true, 2: true };
  await a.call("Page.navigate");
  const before = seen.length;
  const no = await b.call("Page.navigate");
  assert.equal(seen.length, before, "chat 2 did not click on chat 1's page");
  assert.match(no.error.message, /in use by another chat \(chat-1\)/);
  // Chat 1's turn ends: the browser is free for the next chat that asks.
  working[1] = false;
  assert.equal(gate.state().holder, null);
  assert.equal((await b.call("Page.navigate")).result.ok, "Page.navigate");
  assert.equal(gate.state().holder, "2");
  // A chat that is still mid-turn but went quiet for long does not lock the others out.
  clock += 4 * 60 * 1000;
  working[1] = true;
  assert.equal((await a.call("Page.navigate")).result.ok, "Page.navigate");
  await a.close(); await b.close();
});

test("the browser is freed when the chat that held it disconnects", async () => {
  working = {};
  const a = await agent("5");
  await a.call("Page.navigate");
  assert.equal(gate.state().holder, "5");
  await a.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gate.state().holder, null);
  assert.ok(events.some((e) => e.type === "released" && e.chat === "5"));
});

const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body), headers });

test("an agent asks for the owner's turn in one sentence", async () => {
  nextChat = "3";
  const ok = await post("/ask", { what: "Sign in to Fnac, then tell me it is done." });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).next, /End your turn now/);
  const ask = events.findLast((e) => e.type === "ask");
  assert.deepEqual({ chat: ask.chat, what: ask.what }, { chat: "3", what: "Sign in to Fnac, then tell me it is done." });
  assert.equal((await post("/ask", { what: "x".repeat(900) })).status, 200);
  assert.equal(events.findLast((e) => e.type === "ask").what.length, 300, "one sentence, not a page");
  assert.equal((await post("/ask", { what: "  " })).status, 400);
  nextChat = null;
  assert.equal((await post("/ask", { what: "hello" })).status, 409, "a process outside any chat cannot ask in a chat's name");
});

test("a web page can never drive the gate", async () => {
  nextChat = "3";
  const n = events.length;
  assert.equal((await post("/ask", { what: "hi" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal(events.length, n);
  await assert.rejects(new Promise((r, j) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: "https://evil.example" }); ws.on("open", r); ws.on("error", j); }));
});

test("the chat behind a connection is found from the process that opened it", async () => {
  assert.equal(chatOfPid(4242, {
    environ: (pid) => ({ 4242: "PATH=/bin\0HOME=/x", 300: "A=1\0SHELLTEAM_CHAT=17\0B=2", 1: "" }[pid]),
    parent: (pid) => ({ 4242: 300, 300: 1 }[pid]),
  }), "17", "an ancestor's chat counts: the tool is a child of the agent");
  const none = { environ: () => "SHELLTEAM_CHATX=9\0NOT_SHELLTEAM_CHAT=4\0SHELLTEAM_CHAT=abc", parent: () => 1 };
  assert.equal(chatOfPid(4242, none), null, "only the exact variable with a number");
  assert.equal(chatOfPid(4242, { environ: () => { throw new Error("gone"); }, parent: () => 1 }), null);

  // For real: a child process started as chat 77 connects to us.
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const peerPort = new Promise((r) => server.on("connection", (s) => r(s.remotePort)));
  const child = spawn(process.execPath, ["-e", `require("net").connect(${server.address().port}, "127.0.0.1"); setTimeout(() => {}, 5000);`],
    { env: { ...process.env, SHELLTEAM_CHAT: "77" }, stdio: "ignore" });
  try {
    assert.equal(chatOfLocalPort(await peerPort), "77");
  } finally { child.kill(); server.close(); }
  assert.equal(chatOfLocalPort(1), null, "a port nobody holds");
});

// ── The cockpit around the gate ───────────────────────────────────────────────
import { readFileSync as read } from "node:fs";
import { mkdtempSync as tmp } from "node:fs";
import { tmpdir as tmpd } from "node:os";
import { join as j } from "node:path";
import { fileURLToPath as toPath } from "node:url";

const AI_CHAT = j(toPath(new URL(".", import.meta.url)), "..");
const src = (rel) => read(j(AI_CHAT, rel), "utf8");

test("an agent asking for the owner's turn makes its chat read 'Needs you', until they act", async () => {
  process.env.HOME = tmp(j(tmpd(), "st-browser-"));
  const sm = await import("../lib/session-manager.mjs");
  sm._testSetAgentFactory(() => ({ on() {}, start() {}, stop() {}, interrupt() {}, sendMessage() {} }));
  sm.setBroadcast(() => {});
  sm.createSlot(900, { model: "gpt-6-luna", cwd: process.env.HOME });
  const row = () => sm.listSlots().find((s) => s.id === 900);
  assert.equal(row().needsOwner, "");
  assert.equal(sm.setNeedsOwner(900, "Sign in to Fnac"), true);
  assert.equal(row().needsOwner, "Sign in to Fnac");
  // A cockpit notice is not the owner acting; a message they type is.
  sm.addUserMessage(900, "<cockpit-notice>\nmoved\n</cockpit-notice>");
  assert.equal(row().needsOwner, "Sign in to Fnac");
  sm.addUserMessage(900, "done, I signed in");
  assert.equal(row().needsOwner, "");
  assert.equal(sm.setNeedsOwner(12345, "x"), false, "a chat that does not exist");
  // The column: it stopped for the owner, so it is neither Done nor idle.
  const js = src("public/projects.js");
  assert.match(js, /if \(slot\.needsOwner && !working\) return \{ kind: 'ask', text: 'Needs you' \};/);
});

test("agents are told which chat they are only when the box has a browser", async () => {
  const sm = src("lib/session-manager.mjs");
  assert.match(sm, /return enabledModules\(\)\.includes\("browser"\) \? \{ SHELLTEAM_CHAT: String\(slotId\) \} : \{\};/,
    "pure core adds nothing to an agent's environment");
  assert.match(sm, /env: \{ \.\.\.getCliEnv\(\), \.\.\.chatEnv\(slotId\) \}/);
});

test("the server wires take control, hand back and the notice that resumes the agent", () => {
  const server = src("server.mjs");
  assert.match(server, /case "browser_control": \{\s*if \(!browserGate\) break;\s*if \(msg\.take === true\) browserGate\.takeControl\(\);\s*else await handBrowserBack\(\);/);
  const back = server.slice(server.indexOf("async function handBrowserBack()"), server.indexOf("function startBrowserGate()"));
  assert.match(back, /for \(const s of listSlots\(\)\) if \(s\.needsOwner\) chats\.add\(s\.id\);/, "a chat that asked is told even if it was never refused");
  assert.match(back, /if \(row\.isGenerating\) continue;/, "mid-turn, its next command simply works");
  assert.match(back, /addUserMessage\(slot, BROWSER_HANDED_BACK\);[\s\S]*await sendMessage\(slot, BROWSER_HANDED_BACK\);/);
  assert.match(server, /look at it again \(take a snapshot\) before you act/);
  // An employee's cockpit reaches its own sidecar: no gate, nothing changes there.
  assert.match(server, /if \(!enabledModules\(\)\.includes\("browser"\) \|\| browserProxyEnabled\(\)\) return;/);
  // A gate that cannot listen is said loudly: agents cannot browse without it.
  assert.match(server, /BROWSER GATE FAILED to listen/);
  assert.match(server, /browser: browserGate \? browserGate\.state\(\) : null,/);
});

test("the browser opens beside the chat that is browsing, once, and stays closed if the owner closed it", () => {
  const js = src("public/projects.js");
  const show = js.match(/\n    function showBrowserFor\(chat, \{ force = false \} = \{\}\) \{[\s\S]*?\n    \}\n/)[0];
  assert.match(show, /chat !== activeSlotId\) return;/, "only for the chat on screen");
  assert.match(show, /browserShown\.has\(chat\) \|\| browserClosed\.has\(chat\)/);
  assert.match(show, /if \(!force && openPanel && openPanel !== 'browser'\) return;/, "it never takes a report away");
  assert.match(js, /if \(msg\.event === 'browsing' \|\| msg\.event === 'ask'\) showBrowserFor\(msg\.chat\);/);
  assert.match(js, /if \(openPanel === 'browser'\) browserClosed\.add\(activeSlotId\);/);
  assert.match(js, /if \(kind === 'browser'\) return `\$\{base\}\/browser\?panel=1`;/);
  // "Needs you in the browser", with the one button that gives them the browser.
  const html = src("public/index.html");
  assert.match(html, /id="pjNeedsOwner" role="status" hidden>/);
  assert.match(js, /showBrowserFor\(activeSlotId, \{ force: true \}\);\s*setControl\(true\);/);
});

test("the live view gates the owner's input until they take control, and says who has the browser", () => {
  const page = read(j(AI_CHAT, "..", "..", "frontend", "browser.html"), "utf8");
  const dash = read(j(AI_CHAT, "..", "..", "frontend", "dashboard.html"), "utf8");
  assert.match(page, /const allowed = \(\) => !state \|\| state\.control === 'owner';/, "alone (no cockpit), it is a plain live view");
  assert.equal((page.match(/browserControl\.gate\(/g) || []).length, 2, "both sockets that carry the owner's input are gated");
  assert.match(page, /if \(\/"mouseMoved"\|"getSelectedText"\/\.test\(String\(data\)\)\) return;/, "moving the pointer is not an attempt to act");
  for (const words of ["You have the browser.", "Agents are paused until you hand it back.", "Take control", "Hand back", "is browsing. You are watching."]) {
    assert.ok(page.includes(words), `the bar says "${words}"`);
  }
  // Phone: the button is a full-width 44 px row that cannot scroll away.
  assert.match(page, /#browser-control-btn\{min-height:44px;flex:1 0 100%;\}/);
  // The state and the owner's choice cross between the two origins through the dashboard.
  assert.match(dash, /new BroadcastChannel\('shellteam-browser'\)/);
  assert.match(dash, /if \(d\.kind === 'control'\) postToCockpit\(\{ kind: 'browser-control', take: d\.take === true \}\);/);
  assert.match(dash, /d\.kind === 'browser-state'\) browserChannel\.postMessage\(/);
  assert.match(dash, /x\.pathname === '\/knowledge' \|\| x\.pathname === '\/browser';/, "the live view may open in the trusted side panel");
});

test("a cockpit notice never becomes a chat's name", () => {
  // Seen in QA on 15 Nov 2026: an untitled chat was named "<cockpit-notice> The owner has…".
  const app = src("public/app.js");
  const fn = app.match(/\nfunction updateSlotLabel\(slotId, rawText\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /cockpit-notice\)\/\.test\(text\)\) return;/);
});

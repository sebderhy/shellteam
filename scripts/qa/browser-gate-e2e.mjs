#!/usr/bin/env node
// browser-gate-e2e.mjs: does an agent's real browser tool obey the gate?
//
// Why (SHE-170): the gate's unit tests speak CDP by hand. What an agent runs
// is Playwright's MCP server, and Playwright does its own thing with errors:
// on 15 Nov 2026 a refused snapshot did not say "the owner has taken control",
// it retried for 30 s and said "Timeout". Only the real tool shows that.
//
// Starts a gate of its own in front of the box's browser, starts the real
// Playwright MCP server the way an agent's CLI does (a child process carrying
// SHELLTEAM_CHAT), and checks: the chat is recognised, a tool call works, every
// kind of tool call is refused AT ONCE and IN WORDS while the owner has
// control, and works again after the hand back.
//
//   node scripts/qa/browser-gate-e2e.mjs            # the box's browser (:3877)
//   node scripts/qa/browser-gate-e2e.mjs 3899       # another Steel port
//
// It opens example.com in the browser: run it when no agent is browsing.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserGate } from "../../computer/ai-chat/lib/browser-gate.mjs";
import { chatOfLocalPort } from "../../computer/ai-chat/lib/peer-chat.mjs";

const steelPort = Number(process.argv[2] || process.env.STEEL_PORT || 3877);
const events = [];
const gate = createBrowserGate({ upstream: `ws://127.0.0.1:${steelPort}`, identify: chatOfLocalPort, onChange: (e) => events.push(e) });
const port = await gate.listen(0);
const mcp = spawn("npx", ["-y", "@playwright/mcp@latest", "--cdp-endpoint", `ws://127.0.0.1:${port}`, "--output-dir", mkdtempSync(join(tmpdir(), "st-gate-e2e-"))],
  { env: { ...process.env, SHELLTEAM_CHAT: "4242" }, stdio: ["pipe", "pipe", "inherit"] });

let buf = "", nextId = 1;
const waiting = new Map();
mcp.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0;) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise((res) => { const id = nextId++; waiting.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const tool = async (name, args = {}) => {
  const started = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  return { text: (r.result?.content || []).map((c) => c.text || "").join("\n") + (r.error ? JSON.stringify(r.error) : ""), ms: Date.now() - started };
};

const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shellteam-qa", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const first = await tool("browser_navigate", { url: "https://example.com" });
  check(/Example Domain/.test(first.text), "an agent's tool call goes through the gate");
  check(events.some((e) => e.type === "browsing" && e.chat === "4242"), "the gate knows which chat is browsing, from the process tree");

  gate.takeControl();
  for (const [name, args] of [["browser_snapshot", {}], ["browser_navigate", { url: "https://example.org" }], ["browser_press_key", { key: "a" }], ["browser_take_screenshot", {}]]) {
    const r = await tool(name, args);
    check(/The owner has taken control of the browser/.test(r.text), `${name} is refused in words while the owner has control`);
    check(r.ms < 5000, `${name} is refused at once (${r.ms} ms), not after a timeout`);
  }
  check(gate.handBack().includes("4242"), "the hand back names the chat to tell");
  const again = await tool("browser_snapshot");
  check(/Example Domain/.test(again.text) && !/taken control/.test(again.text), "after the hand back the agent sees the page again");
} finally {
  mcp.kill();
  await gate.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nbrowser gate OK");
process.exit(failures.length ? 1 : 0);

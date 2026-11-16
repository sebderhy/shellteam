#!/usr/bin/env node
// browser-live-view.mjs: does the Browser tab's live picture still work?
//
// Why (SHE-207): on 15 Nov 2026 the newest Steel build passed /v1/health,
// launched Chromium and answered CDP, and its live view answered nobody:
// upstream commit #405 made the cast socket look for a session id in a path
// its own router never matches. The Browser tab IS that live view, and it is
// how the owner takes over at a login or a bot check. Run this against any
// Steel image before moving the pin in deploy/browser/run-steel.sh.
//
//   node scripts/qa/browser-live-view.mjs                 # the box's browser
//   node scripts/qa/browser-live-view.mjs ws://127.0.0.1:3899
//
// It asks for the tab list, then for one frame of the first tab, exactly as
// frontend/browser.html does. Read-only: it sends no input and opens no page.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(new URL("../../computer/ai-chat/package.json", import.meta.url)));
const WebSocket = require("ws");

const base = process.argv[2] || `ws://127.0.0.1:${process.env.STEEL_PORT || 3877}`;

function firstMessage(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`no answer in 10 s from ${url}`)); }, 10000);
    ws.on("message", (data) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(data.toString())); });
    ws.on("error", (err) => { clearTimeout(timer); reject(new Error(`${url}: ${err.message}`)); });
  });
}

try {
  const list = await firstMessage(`${base}/v1/sessions/cast?tabInfo=true`);
  if (list.type !== "tabList" || !list.tabs?.length) throw new Error(`expected a tab list, got ${JSON.stringify(list).slice(0, 120)}`);
  const frame = await firstMessage(`${base}/v1/sessions/cast?pageId=${encodeURIComponent(list.tabs[0].id)}`);
  if (!frame.pageId || !frame.data) throw new Error(`expected a frame with a picture, got keys ${Object.keys(frame)}`);
  console.log(`live view OK: ${list.tabs.length} tab(s), first frame ${Math.round(frame.data.length / 1024)} kB`);
} catch (err) {
  console.error(`LIVE VIEW BROKEN: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
// Codex mid-turn behaviour against a LIVE cockpit (SHE-107 / SHE-109).
//
// Drives the real cockpit WebSocket with a real Codex process and checks that
// steering a running turn never surfaces "already has an active writer":
//   steer      send a second message while a tool call runs → both answered, in order
//   stop-send  Stop the running turn, send another message at once → answered
//   burst      two messages back-to-back with no wait → both answered
//   after-done a message the instant turn_done arrives → answered
//   switch     switch model (same family) mid-turn, then send → answered
//   hold       start a long turn and return (for an external restart test)
//   resume     send one message on an existing slot (after the external event)
//
// Usage:  node scripts/qa/codex-steer.mjs [--url ws://127.0.0.1:3456/ws]
//                 [--model gpt-5.6-sol-max] [--scenario all|steer|…] [--slot N]
// Exit 0 when every check passed. Needs Node 22+ (global WebSocket).

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter(Boolean),
);
const URL_ = args.url || "ws://127.0.0.1:3456/ws";
const MODEL = args.model || "gpt-5.6-sol-max";
const SCENARIO = args.scenario || "all";
const TURN_TIMEOUT_MS = 240_000;
const WRITER_RE = /already has an active writer/i;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failures++; };

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL_);
    ws._log = [];
    ws._waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      ws._log.push({ at: Date.now(), ...msg });
      for (const w of [...ws._waiters]) {
        if (w.pred(msg)) { ws._waiters.splice(ws._waiters.indexOf(w), 1); w.res(msg); }
      }
    };
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });
}
function waitFor(ws, pred, timeout = TURN_TIMEOUT_MS) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting: ${pred.toString().slice(0, 80)}`)), timeout);
    ws._waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
  });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function transcript(ws, slot, since) {
  return ws._log.filter((m) => m.slot === slot && m.at >= since);
}
function textOf(events) {
  return events.filter((m) => m.type === "text_done").map((m) => m.content || m.text || "").join("\n")
    + "\n" + events.filter((m) => m.type === "text_delta").map((m) => m.content || m.text || "").join("");
}
function writerErrors(events) {
  return events.filter((m) =>
    (m.type === "error" && WRITER_RE.test(m.message || "")) ||
    (m.type === "turn_done" && (m.errors || []).some((e) => WRITER_RE.test(String(e)))));
}
function turnDones(events) { return events.filter((m) => m.type === "turn_done"); }

async function newTab(ws) {
  const nonce = `qa-${Date.now()}`;
  send(ws, { type: "create_tab", fresh: true, nonce, model: MODEL });
  const created = await waitFor(ws, (m) => m.type === "tab_created" && m.nonce === nonce, 15_000);
  send(ws, { type: "set_model", slot: created.slot, model: MODEL });
  await sleep(300);
  return created.slot;
}

const LONG = (tag) => `Run the shell command \`sleep 40\` (really wait for it), then reply with exactly the single word DONE-${tag} and nothing else.`;
const SHORT = (tag) => `Reply with exactly the single word DONE-${tag} and nothing else.`;

async function scenarioSteer(ws) {
  const slot = await newTab(ws);
  const t0 = Date.now();
  send(ws, { type: "send", slot, content: LONG("A") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "tool_start");
  await sleep(1500);
  send(ws, { type: "send", slot, content: SHORT("B") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "turn_done");
  await waitFor(ws, (m) => m.slot === slot && m.type === "turn_done" && turnDones(transcript(ws, slot, t0)).length >= 2);
  const ev = transcript(ws, slot, t0);
  const text = textOf(ev);
  check(writerErrors(ev).length === 0, `steer: no writer conflict surfaced (${writerErrors(ev).length} seen)`);
  check(/DONE-A/.test(text), "steer: first turn answered (DONE-A)");
  check(/DONE-B/.test(text), "steer: mid-turn message answered (DONE-B)");
  check(text.indexOf("DONE-A") < text.indexOf("DONE-B"), "steer: answered in order");
  return slot;
}

async function scenarioStopSend(ws) {
  const slot = await newTab(ws);
  const t0 = Date.now();
  send(ws, { type: "send", slot, content: LONG("X") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "tool_start");
  send(ws, { type: "interrupt", slot });
  send(ws, { type: "send", slot, content: SHORT("C") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "turn_done" && /DONE-C/.test(textOf(transcript(ws, slot, t0))));
  const ev = transcript(ws, slot, t0);
  check(writerErrors(ev).length === 0, `stop-send: no writer conflict surfaced (${writerErrors(ev).length} seen)`);
  check(/DONE-C/.test(textOf(ev)), "stop-send: message after Stop answered (DONE-C)");
  return slot;
}

async function scenarioBurst(ws) {
  const slot = await newTab(ws);
  const t0 = Date.now();
  send(ws, { type: "send", slot, content: SHORT("D") });
  send(ws, { type: "send", slot, content: SHORT("E") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "turn_done" && turnDones(transcript(ws, slot, t0)).length >= 2);
  const ev = transcript(ws, slot, t0);
  const text = textOf(ev);
  check(writerErrors(ev).length === 0, `burst: no writer conflict surfaced (${writerErrors(ev).length} seen)`);
  check(/DONE-D/.test(text) && /DONE-E/.test(text), "burst: both messages answered");
  return slot;
}

async function scenarioAfterDone(ws) {
  const slot = await newTab(ws);
  const t0 = Date.now();
  send(ws, { type: "send", slot, content: SHORT("F") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "turn_done");
  send(ws, { type: "send", slot, content: SHORT("G") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "turn_done" && turnDones(transcript(ws, slot, t0)).length >= 2);
  const ev = transcript(ws, slot, t0);
  check(writerErrors(ev).length === 0, `after-done: no writer conflict surfaced (${writerErrors(ev).length} seen)`);
  check(/DONE-G/.test(textOf(ev)), "after-done: immediate follow-up answered (DONE-G)");
  return slot;
}

async function scenarioSwitch(ws) {
  const slot = await newTab(ws);
  const t0 = Date.now();
  send(ws, { type: "send", slot, content: LONG("S") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "tool_start");
  send(ws, { type: "set_model", slot, model: MODEL === "gpt-5.6-sol-max" ? "gpt-5.6-terra-max" : "gpt-5.6-sol-max" });
  await sleep(1000);
  send(ws, { type: "send", slot, content: SHORT("H") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "turn_done" && /DONE-H/.test(textOf(transcript(ws, slot, t0))), TURN_TIMEOUT_MS);
  const ev = transcript(ws, slot, t0);
  check(writerErrors(ev).length === 0, `switch: no writer conflict surfaced (${writerErrors(ev).length} seen)`);
  check(/DONE-H/.test(textOf(ev)), "switch: message after mid-turn model switch answered (DONE-H)");
  return slot;
}

async function scenarioHold(ws) {
  const slot = await newTab(ws);
  send(ws, { type: "send", slot, content: LONG("HOLD") });
  await waitFor(ws, (m) => m.slot === slot && m.type === "tool_start");
  console.log(`hold: slot ${slot} is mid-turn (sleep 40 running)`);
  console.log(`SLOT=${slot}`);
  return slot;
}

async function scenarioResume(ws) {
  const slot = Number(args.slot);
  const t0 = Date.now();
  send(ws, { type: "send", slot, content: SHORT("R") });
  const done = await waitFor(ws, (m) => m.slot === slot && (m.type === "turn_done" || (m.type === "error")), TURN_TIMEOUT_MS)
    .catch((e) => ({ type: "timeout", message: e.message }));
  await sleep(500);
  const ev = transcript(ws, slot, t0);
  const werr = writerErrors(ev);
  console.log(`resume: first terminal event: ${done.type} ${done.message || (done.errors || []).join("; ") || ""}`);
  check(werr.length === 0, `resume: no writer conflict surfaced (${werr.length} seen)`);
  check(/DONE-R/.test(textOf(ev)), "resume: message answered (DONE-R)");
  return slot;
}

const scenarios = {
  steer: scenarioSteer, "stop-send": scenarioStopSend, burst: scenarioBurst,
  "after-done": scenarioAfterDone, switch: scenarioSwitch, hold: scenarioHold, resume: scenarioResume,
};
const run = SCENARIO === "all" ? ["steer", "stop-send", "burst", "after-done", "switch"] : [SCENARIO];

const ws = await connect();
await waitFor(ws, (m) => m.type === "status", 15_000);
for (const name of run) {
  console.log(`--- ${name}`);
  try {
    const slot = await scenarios[name](ws);
    if (name !== "hold") { send(ws, { type: "close_tab", slot }); await sleep(300); }
  } catch (e) {
    check(false, `${name}: ${e.message}`);
  }
}
ws.close();
console.log(failures ? `${failures} check(s) FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);

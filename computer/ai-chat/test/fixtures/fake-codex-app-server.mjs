#!/usr/bin/env node
/**
 * A stand-in for `codex app-server --stdio`, for tests that drive CodexAgent's
 * real spawn/close path without quota or network.
 *
 * Speaks the slice of the protocol the cockpit uses: initialize,
 * thread/start|resume, turn/start, turn/steer. Each turn answers its input as
 * "reply to <text>" and completes after FAKE_CODEX_TURN_MS; a steered input
 * is read by the running turn ("steered: <text>"). The process exits when its
 * stdin closes, like the real one.
 *
 *   FAKE_CODEX_LOG           append one JSON line per argv and per request
 *   FAKE_CODEX_TURN_MS       how long a turn runs before completing (default 0)
 *   FAKE_CODEX_REFUSE_STEER  answer turn/steer with an error (turn already over)
 *   FAKE_CODEX_THREAD        thread id handed out (default "thread-fake")
 */
import { appendFileSync } from "node:fs";

const LOG = process.env.FAKE_CODEX_LOG;
const TURN_MS = Number(process.env.FAKE_CODEX_TURN_MS || 0);
const THREAD = process.env.FAKE_CODEX_THREAD || "thread-fake";
const log = (record) => { if (LOG) appendFileSync(LOG, `${JSON.stringify(record)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });

log({ argv: process.argv.slice(2) });

let turnSeq = 0;
let experimentalApi = false;
let turn = null;   // { id, timer }
const textOf = (input) => input.filter((i) => i.type === "text").map((i) => i.text).join("");

function reply(text) {
  const id = `msg-${Math.random().toString(36).slice(2)}`;
  notify("item/started", { threadId: THREAD, turnId: turn.id, item: { type: "agentMessage", id, text: "" } });
  notify("item/agentMessage/delta", { threadId: THREAD, turnId: turn.id, itemId: id, delta: text });
  notify("item/completed", { threadId: THREAD, turnId: turn.id, item: { type: "agentMessage", id, text } });
}

function finishTurn() {
  const { id } = turn;
  notify("thread/tokenUsage/updated", { threadId: THREAD, turnId: id, tokenUsage: { last: { totalTokens: 1234 }, modelContextWindow: 258400 } });
  notify("turn/completed", { threadId: THREAD, turn: { id, status: "completed", error: null, items: [] } });
  turn = null;
}

function handle({ id, method, params }) {
  log({ method, params });
  switch (method) {
    case "initialize":
      experimentalApi = !!params.capabilities?.experimentalApi;
      return send({ id, result: { userAgent: "fake" } });
    case "thread/resume":
      // As Codex 0.150-0.158 answer (seen live on 0.150.0, 2026-10-25).
      if (params.excludeTurns && !experimentalApi) {
        return send({ id, error: { code: -32600, message: "thread/resume.excludeTurns requires experimentalApi capability" } });
      }
      return send({ id, result: { thread: { id: THREAD } } });
    case "thread/start": return send({ id, result: { thread: { id: THREAD } } });
    case "turn/start": {
      turn = { id: `turn-${++turnSeq}` };
      send({ id, result: { turn: { id: turn.id, status: "inProgress" } } });
      notify("turn/started", { threadId: THREAD, turn: { id: turn.id, status: "inProgress" } });
      notify("item/started", { threadId: THREAD, turnId: turn.id, item: { type: "userMessage", id: "u0", clientId: null, content: params.input } });
      reply(`reply to ${textOf(params.input)}`);
      turn.timer = setTimeout(finishTurn, TURN_MS);
      return;
    }
    case "turn/steer": {
      if (process.env.FAKE_CODEX_REFUSE_STEER || !turn || params.expectedTurnId !== turn.id) {
        return send({ id, error: { code: -32600, message: "no active turn to steer" } });
      }
      send({ id, result: { turnId: turn.id } });
      notify("item/started", { threadId: THREAD, turnId: turn.id, item: { type: "userMessage", id: "u1", clientId: params.clientUserMessageId, content: params.input } });
      reply(`steered: ${textOf(params.input)}`);
      return;
    }
    default:
      if (id != null) send({ id, error: { code: -32601, message: `fake app-server: ${method} not implemented` } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

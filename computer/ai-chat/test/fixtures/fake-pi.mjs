#!/usr/bin/env node
// A stand-in for `pi --mode rpc` (docs/rpc.md, docs/json.md in Pi's package):
// reads JSONL commands on stdin, answers and streams events on stdout, and logs
// its argv, env and every command to $FAKE_PI_LOG for the test to inspect.
import { appendFileSync } from "node:fs";

const log = (rec) => appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify(rec)}\n`);
// FAKE_PI_ONECHUNK: everything one command produces leaves in a single write,
// so the reader gets the answer and the run's events in the same chunk.
let batch = null;
const out = (rec) => {
  const line = `${JSON.stringify(rec)}\n`;
  if (batch !== null) batch += line; else process.stdout.write(line);
};
log({ argv: process.argv.slice(2), env: { SHELLTEAM_PI_LAYER: process.env.SHELLTEAM_PI_LAYER, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PI_TELEMETRY: process.env.PI_TELEMETRY } });

let running = false;
let starting = false;   // a prompt accepted, its run not started yet (FAKE_PI_SLOWSTART)
let slowTimer = null;
const steered = [];
const settle = (aborted = false) => {
  // Like Pi: a steered or follow-up message is answered in the same run, before it settles.
  if (!aborted && steered.length) { const m = steered.shift(); answer(m); return settle(); }
  running = false;
  out({ type: "agent_settled", aborted });
};
function answer(message) {
  out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: `answer to: ${message}` } });
}

function run(message) {
  running = true;
  out({ type: "agent_start" });
  if (message.includes("CRASH")) { process.stderr.write("boom: provider exploded\n"); process.exit(3); }
  if (message.includes("ERR")) {
    out({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" } });
    settle();
    return;
  }
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo there" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Hello there" } });
  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } } } });
  out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
  out({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt" }] }, isError: false });
  answer(message);
  if (message.includes("SLOW")) { slowTimer = setTimeout(() => settle(), 5000); return; }
  settle();
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const cmd = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log({ cmd });
    if (process.env.FAKE_PI_ONECHUNK) batch = "";
    const reply = (data) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data ? { data } : {}) });
    switch (cmd.type) {
      case "prompt":
        if (starting && cmd.streamingBehavior) {
          // Real Pi, seen live: a queued prompt that lands before the first
          // run started is "started" as its own run, which settles at once
          // and is never answered.
          reply({ disposition: "started" });
          out({ type: "agent_start" });
          out({ type: "agent_settled", aborted: false });
          break;
        }
        if (running) { steered.push(cmd.message); reply({ disposition: "queued" }); break; }
        reply({ disposition: "started" });
        if (process.env.FAKE_PI_SLOWSTART) {
          starting = true;
          setTimeout(() => { starting = false; run(cmd.message); }, 300);
        } else run(cmd.message);
        break;
      case "get_session_stats":
        reply({ cost: 0.12, contextUsage: { tokens: 1234, contextWindow: 1048576, percent: 0 } });
        break;
      case "compact":
        if (process.env.FAKE_PI_TINY) {
          out({ id: cmd.id, type: "response", command: "compact", success: false, error: "Compaction failed: Nothing to compact (session too small)" });
          break;
        }
        out({ type: "compaction_start", reason: "manual" });
        out({ type: "compaction_end", reason: "manual", result: { summary: "the summary" }, aborted: false, willRetry: false });
        reply({ summary: "the summary" });
        break;
      case "abort":
        clearTimeout(slowTimer);
        // A late event from the aborted run, then the settle, then the answer.
        out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "LATE" } });
        if (running) settle(true);
        setTimeout(() => reply(), 50);
        break;
      default:
        reply();
    }
    if (batch !== null) { process.stdout.write(batch); batch = null; }
  }
});
process.stdin.on("end", () => process.exit(0));

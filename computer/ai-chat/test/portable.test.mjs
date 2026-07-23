/**
 * Portable sessions — unit suite (hermetic, no CLIs, no keys).
 *
 * Covers the CSF core (protocol→CSF, pairing, tool-output flattening) and the
 * file-writing exporters (Claude/Codex) against the identity-constraint
 * table in the plan (§4) and the design invariants (§2). The real-CLI resume
 * proof is the golden matrix (scripts/golden-portable-sessions.mjs), opt-in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { protocolToCsf, pairCheck, stringifyToolOutput, encodeCwd, projectHash, capToolOutput, capToolResults, TOOL_OUTPUT_CAP_CHARS, sanitizeCodexToolName } from "../lib/portable/csf.mjs";
import { exportSession } from "../lib/portable/export.mjs";

const CWD = "/tmp/portable-test-ws";

// A representative protocol stream: user → assistant(text+tool_call) → tool_result → assistant(text).
const PROTO = [
  { type: "user_message", content: "Remember the codeword: PURPLETIGER.", timestamp: 1782050000000 },
  { type: "text_done", text: "I'll note that." },
  { type: "tool_start", id: "toolu_1", name: "Bash" },
  { type: "tool_input", id: "toolu_1", input: { command: "echo hi" } },
  { type: "tool_result", id: "toolu_1", content: "hi", is_error: false },
  { type: "text_done", text: "OK" },
  { type: "turn_done", cost: 0.01 },
  { type: "user_message", content: "What is the codeword?", timestamp: 1782050001000 },
  { type: "text_done", text: "PURPLETIGER" },
  { type: "turn_done", cost: 0.02 },
];

function makeCsf(events, cwd = CWD) {
  return {
    csf: 1,
    session: { id: "csf_test", cwd, title: "t", createdAt: 0, source: {}, lineage: [] },
    events,
  };
}

test("protocolToCsf groups assistant parts and separates tool_result events", () => {
  const events = protocolToCsf(PROTO, { defaultModel: "claude-opus-4-8" });
  assert.equal(events[0].type, "message");
  assert.equal(events[0].role, "user");
  assert.equal(events[0].parts[0].text, "Remember the codeword: PURPLETIGER.");

  // assistant message carries text + tool_call, model labeled
  const asst = events[1];
  assert.equal(asst.role, "assistant");
  assert.equal(asst.model, "claude-opus-4-8");
  assert.deepEqual(asst.parts.map((p) => p.type), ["text", "tool_call"]);
  assert.equal(asst.parts[1].input.command, "echo hi");

  // tool_result is its own event, immediately after the assistant message
  assert.equal(events[2].type, "tool_result");
  assert.equal(events[2].callId, "toolu_1");
  assert.equal(events[2].output, "hi");

  // second assistant text (post-result) is a separate message event
  assert.equal(events[3].role, "assistant");
  assert.equal(events[3].parts[0].text, "OK");

  // final Q&A
  const last = events.at(-1);
  assert.equal(last.parts[0].text, "PURPLETIGER");
});

test("protocolToCsf emits a compaction event", () => {
  const events = protocolToCsf(
    [{ type: "session_event", event: "compacted", summary: "earlier stuff" },
     { type: "user_message", content: "hi" }],
    {},
  );
  assert.equal(events[0].type, "compaction");
  assert.equal(events[0].summary, "earlier stuff");
});

test("pairCheck synthesizes an interrupted result for a dangling tool_call", () => {
  const events = [
    { type: "message", role: "assistant", parts: [{ type: "tool_call", id: "x", name: "Bash", input: {} }] },
  ];
  const { events: out, synthesized, toolCalls } = pairCheck(events);
  assert.equal(toolCalls, 1);
  assert.equal(synthesized, 1);
  assert.equal(out[1].type, "tool_result");
  assert.equal(out[1].callId, "x");
  assert.equal(out[1].isError, true);
});

test("pairCheck leaves already-answered calls alone and does not mutate input", () => {
  const events = [
    { type: "message", role: "assistant", parts: [{ type: "tool_call", id: "x", name: "B", input: {} }] },
    { type: "tool_result", callId: "x", output: "done", isError: false },
  ];
  const before = JSON.stringify(events);
  const { events: out, synthesized } = pairCheck(events);
  assert.equal(synthesized, 0);
  assert.equal(out.length, 2);
  assert.equal(JSON.stringify(events), before); // invariant 8: input untouched
});

test("stringifyToolOutput flattens arrays and images", () => {
  assert.equal(stringifyToolOutput("plain"), "plain");
  assert.equal(
    stringifyToolOutput([{ type: "text", text: "a" }, { type: "image", source: { media_type: "image/jpeg" } }]),
    "a\n[image: image/jpeg]",
  );
});

test("capToolOutput leaves small outputs untouched and truncates oversized ones head+tail", () => {
  const small = "x".repeat(100);
  assert.equal(capToolOutput(small), small, "under-cap output is returned unchanged");

  const huge = "H".repeat(20) + "M".repeat(TOOL_OUTPUT_CAP_CHARS * 2) + "T".repeat(20);
  const out = capToolOutput(huge);
  assert.ok(out.length < huge.length, "over-cap output is shortened");
  assert.ok(out.length <= TOOL_OUTPUT_CAP_CHARS + 400, "capped output near the cap (+marker)");
  assert.ok(out.startsWith("HHHH"), "keeps the head");
  assert.ok(out.endsWith("TTTT"), "keeps the tail");
  assert.match(out, /characters truncated when this conversation was carried over/, "has a visible truncation marker");

  // non-strings (defensive) pass through
  assert.equal(capToolOutput(null), null);
});

test("capToolResults caps only oversized tool_result events, never mutates input, keeps the count", () => {
  const big = "B".repeat(TOOL_OUTPUT_CAP_CHARS + 5000);
  const events = [
    { type: "message", role: "user", parts: [{ type: "text", text: "hi" }] },
    { type: "tool_result", callId: "a", output: "small", isError: false },
    { type: "tool_result", callId: "b", output: big, isError: false },
  ];
  const snapshot = JSON.stringify(events);
  const { events: out, capped, charsDropped } = capToolResults(events);

  assert.equal(capped, 1, "exactly one oversized result capped");
  assert.ok(charsDropped > 4000, "reports the dropped char count");
  assert.equal(out.length, events.length, "event count preserved");
  assert.equal(out[1].output, "small", "small result untouched");
  assert.ok(out[2].output.length < big.length, "big result shortened");
  assert.equal(JSON.stringify(events), snapshot, "input array not mutated (invariant 8)");
});

test("oversized tool_result is capped in the exported Claude session (SHE-56/57 handoff brick)", async () => {
  const root = mkdtempSync(join(tmpdir(), "csf-cap-"));
  const huge = "Z".repeat(TOOL_OUTPUT_CAP_CHARS * 6); // ~240k chars — would blow a window
  const csf = makeCsf([
    { type: "message", role: "user", parts: [{ type: "text", text: "run it" }] },
    { type: "message", role: "assistant", model: "gpt-5.5", parts: [
      { type: "tool_call", id: "call_1", name: "Bash", input: { command: "cat bundle.min.js" } },
    ] },
    { type: "tool_result", callId: "call_1", output: huge, isError: false },
  ]);
  const { file } = await exportSession("claude", csf, { root });
  const written = readFileSync(file, "utf8");
  assert.ok(written.length < huge.length, "the exported session is smaller than the raw oversized output");
  assert.match(written, /characters truncated when this conversation was carried over/, "carries the truncation marker");
});

test("Claude export: filename==sessionId, parentUuid chain, tool_result blocks, no reasoning", async () => {
  const root = mkdtempSync(join(tmpdir(), "csf-claude-"));
  const csf = makeCsf([
    { type: "message", role: "user", parts: [{ type: "text", text: "hi" }] },
    { type: "message", role: "assistant", model: "claude-opus-4-8", parts: [
      { type: "reasoning", text: "SECRET THINKING" },
      { type: "text", text: "hello" },
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } },
    ] },
    { type: "tool_result", callId: "t1", output: "file.txt", isError: false },
  ]);
  const { nativeSessionId, file } = await exportSession("claude", csf, { root });

  assert.ok(file.endsWith(`${nativeSessionId}.jsonl`), "filename must equal sessionId");
  assert.ok(file.includes(encodeCwd(CWD)), "must live in the cwd-encoded project dir");

  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // parentUuid chain
  let prev = null;
  for (const o of lines) {
    assert.equal(o.parentUuid, prev);
    assert.equal(o.sessionId, nativeSessionId);
    prev = o.uuid;
  }
  // reasoning must NOT appear anywhere (invariant 5)
  assert.ok(!readFileSync(file, "utf8").includes("SECRET THINKING"));
  // assistant line has a tool_use block; a later user line answers it
  const asst = lines.find((o) => o.type === "assistant");
  assert.ok(asst.message.content.some((b) => b.type === "tool_use" && b.id === "t1"));
  const res = lines.find((o) => o.type === "user" && Array.isArray(o.message.content) && o.message.content[0]?.type === "tool_result");
  assert.equal(res.message.content[0].tool_use_id, "t1");
});

test("Codex export: session_meta.id==sessionId, function_call arguments are JSON strings, pairing holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "csf-codex-"));
  const csf = makeCsf([
    { type: "message", role: "user", parts: [{ type: "text", text: "run it" }] },
    { type: "message", role: "assistant", model: "gpt-5.5", parts: [
      { type: "tool_call", id: "call_1", name: "exec", input: { cmd: "pwd" } },
    ] },
    // no tool_result → exporter must synthesize one
  ]);
  const { nativeSessionId, file, synthesized } = await exportSession("codex", csf, { root });
  assert.equal(synthesized, 1);

  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "session_meta");
  assert.equal(lines[0].payload.id, nativeSessionId);
  assert.ok(file.includes(nativeSessionId), "rollout filename embeds the id");

  const fc = lines.find((l) => l.payload?.type === "function_call");
  assert.equal(typeof fc.payload.arguments, "string");
  assert.deepEqual(JSON.parse(fc.payload.arguments), { cmd: "pwd" });
  assert.equal(fc.payload.call_id, "call_1");

  const out = lines.find((l) => l.payload?.type === "function_call_output");
  assert.equal(out.payload.call_id, "call_1"); // synthesized result is paired
});

// --- SHE-76: tool names with characters Codex/OpenAI reject -----------------------

test("sanitizeCodexToolName: maps out-of-pattern chars to _, caps 64, never empty", () => {
  assert.equal(sanitizeCodexToolName("Bash"), "Bash");                       // unchanged
  assert.equal(sanitizeCodexToolName("mcp__linear__get_issue"), "mcp__linear__get_issue"); // underscores ok
  assert.equal(sanitizeCodexToolName("web.run"), "web_run");                 // dot → _
  assert.equal(sanitizeCodexToolName("server:tool call"), "server_tool_call"); // colon + space → _
  assert.equal(sanitizeCodexToolName(""), "tool");                           // empty → fallback
  assert.equal(sanitizeCodexToolName(null), "tool");                         // null → fallback
  const long = sanitizeCodexToolName("x".repeat(200));
  assert.equal(long.length, 64);                                            // capped
  assert.match(sanitizeCodexToolName("a.b:c d/e"), /^[a-zA-Z0-9_-]+$/);      // always valid
});

test("SHE-76: Codex export sanitizes every function_call name to ^[a-zA-Z0-9_-]+$", async () => {
  const root = mkdtempSync(join(tmpdir(), "csf-she76-"));
  // A carried-over Claude session whose history holds tools with names Codex rejects.
  const csf = makeCsf([
    { type: "message", role: "user", parts: [{ type: "text", text: "do stuff" }] },
    { type: "message", role: "assistant", parts: [
      { type: "tool_call", id: "c1", name: "mcp__acme.server__do.thing", input: { a: 1 } },
    ] },
    { type: "tool_result", callId: "c1", output: "ok", isError: false },
    { type: "message", role: "assistant", parts: [
      { type: "tool_call", id: "c2", name: "weird tool:name", input: {} },
    ] },
    { type: "tool_result", callId: "c2", output: "ok", isError: false },
  ]);
  const { file } = await exportSession("codex", csf, { root });
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const calls = lines.filter((l) => l.payload?.type === "function_call");
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.payload.name, /^[a-zA-Z0-9_-]+$/, `name ${c.payload.name} must be Codex-valid`);
  }
  // call_id pairing is preserved (that's what Codex uses to match output).
  assert.deepEqual(calls.map((c) => c.payload.call_id).sort(), ["c1", "c2"]);
});

// AskUserQuestion — structured questions with pre-filled choices, headless.
//
// Claude Code only exposes AskUserQuestion in headless mode when a permission
// prompt handler is registered (`--permission-prompt-tool stdio`). The tool
// call then arrives as a `can_use_tool` control_request that BLOCKS the turn
// until we write a control_response: allow+updatedInput{questions, answers}
// delivers the user's choice, deny releases the CLI when the user typed a
// normal message instead. These tests pin the whole adapter protocol so the
// feature can't silently regress into the old behavior (tool absent, questions
// asked as plain text).
//
// Run: node --test computer/ai-chat/test/ask-user-questions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCliAgent } from "../lib/claude-cli-agent.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));

const QUESTIONS = [{
  question: "Blue or red?",
  header: "Color",
  options: [{ label: "Blue" }, { label: "Red" }],
  multiSelect: false,
}];

function makeAgent() {
  const agent = new ClaudeCliAgent({ sessionId: null, model: "claude-opus-5", cwd: tmpdir(), env: {} });
  agent._isActive = true;
  const writes = [];
  agent._process = {
    pid: 4242,
    stdin: { write: (line) => writes.push(JSON.parse(line)) },
    kill: (sig) => { agent._process._killed = sig; },
  };
  const asks = [];
  agent.on("ask_user", (e) => asks.push(e));
  const feed = (msg) => agent._processLine(JSON.stringify(msg));
  const cleanup = () => { agent._clearWatchdog(); agent._clearIdleTimer(); };
  return { agent, writes, asks, feed, cleanup };
}

function feedAsk(feed, requestId = "req-1") {
  feed({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      input: { questions: QUESTIONS },
      requires_user_interaction: true,
    },
  });
}

test("can_use_tool(AskUserQuestion) emits ask_user with the requestId and pauses the watchdog", () => {
  const { agent, asks, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feedAsk(feed);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].requestId, "req-1");
  assert.equal(asks[0].id, "toolu_1");
  assert.deepEqual(asks[0].questions, QUESTIONS);
  // The turn now waits on a human — a 5-minute silence is not a wedge.
  assert.equal(agent._watchdog, null, "watchdog must be disarmed while a question is pending");
  cleanup();
});

test("answerQuestion writes allow+updatedInput{questions, answers} and re-arms the watchdog", () => {
  const { agent, writes, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feedAsk(feed);
  const ok = agent.answerQuestion("req-1", { "Blue or red?": "Red" });
  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  const resp = writes[0];
  assert.equal(resp.type, "control_response");
  assert.equal(resp.response.request_id, "req-1");
  assert.equal(resp.response.subtype, "success");
  assert.equal(resp.response.response.behavior, "allow");
  assert.deepEqual(resp.response.response.updatedInput, {
    questions: QUESTIONS,
    answers: { "Blue or red?": "Red" },
  });
  assert.ok(agent._watchdog, "watchdog re-armed once the CLI is working again");
  // The request is consumed — a second answer must be refused.
  assert.equal(agent.answerQuestion("req-1", { "Blue or red?": "Blue" }), false);
  assert.equal(writes.length, 1);
  cleanup();
});

test("a stale requestId is refused without writing anything", () => {
  const { agent, writes, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feedAsk(feed, "req-current");
  assert.equal(agent.answerQuestion("req-old", { "Blue or red?": "Red" }), false);
  assert.equal(writes.length, 0);
  cleanup();
});

test("a normal user message while a question is pending denies the blocked tool call first", () => {
  const { agent, writes, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feedAsk(feed);
  agent.sendMessage("actually, do neither");
  assert.equal(writes.length, 2, "deny response + user message");
  assert.equal(writes[0].type, "control_response");
  assert.equal(writes[0].response.request_id, "req-1");
  assert.equal(writes[0].response.response.behavior, "deny");
  assert.ok(writes[0].response.response.message, "deny carries an explanation for the model");
  assert.equal(writes[1].type, "user", "the typed message follows the release");
  assert.equal(agent._pendingQuestion, null);
  cleanup();
});

test("other can_use_tool requests are auto-allowed (skip-permissions semantics preserved)", () => {
  const { agent, writes, asks, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feed({
    type: "control_request",
    request_id: "req-2",
    request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", tool_use_id: "toolu_2", input: { plan: "x" } },
  });
  assert.equal(asks.length, 0, "no ask_user for non-question tools");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].response.response.behavior, "allow");
  assert.deepEqual(writes[0].response.response.updatedInput, { plan: "x" });
  cleanup();
});

test("unknown control_request subtypes get an error response so the CLI never hangs", () => {
  const { writes, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feed({ type: "control_request", request_id: "req-3", request: { subtype: "mystery" } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].response.subtype, "error");
  cleanup();
});

test("interrupt clears the pending question", () => {
  const { agent, feed, cleanup } = makeAgent();
  feed({ type: "system", subtype: "init", session_id: "s1" });
  feedAsk(feed);
  agent.interrupt();
  assert.equal(agent._pendingQuestion, null);
  assert.equal(agent.answerQuestion("req-1", {}), false);
  cleanup();
});

// --- Source contracts (DOM-coupled / spawn-side surfaces, SHE-89/90/92 style) ---

const ADAPTER_SRC = readFileSync(join(DIR, "../lib/claude-cli-agent.mjs"), "utf8");
const CHAT_SRC = readFileSync(join(DIR, "../public/chat.js"), "utf8");
const SERVER_SRC = readFileSync(join(DIR, "../server.mjs"), "utf8");
const SM_SRC = readFileSync(join(DIR, "../lib/session-manager.mjs"), "utf8");

test("the cockpit spawn registers the stdio permission handler (what enables AskUserQuestion)", () => {
  assert.match(ADAPTER_SRC, /"--permission-prompt-tool", "stdio"/);
});

test("ask_user is emitted ONLY from the control_request (single source with a request_id)", () => {
  const emits = ADAPTER_SRC.match(/emit\("ask_user"/g) || [];
  assert.equal(emits.length, 1, "stream-path duplicates would double-render every question");
});

test("the frontend answers over the answer_question channel, with a plain-send fallback", () => {
  assert.match(CHAT_SRC, /type: 'answer_question'/);
  assert.match(SERVER_SRC, /case "answer_question":/);
  // A click on a question that is no longer pending must never be lost.
  assert.match(SERVER_SRC, /answerQuestion\(slot, msg\.requestId[\s\S]{0,400}?sendMessage\(slot, display\)/);
});

test("a pending question replays as a live block to reconnecting clients", () => {
  assert.match(SM_SRC, /pendingAskUser[\s\S]{0,200}?type: "ask_user"/);
});

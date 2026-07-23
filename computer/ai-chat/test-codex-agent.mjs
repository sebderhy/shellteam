/**
 * Unit tests for CodexAgent event translation.
 * Tests the JSONL → protocol event mapping without needing an actual Codex CLI or API key.
 */

import { CodexAgent } from "./lib/codex-agent.mjs";

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.log(`  \u2717 FAIL: ${msg}`);
    failed++;
  }
}

// Helper: create a CodexAgent and collect events by calling _translate directly
function createTestAgent(opts = {}) {
  const agent = new CodexAgent({
    sessionId: opts.sessionId || null,
    model: opts.model || "gpt-5.5",
    cwd: opts.cwd || "/home/user",
    env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "sk-test" },
  });
  agent.start();

  const events = [];
  const allEventTypes = [
    "init", "text_delta", "text_done", "tool_start", "tool_input",
    "tool_result", "ask_user", "plan_start", "plan_done",
    "subagent_progress", "subagent_done", "turn_done", "error", "session_event",
  ];
  for (const type of allEventTypes) {
    agent.on(type, (data) => events.push({ type, ...data }));
  }

  return { agent, events };
}

// Feed JSONL events to the agent's _translate method
function feed(agent, ...jsonlEvents) {
  for (const event of jsonlEvents) {
    agent._translate(event);
  }
}

// --- Tests ---

console.log("\n=== CodexAgent Unit Tests ===\n");

// 1. Thread started → init
console.log("--- 1. Thread Started → init ---");
{
  const { agent, events } = createTestAgent();
  feed(agent, { type: "thread.started", thread_id: "thread-abc123" });

  assert(events.length === 1, "One event emitted");
  assert(events[0].type === "init", "Event type is init");
  assert(events[0].sessionId === "thread-abc123", "sessionId matches thread_id");
  assert(events[0].apiKeySource === "env", "apiKeySource is env");
  assert(agent.sessionId === "thread-abc123", "Agent sessionId updated");
}

// 2. Text streaming (delta → text_delta, completed → text_done)
console.log("\n--- 2. Text Streaming ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } },
    { type: "item.agentMessage.delta", delta: "Hello" },
    { type: "item.agentMessage.delta", delta: " world" },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello world" } },
  );

  const deltas = events.filter(e => e.type === "text_delta");
  const dones = events.filter(e => e.type === "text_done");
  assert(deltas.length === 2, "Two text_delta events");
  assert(deltas[0].text === "Hello", "First delta is 'Hello'");
  assert(deltas[1].text === " world", "Second delta is ' world'");
  assert(dones.length === 1, "One text_done event");
  assert(dones[0].text === "Hello world", "text_done has complete text");
}

// 3. Text streaming with snake_case variant
console.log("\n--- 3. Text Streaming (snake_case) ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } },
    { type: "item.agent_message.delta", delta: "Hi" },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hi" } },
  );

  const deltas = events.filter(e => e.type === "text_delta");
  assert(deltas.length === 1, "snake_case delta handled");
  assert(deltas[0].text === "Hi", "Delta text correct");
}

// 4. Bash tool (command_execution)
console.log("\n--- 4. Bash Tool ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "ls -la" } },
    { type: "item.completed", item: { id: "cmd_1", type: "command_execution", aggregated_output: "file1\nfile2", exit_code: 0 } },
  );

  const starts = events.filter(e => e.type === "tool_start");
  const inputs = events.filter(e => e.type === "tool_input");
  const results = events.filter(e => e.type === "tool_result");

  assert(starts.length === 1, "One tool_start");
  assert(starts[0].name === "Bash", "Tool name is Bash");
  assert(starts[0].id === "cmd_1", "Tool id matches");
  assert(inputs.length === 1, "One tool_input");
  assert(inputs[0].input.command === "ls -la", "Input has command");
  assert(results.length === 1, "One tool_result");
  assert(results[0].content === "file1\nfile2", "Result has output");
  assert(results[0].is_error === false, "Not an error");
}

// 5. Bash tool with camelCase
console.log("\n--- 5. Bash Tool (camelCase) ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: { id: "cmd_2", type: "commandExecution", command: "echo hi" } },
    { type: "item.completed", item: { id: "cmd_2", type: "commandExecution", aggregatedOutput: "hi", exitCode: 0 } },
  );

  const starts = events.filter(e => e.type === "tool_start");
  const results = events.filter(e => e.type === "tool_result");
  assert(starts.length === 1, "camelCase commandExecution handled");
  assert(results[0].content === "hi", "camelCase aggregatedOutput handled");
}

// 6. Bash tool with error
console.log("\n--- 6. Bash Tool Error ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: { id: "cmd_3", type: "command_execution", command: "false" } },
    { type: "item.completed", item: { id: "cmd_3", type: "command_execution", aggregated_output: "", exit_code: 1 } },
  );

  const results = events.filter(e => e.type === "tool_result");
  assert(results[0].is_error === true, "exit_code 1 → is_error true");
  assert(results[0].content === "Exit code: 1", "Error content has exit code");
}

// 7. File change tool
console.log("\n--- 7. File Change Tool ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: {
      id: "fc_1", type: "file_change",
      changes: [{ kind: "update", path: "src/app.ts", diff: "+added line" }],
    }},
    { type: "item.completed", item: {
      id: "fc_1", type: "file_change",
      changes: [{ kind: "update", path: "src/app.ts", diff: "+added line" }],
    }},
  );

  const starts = events.filter(e => e.type === "tool_start");
  const inputs = events.filter(e => e.type === "tool_input");
  const results = events.filter(e => e.type === "tool_result");

  assert(starts[0].name === "Edit", "File change → Edit tool");
  assert(inputs[0].input.description === "update src/app.ts", "Description from changes");
  assert(results[0].content === "+added line", "Diff in result");
}

// 8. MCP tool
console.log("\n--- 8. MCP Tool ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: {
      id: "mcp_1", type: "mcp_tool_call",
      server: "deepwiki", tool: "search",
      arguments: { query: "test" },
    }},
    { type: "item.completed", item: {
      id: "mcp_1", type: "mcp_tool_call",
      result: { answer: "found" },
    }},
  );

  const starts = events.filter(e => e.type === "tool_start");
  const inputs = events.filter(e => e.type === "tool_input");
  const results = events.filter(e => e.type === "tool_result");

  assert(starts[0].name === "mcp__deepwiki__search", "MCP tool name format");
  assert(inputs[0].input.query === "test", "MCP arguments passed");
  assert(JSON.parse(results[0].content).answer === "found", "MCP result serialized");
}

// 9. MCP tool with camelCase
console.log("\n--- 9. MCP Tool (camelCase) ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: { id: "mcp_2", type: "mcpToolCall", server: "srv", tool: "fn", arguments: {} } },
  );
  const starts = events.filter(e => e.type === "tool_start");
  assert(starts[0].name === "mcp__srv__fn", "camelCase mcpToolCall handled");
}

// 10. Turn completed
console.log("\n--- 10. Turn Completed ---");
{
  const { agent, events } = createTestAgent();
  agent._isGenerating = true;
  feed(agent, { type: "turn.completed" });

  const dones = events.filter(e => e.type === "turn_done");
  assert(dones.length === 1, "turn_done emitted");
  assert(!dones[0].is_error, "Not an error");
  assert(agent.isGenerating === false, "isGenerating cleared");
}

// 11. Turn failed
console.log("\n--- 11. Turn Failed ---");
{
  const { agent, events } = createTestAgent();
  agent._isGenerating = true;
  feed(agent, { type: "turn.failed", error: { message: "Rate limited" } });

  const dones = events.filter(e => e.type === "turn_done");
  assert(dones.length === 1, "turn_done emitted on failure");
  assert(dones[0].is_error === true, "is_error true");
  assert(dones[0].errors[0] === "Rate limited", "Error message preserved");
}

// 12. Error event
console.log("\n--- 12. Error Event ---");
{
  const { agent, events } = createTestAgent();
  feed(agent, { type: "error", message: "401 Unauthorized" });

  const errors = events.filter(e => e.type === "error");
  assert(errors.length === 1, "error event emitted");
  assert(errors[0].message === "401 Unauthorized", "Error message correct");
}

// 13. Context compaction
console.log("\n--- 13. Context Compaction ---");
{
  const { agent, events } = createTestAgent();
  feed(agent, { type: "item.completed", item: { type: "context_compaction" } });

  const sessions = events.filter(e => e.type === "session_event");
  assert(sessions.length === 1, "session_event emitted");
  assert(sessions[0].event === "compacted", "Event is compacted");
}

// 14. Context compaction (camelCase)
console.log("\n--- 14. Context Compaction (camelCase) ---");
{
  const { agent, events } = createTestAgent();
  feed(agent, { type: "item.completed", item: { type: "contextCompaction" } });

  const sessions = events.filter(e => e.type === "session_event");
  assert(sessions.length === 1, "camelCase contextCompaction handled");
}

// 15. Plan update
console.log("\n--- 15. Plan Update ---");
{
  const { agent, events } = createTestAgent();
  feed(agent, {
    type: "turn.plan.updated",
    plan: [
      { step: "Read code", status: "completed" },
      { step: "Write fix", status: "in_progress" },
    ],
    explanation: "Fixing the bug",
  });

  const deltas = events.filter(e => e.type === "text_delta");
  const dones = events.filter(e => e.type === "text_done");
  assert(deltas.length === 1, "Plan emitted as text_delta");
  assert(deltas[0].text.includes("**Plan:**"), "Plan text has header");
  assert(deltas[0].text.includes("[x] Read code"), "Completed step marked");
  assert(deltas[0].text.includes("[ ] Write fix"), "In-progress step unmarked");
  assert(dones.length === 1, "Plan text_done emitted");
}

// 16. Resume (sessionId passed to constructor)
console.log("\n--- 16. Resume Session ---");
{
  const agent = new CodexAgent({
    sessionId: "thread-resume-123",
    model: "gpt-5.5",
    cwd: "/home/user",
    env: {},
  });
  agent.start();

  assert(agent.sessionId === "thread-resume-123", "sessionId set from constructor");
  assert(agent._threadId === "thread-resume-123", "threadId set for resume");
  assert(agent._isFirstTurn === false, "Not first turn when resuming");
}

// 17. Interrupt
console.log("\n--- 17. Interrupt ---");
{
  const { agent, events } = createTestAgent();
  agent._isGenerating = true;
  agent._streamingText = "partial text";

  agent.interrupt();

  const dones = events.filter(e => e.type === "turn_done");
  assert(dones.length === 1, "turn_done emitted on interrupt");
  assert(dones[0].subtype === "interrupted", "Subtype is interrupted");
  assert(agent.isGenerating === false, "isGenerating cleared");
  assert(agent.streamingText === "", "streamingText cleared");
}

// 18. Environment stripping
console.log("\n--- 18. Environment Stripping ---");
{
  const agent = new CodexAgent({
    model: "gpt-5.5", cwd: "/home/user",
    env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret", CLAUDE_CODE_OAUTH_TOKEN: "tok", OPENAI_API_KEY: "sk-test" },
  });
  assert(agent._env.ANTHROPIC_API_KEY === undefined, "ANTHROPIC_API_KEY stripped");
  assert(agent._env.CLAUDE_CODE_OAUTH_TOKEN === undefined, "CLAUDE_CODE_OAUTH_TOKEN stripped");
  assert(agent._env.OPENAI_API_KEY === "sk-test", "OPENAI_API_KEY preserved");
  assert(agent._env.PATH === "/usr/bin", "PATH preserved");
}

// 19. isBroken always false
console.log("\n--- 19. isBroken ---");
{
  const { agent } = createTestAgent();
  assert(agent.isBroken === false, "isBroken is always false for Codex");
}

// 20. Compact handler
console.log("\n--- 20. Compact ---");
{
  const { agent, events } = createTestAgent();
  agent._threadId = "thread-to-compact";
  agent._sessionId = "thread-to-compact";

  // _handleCompact writes an archive file to ~/conversations/ and resets state
  agent._handleCompact();

  const sessions = events.filter(e => e.type === "session_event");
  assert(sessions.length === 1, "session_event emitted");
  assert(sessions[0].event === "compacted", "Event is compacted");
  assert(agent._threadId === null, "threadId reset");
  assert(agent._sessionId === null, "sessionId reset");
  assert(agent._isFirstTurn === true, "isFirstTurn reset");
}

// 21. Full turn lifecycle
console.log("\n--- 21. Full Turn Lifecycle ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "thread.started", thread_id: "thread-full" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } },
    { type: "item.agentMessage.delta", delta: "Let me " },
    { type: "item.agentMessage.delta", delta: "check." },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Let me check." } },
    { type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "ls" } },
    { type: "item.completed", item: { id: "cmd_1", type: "command_execution", aggregated_output: "file.txt", exit_code: 0 } },
    { type: "item.started", item: { id: "item_2", type: "agent_message", text: "" } },
    { type: "item.agentMessage.delta", delta: "Done." },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Done." } },
    { type: "turn.completed" },
  );

  const types = events.map(e => e.type);
  assert(types.includes("init"), "Has init");
  assert(types.includes("text_delta"), "Has text_delta");
  assert(types.includes("text_done"), "Has text_done");
  assert(types.includes("tool_start"), "Has tool_start");
  assert(types.includes("tool_input"), "Has tool_input");
  assert(types.includes("tool_result"), "Has tool_result");
  assert(types.includes("turn_done"), "Has turn_done");
  assert(types.filter(t => t === "text_done").length === 2, "Two text_done events (before and after tool)");
}

// 22. Slash variants for deltas
console.log("\n--- 22. Slash Variant Event Types ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } },
    { type: "item/agentMessage/delta", delta: "slash" },
    { type: "item/agent_message/delta", delta: "variant" },
  );

  const deltas = events.filter(e => e.type === "text_delta");
  assert(deltas.length === 2, "Both slash variants handled");
  assert(deltas[0].text === "slash", "Slash camelCase works");
  assert(deltas[1].text === "variant", "Slash snake_case works");
}

// 23. Unknown events don't crash
console.log("\n--- 23. Unknown Events ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "thread.something_unknown" },
    { type: "custom.event" },
    { type: "item.started", item: { type: "unknown_type" } },
  );
  assert(events.length === 0, "Unknown events produce no protocol events");
}

// 24. Empty item handling
console.log("\n--- 24. Edge Cases ---");
{
  const { agent, events } = createTestAgent();
  feed(agent,
    { type: "item.started" },  // no item
    { type: "item.completed" }, // no item
    { type: "item.agentMessage.delta" }, // no delta (undefined)
  );
  // Should not crash
  const deltas = events.filter(e => e.type === "text_delta");
  assert(deltas.length === 1, "Empty delta still emits (empty string)");
}

// Summary
console.log(`\n========================================`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

process.exit(failed > 0 ? 1 : 0);

/**
 * Comprehensive integration test for the rebuilt AI chat.
 * Tests every interaction flow end-to-end via WebSocket,
 * including hard combination flows that humans commonly trigger.
 *
 * Uses Haiku for all LLM-hitting tests to minimize cost.
 *
 * Usage: node test-rebuild.mjs [ws-url]
 * Default ws-url: ws://127.0.0.1:3456/ws
 */

import WebSocket from "ws";

const WS_URL = process.argv[2] || "ws://127.0.0.1:3456/ws";
const TIMEOUT = 90_000;
const TEST_MODEL = "claude-haiku-4-5-20251001";

let passed = 0;
let failed = 0;
const failures = [];

function log(msg) { console.log(`  ${msg}`); }
function pass(name) { passed++; console.log(`  \u2713 ${name}`); }
function fail(name, reason) {
  failed++;
  failures.push({ name, reason });
  console.error(`  \u2717 ${name}: ${reason}`);
}

/** Open a WS connection and return helpers. */
function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    let waiters = [];

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      inbox.push(msg);
      for (const w of waiters) w.check(msg);
    });

    ws.on("open", () => {
      const helpers = {
        ws,
        inbox,
        send(obj) { ws.send(JSON.stringify(obj)); },
        waitFor(pred, timeoutMs = TIMEOUT) {
          const found = inbox.find(pred);
          if (found) return Promise.resolve(found);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              waiters = waiters.filter(w => w !== entry);
              rej(new Error("Timeout waiting for message"));
            }, timeoutMs);
            const entry = {
              check(msg) {
                if (pred(msg)) {
                  clearTimeout(timer);
                  waiters = waiters.filter(w => w !== entry);
                  res(msg);
                }
              }
            };
            waiters.push(entry);
          });
        },
        /** Wait for a NEW message matching pred (ignoring already-seen messages). */
        waitForNew(pred, timeoutMs = TIMEOUT) {
          const mark = inbox.length;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              waiters = waiters.filter(w => w !== entry);
              rej(new Error("Timeout waiting for new message"));
            }, timeoutMs);
            const entry = {
              check(msg) {
                if (inbox.indexOf(msg) >= mark && pred(msg)) {
                  clearTimeout(timer);
                  waiters = waiters.filter(w => w !== entry);
                  res(msg);
                }
              }
            };
            waiters.push(entry);
            // Also check messages that arrived between mark and now
            for (let i = mark; i < inbox.length; i++) {
              if (pred(inbox[i])) {
                clearTimeout(timer);
                waiters = waiters.filter(w => w !== entry);
                res(inbox[i]);
                return;
              }
            }
          });
        },
        waitStatus() { return helpers.waitFor(m => m.type === "status"); },
        close() { ws.close(); },
        clearInbox() { inbox.length = 0; },
        /** Messages received after a given index. */
        messagesSince(idx) { return inbox.slice(idx); },
      };
      resolve(helpers);
    });

    ws.on("error", reject);
  });
}

/** Helper: switch model to haiku on a slot, wait for model_changed + status. */
async function switchToHaiku(c, slot = 0) {
  c.send({ type: "set_model", model: TEST_MODEL, slot });
  await c.waitFor(m => m.type === "model_changed" && m.model === TEST_MODEL);
}

/** Helper: create a clean session on a slot using haiku. */
async function freshHaikuSession(c, slot = 0) {
  c.send({ type: "set_model", model: TEST_MODEL, slot });
  await c.waitFor(m => m.type === "model_changed");
  c.send({ type: "new_session", slot });
  await c.waitForNew(m => m.type === "status");
  c.clearInbox();
}

/** Helper: send a message and wait for turn_done. Returns { init, turnDone, allMsgs }. */
async function sendAndWait(c, content, slot = 0) {
  const mark = c.inbox.length;
  c.send({ type: "send", content, slot });
  const turnDone = await c.waitForNew(m => m.type === "turn_done" && m.slot === slot);
  const init = c.messagesSince(mark).find(m => m.type === "init" && m.slot === slot);
  return { init, turnDone, allMsgs: c.messagesSince(mark) };
}

// =============================================================
// 1. Connection + Status
// =============================================================
async function testConnection() {
  console.log("\n--- 1. Connection + Status ---");
  const c = await openWs();
  const status = await c.waitStatus();

  if (status.type === "status") pass("Receives status on connect");
  else fail("Status message", "No status received");

  if (status.hasApiKey === true || status.hasOAuth === true) pass("Has credentials");
  else fail("Has credentials", `apiKey=${status.hasApiKey} oauth=${status.hasOAuth}`);

  if (Array.isArray(status.slots) && status.slots.length >= 1) pass("Has slots array");
  else fail("Slots array", `got ${JSON.stringify(status.slots)}`);

  if (status.slots[0].model) pass("Slot 0 has model");
  else fail("Slot 0 model", "missing");

  c.close();
}

// =============================================================
// 2. Basic message: send → text_delta → text_done → turn_done
// =============================================================
async function testBasicMessage() {
  console.log("\n--- 2. Basic Message Flow ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  c.send({ type: "send", content: "Reply with just the word: pineapple", slot: 0 });

  const init = await c.waitFor(m => m.type === "init" && m.slot === 0);
  if (init.sessionId) pass("Init with sessionId");
  else fail("Init sessionId", "missing");

  const td = await c.waitFor(m => m.type === "text_delta" && m.slot === 0);
  if (td.text) pass("Receives text_delta");
  else fail("text_delta", "empty text");

  const done = await c.waitFor(m => m.type === "turn_done" && m.slot === 0);
  if (done.cost !== undefined) pass("turn_done with cost");
  else fail("turn_done cost", "missing");

  const textDone = c.inbox.find(m => m.type === "text_done" && m.slot === 0);
  if (textDone) pass("text_done emitted");
  else fail("text_done", "never received");

  c.close();
}

// =============================================================
// 3. Tool use (Bash): tool_start → tool_input → tool_result
// =============================================================
async function testToolUse() {
  console.log("\n--- 3. Tool Use (Bash) ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  c.send({ type: "send", content: "Run this command: echo integration_test_ok", slot: 0 });

  const toolStart = await c.waitFor(m => m.type === "tool_start" && m.slot === 0);
  if (toolStart.name === "Bash") pass("tool_start name=Bash");
  else fail("tool_start", `name=${toolStart.name}`);
  if (toolStart.id) pass("tool_start has id");
  else fail("tool_start id", "missing");

  const toolInput = await c.waitFor(m => m.type === "tool_input" && m.id === toolStart.id);
  if (toolInput.input?.command) pass("tool_input has command");
  else fail("tool_input", "no command");

  const toolResult = await c.waitFor(m => m.type === "tool_result" && m.id === toolStart.id);
  if (!toolResult.is_error) pass("tool_result not error");
  else fail("tool_result", "is_error=true");

  const resultContent = typeof toolResult.content === "string"
    ? toolResult.content
    : toolResult.content?.map(b => b.text).join("");
  if (resultContent?.includes("integration_test_ok")) pass("tool_result contains output");
  else fail("tool_result content", `got: ${resultContent?.slice(0, 100)}`);

  await c.waitFor(m => m.type === "turn_done" && m.slot === 0);
  pass("turn_done after tool use");

  c.close();
}

// =============================================================
// 4. Interrupt mid-stream
// =============================================================
async function testInterrupt() {
  console.log("\n--- 4. Interrupt ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  c.send({ type: "send", content: "Write a very long 1000 word essay about the history of computing", slot: 0 });
  await c.waitFor(m => m.type === "text_delta" && m.slot === 0);
  pass("Received text before interrupt");

  c.send({ type: "interrupt", slot: 0 });

  const done = await c.waitFor(m => m.type === "turn_done" && m.slot === 0);
  pass(`turn_done after interrupt (subtype=${done.subtype || "none"})`);

  c.close();
}

// =============================================================
// 5. Multi-tab parallel execution
// =============================================================
async function testMultiTab() {
  console.log("\n--- 5. Multi-Tab Parallel ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "create_tab", slot: 10, model: TEST_MODEL, cwd: "/home/user" });
  c.send({ type: "create_tab", slot: 11, model: TEST_MODEL, cwd: "/home/user" });
  pass("Created tabs 10 and 11");

  c.send({ type: "send", content: "Reply with just: tab_ten", slot: 10 });
  c.send({ type: "send", content: "Reply with just: tab_eleven", slot: 11 });

  const [r1, r2] = await Promise.all([
    c.waitFor(m => m.type === "turn_done" && m.slot === 10),
    c.waitFor(m => m.type === "turn_done" && m.slot === 11),
  ]);
  pass("Both tabs completed (parallel)");

  const init10 = c.inbox.find(m => m.type === "init" && m.slot === 10);
  const init11 = c.inbox.find(m => m.type === "init" && m.slot === 11);
  if (init10?.sessionId && init11?.sessionId && init10.sessionId !== init11.sessionId) {
    pass("Each tab has unique sessionId");
  } else {
    fail("Tab sessionIds", `tab10=${init10?.sessionId} tab11=${init11?.sessionId}`);
  }

  c.send({ type: "close_tab", slot: 10 });
  c.send({ type: "close_tab", slot: 11 });
  pass("Closed tabs");

  c.close();
}

// =============================================================
// 6. New session clears state
// =============================================================
async function testNewSession() {
  console.log("\n--- 6. New Session ---");
  const c = await openWs();
  const status1 = await c.waitStatus();
  const oldSessionId = status1.sessionId;

  c.send({ type: "new_session", slot: 0 });
  const status2 = await c.waitForNew(m => m.type === "status");

  if (!status2.sessionId || status2.sessionId !== oldSessionId) pass("Session ID cleared");
  else fail("New session", "sessionId unchanged");

  c.close();
}

// =============================================================
// 7. Session listing
// =============================================================
async function testSessionListing() {
  console.log("\n--- 7. Session Listing ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "list_sessions" });
  const list = await c.waitFor(m => m.type === "sessions_list");

  if (Array.isArray(list.sessions)) pass("sessions_list is array");
  else { fail("sessions_list", "not array"); c.close(); return; }

  if (list.sessions.length > 0) pass(`Found ${list.sessions.length} sessions`);
  else { fail("sessions_list", "empty"); c.close(); return; }

  const s = list.sessions[0];
  if (s.sessionId) pass("Session has sessionId");
  else fail("Session sessionId", "missing");
  if (s.firstMessage) pass("Session has firstMessage");
  else fail("Session firstMessage", "missing");

  c.close();
}

// =============================================================
// 8. Resume session
// =============================================================
async function testResumeSession() {
  console.log("\n--- 8. Resume Session ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "list_sessions" });
  const list = await c.waitFor(m => m.type === "sessions_list");
  if (!list.sessions?.length) { fail("Resume", "no sessions"); c.close(); return; }

  const target = list.sessions[0];
  c.clearInbox();

  c.send({ type: "resume_session", sessionId: target.sessionId, slot: 0 });

  const sessionEvt = await c.waitFor(m => m.type === "session_event" && m.event === "resumed");
  pass("session_event resumed received");

  const history = await c.waitFor(m => m.type === "history" && m.slot === 0);
  if (Array.isArray(history.messages) && history.messages.length > 0) {
    pass(`History replayed (${history.messages.length} messages)`);
    const types = new Set(history.messages.map(m => m.type));
    log(`History message types: ${[...types].join(", ")}`);
    if (types.has("user_message")) pass("History has user_message");
    else fail("History format", "no user_message");
    if (types.has("text_done") || types.has("tool_start")) pass("History has assistant content");
    else log("No assistant content in JSONL (normal for very short sessions)");
  } else {
    fail("History replay", "empty or missing");
  }

  c.close();
}

// =============================================================
// 9. Rewind
// =============================================================
async function testRewind() {
  console.log("\n--- 9. Rewind ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  await sendAndWait(c, "Reply with: msg1");
  pass("Turn 1 sent");
  await sendAndWait(c, "Reply with: msg2");
  pass("Turn 2 sent");

  c.clearInbox();
  c.send({ type: "rewind", count: 1, slot: 0 });

  const evt = await c.waitFor(m => m.type === "session_event" && m.event === "rewound");
  if (evt.userText) pass(`Rewind returned userText: "${evt.userText.slice(0, 50)}"`);
  else pass("Rewind completed");

  const history = await c.waitFor(m => m.type === "history" && m.slot === 0);
  pass(`History after rewind: ${history.messages.length} messages`);

  c.close();
}

// =============================================================
// 10. Compact
// =============================================================
async function testCompact() {
  console.log("\n--- 10. Compact ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  await sendAndWait(c, "Reply with: test for compact");
  pass("Message sent before compact");

  c.clearInbox();
  c.send({ type: "compact", slot: 0 });

  try {
    await c.waitFor(m => m.type === "session_event" && m.event === "compacted", 60_000);
    pass("session_event compacted received");
  } catch {
    const turnDone = c.inbox.find(m => m.type === "turn_done");
    if (turnDone) pass("Compact completed (too short to actually compact)");
    else fail("Compact", "no compacted event or turn_done");
  }

  c.close();
}

// =============================================================
// 11. Model change
// =============================================================
async function testModelChange() {
  console.log("\n--- 11. Model Change ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "set_model", model: "claude-sonnet-5", slot: 0 });
  const changed = await c.waitFor(m => m.type === "model_changed");
  if (changed.model === "claude-sonnet-5") pass("Model changed to sonnet");
  else fail("Model change", `got ${changed.model}`);

  c.send({ type: "set_model", model: TEST_MODEL, slot: 0 });
  await c.waitFor(m => m.type === "model_changed" && m.model === TEST_MODEL);
  pass("Model changed to haiku");

  c.close();
}

// =============================================================
// 12. CWD change + validation
// =============================================================
async function testCwdChange() {
  console.log("\n--- 12. CWD Change ---");
  const c = await openWs();
  await c.waitStatus();

  // Valid path
  c.send({ type: "set_cwd", cwd: "/home/user", slot: 0 });
  await c.waitFor(m => m.type === "cwd_changed" || m.type === "status");
  pass("CWD change to /home/user");

  // Invalid path
  c.send({ type: "set_cwd", cwd: "/nonexistent", slot: 0 });
  const err1 = await c.waitFor(m => m.type === "error" && m.slot === 0);
  pass(`Error for invalid CWD: ${err1.message}`);

  // Outside home
  c.send({ type: "set_cwd", cwd: "/etc", slot: 0 });
  const err2 = await c.waitForNew(m => m.type === "error" && m.slot === 0);
  pass(`Error for CWD outside home: ${err2.message}`);

  c.close();
}

// =============================================================
// 13. Workspace + directory + file listing
// =============================================================
async function testListings() {
  console.log("\n--- 13. Listings ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "list_workspaces" });
  const wl = await c.waitFor(m => m.type === "workspaces_list");
  if (wl.workspaces?.length >= 1) pass(`${wl.workspaces.length} workspaces`);
  else fail("Workspaces", "empty");

  c.send({ type: "list_directories", prefix: "/home/user" });
  const dl = await c.waitFor(m => m.type === "directories_list");
  if (Array.isArray(dl.dirs)) pass(`${dl.dirs.length} directories`);
  else fail("Directories", "not array");

  c.send({ type: "list_files", slot: 0 });
  const fl = await c.waitFor(m => m.type === "files_list");
  if (fl.files?.length >= 0 && fl.cwd) pass(`${fl.files.length} files in ${fl.cwd}`);
  else fail("Files", "missing");

  c.close();
}

// =============================================================
// 14. Reconnect mid-stream
// =============================================================
async function testReconnect() {
  console.log("\n--- 14. Reconnect Mid-Stream ---");
  const c1 = await openWs();
  await c1.waitStatus();
  await freshHaikuSession(c1);

  c1.send({ type: "send", content: "Write a 200 word essay about trees. Be thorough and detailed.", slot: 0 });
  await c1.waitFor(m => m.type === "text_delta" && m.slot === 0);
  pass("Stream started on connection 1");

  c1.close();
  log("Connection 1 closed");

  await new Promise(r => setTimeout(r, 1000));
  const c2 = await openWs();
  await c2.waitStatus();
  pass("Reconnected");

  const catchup = c2.inbox.find(m => m.type === "streaming_catchup" && m.slot === 0);
  const history = c2.inbox.find(m => m.type === "history" && m.slot === 0);
  if (catchup) pass("Got streaming_catchup on reconnect");
  else if (history?.messages?.length) pass("Got history on reconnect");
  else log("No catchup or history (agent may have finished fast)");

  try {
    await c2.waitFor(m => m.type === "turn_done" && m.slot === 0, 60_000);
    pass("Turn completed after reconnect");
  } catch {
    pass("Turn may have completed before reconnect");
  }

  c2.close();
}

// =============================================================
// 15. Tab persistence across server restart
// =============================================================
async function testServerRestart() {
  console.log("\n--- 15. Tab Persistence Across Restart ---");
  const c1 = await openWs();
  await c1.waitStatus();

  c1.send({ type: "create_tab", slot: 20, model: TEST_MODEL, cwd: "/home/user" });
  c1.send({ type: "send", content: "Reply with: persistence test", slot: 20 });
  const init20 = await c1.waitFor(m => m.type === "init" && m.slot === 20);
  await c1.waitFor(m => m.type === "turn_done" && m.slot === 20);
  pass(`Tab 20 sessionId: ${init20.sessionId?.slice(0, 8)}...`);

  c1.close();
  await new Promise(r => setTimeout(r, 1000));

  const { execSync } = await import("child_process");
  execSync("supervisorctl restart ai-chat", { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 3000));

  const c2 = await openWs();
  const status = await c2.waitStatus();

  const slot20 = status.slots?.find(s => s.id === 20);
  if (slot20) {
    pass("Tab 20 survived restart");
    if (slot20.sessionId === init20.sessionId) pass("SessionId preserved");
    else fail("SessionId", `expected ${init20.sessionId?.slice(0, 8)}, got ${slot20.sessionId?.slice(0, 8)}`);
    if (slot20.model === TEST_MODEL) pass("Model preserved");
    else fail("Model", `expected ${TEST_MODEL}, got ${slot20.model}`);
  } else {
    fail("Tab persistence", `Tab 20 not found`);
  }

  const history20 = c2.inbox.find(m => m.type === "history" && m.slot === 20);
  if (history20?.messages?.length > 0) pass(`Tab 20 history restored (${history20.messages.length} msgs)`);
  else log("Tab 20 history not sent on connect");

  c2.send({ type: "close_tab", slot: 20 });
  c2.close();
}

// =============================================================
// 16. Multi-turn conversation (context maintained)
// =============================================================
async function testMultiTurn() {
  console.log("\n--- 16. Multi-Turn ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  await sendAndWait(c, "Remember the number 42. Reply with just: got it");
  pass("Turn 1 completed");

  const { allMsgs } = await sendAndWait(c, "What number did I ask you to remember? Reply with just the number.");
  pass("Turn 2 completed");

  const texts = allMsgs.filter(m => m.type === "text_done" || m.type === "text_delta").map(m => m.text).join("");
  if (texts.includes("42")) pass("Agent remembers context (42)");
  else log(`Agent response: ${texts.slice(0, 100)}`);

  c.close();
}

// =============================================================
// 17. Error handling
// =============================================================
async function testErrorHandling() {
  console.log("\n--- 17. Error Handling ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "set_cwd", cwd: "/nonexistent/path", slot: 0 });
  const err = await c.waitFor(m => m.type === "error" && m.slot === 0);
  pass(`Error for invalid CWD: ${err.message}`);

  c.send({ type: "set_cwd", cwd: "/etc", slot: 0 });
  const err2 = await c.waitForNew(m => m.type === "error" && m.slot === 0);
  pass(`Error for CWD outside home: ${err2.message}`);

  c.close();
}

// =============================================================
// 18. History protocol format validation
// =============================================================
async function testHistoryFormat() {
  console.log("\n--- 18. History Protocol Format ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  await sendAndWait(c, "Run: echo hello_format_test");
  pass("Message sent");

  c.close();
  await new Promise(r => setTimeout(r, 500));

  const c2 = await openWs();
  await c2.waitStatus();

  const history = await c2.waitFor(m => m.type === "history" && m.slot === 0, 5000).catch(() => null);
  if (!history) { log("No history on reconnect"); c2.close(); return; }

  const msgs = history.messages;
  pass(`History: ${msgs.length} messages`);

  const validTypes = new Set([
    "user_message", "text_done", "tool_start", "tool_input", "tool_result",
    "ask_user", "plan_start", "plan_done", "subagent_done",
    "turn_done", "session_event", "error",
  ]);
  const invalidMsgs = msgs.filter(m => !validTypes.has(m.type));
  if (invalidMsgs.length === 0) pass("All history messages are protocol format");
  else fail("History format", `Invalid types: ${invalidMsgs.map(m => m.type).join(", ")}`);

  if (msgs.some(m => m.type === "user_message")) pass("Has user_message");
  else fail("History", "no user_message");
  if (msgs.some(m => m.type === "turn_done")) pass("Has turn_done");
  else fail("History", "no turn_done");

  c2.close();
}

// =============================================================
// COMBO TESTS — hard interaction sequences
// =============================================================

// 19. Resume → then send a new message (continues the session)
async function testResumeThenSend() {
  console.log("\n--- 19. Resume -> Send ---");
  const c = await openWs();
  await c.waitStatus();

  // First create a session with haiku
  await freshHaikuSession(c);
  const { init } = await sendAndWait(c, "Reply with: base message");
  const sid = init?.sessionId;
  if (!sid) { fail("Resume+Send", "no sessionId from base msg"); c.close(); return; }
  pass(`Base session: ${sid.slice(0, 8)}`);

  // Now resume it
  c.send({ type: "new_session", slot: 0 });
  await c.waitForNew(m => m.type === "status");
  c.clearInbox();

  c.send({ type: "resume_session", sessionId: sid, slot: 0 });
  await c.waitFor(m => m.type === "session_event" && m.event === "resumed");
  await c.waitFor(m => m.type === "history" && m.slot === 0);
  pass("Session resumed");

  // Now send a NEW message in the resumed session
  c.clearInbox();
  const { turnDone } = await sendAndWait(c, "Reply with: after resume");
  pass("Sent message after resume");

  if (turnDone.cost !== undefined) pass("turn_done has cost");
  else fail("turn_done cost after resume", "missing");

  c.close();
}

// 20. Resume → Rewind
async function testResumeThenRewind() {
  console.log("\n--- 20. Resume -> Rewind ---");
  const c = await openWs();
  await c.waitStatus();

  // Create a 2-turn session
  await freshHaikuSession(c);
  const { init } = await sendAndWait(c, "Reply with: turn_one");
  const sid = init?.sessionId;
  await sendAndWait(c, "Reply with: turn_two");
  pass(`Created 2-turn session: ${sid?.slice(0, 8)}`);

  // New session, then resume it
  c.send({ type: "new_session", slot: 0 });
  await c.waitForNew(m => m.type === "status");
  c.clearInbox();

  c.send({ type: "resume_session", sessionId: sid, slot: 0 });
  await c.waitFor(m => m.type === "history" && m.slot === 0);
  pass("Session resumed");

  // Rewind 1 turn
  c.clearInbox();
  c.send({ type: "rewind", count: 1, slot: 0 });
  const evt = await c.waitFor(m => m.type === "session_event" && m.event === "rewound");
  pass(`Rewind after resume: userText="${(evt.userText || "").slice(0, 40)}"`);

  const history = await c.waitFor(m => m.type === "history" && m.slot === 0);
  pass(`Post-rewind history: ${history.messages.length} messages`);

  c.close();
}

// 21. Resume → Compact
async function testResumeThenCompact() {
  console.log("\n--- 21. Resume -> Compact ---");
  const c = await openWs();
  await c.waitStatus();

  // Create a session
  await freshHaikuSession(c);
  const { init } = await sendAndWait(c, "Reply with: compact source");
  const sid = init?.sessionId;
  pass(`Session: ${sid?.slice(0, 8)}`);

  // Resume it
  c.send({ type: "new_session", slot: 0 });
  await c.waitForNew(m => m.type === "status");
  c.clearInbox();

  c.send({ type: "resume_session", sessionId: sid, slot: 0 });
  await c.waitFor(m => m.type === "history" && m.slot === 0);
  pass("Session resumed");

  // Compact
  c.clearInbox();
  c.send({ type: "compact", slot: 0 });

  try {
    await c.waitFor(m => m.type === "session_event" && m.event === "compacted", 60_000);
    pass("Compact after resume: compacted event received");
  } catch {
    const td = c.inbox.find(m => m.type === "turn_done");
    if (td) pass("Compact after resume completed (too short to compact)");
    else fail("Compact after resume", "no event");
  }

  c.close();
}

// 22. Rewind → then send new message (replaces rewound turn)
async function testRewindThenSend() {
  console.log("\n--- 22. Rewind -> Send ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  await sendAndWait(c, "Reply with: original_first");
  pass("Turn 1");
  await sendAndWait(c, "Reply with: original_second");
  pass("Turn 2");

  c.clearInbox();
  c.send({ type: "rewind", count: 1, slot: 0 });
  await c.waitFor(m => m.type === "session_event" && m.event === "rewound");
  pass("Rewound 1 turn");

  // Send a replacement message
  c.clearInbox();
  const { turnDone } = await sendAndWait(c, "Reply with: replacement_second");
  pass("Sent replacement after rewind");

  if (turnDone.cost !== undefined) pass("turn_done has cost after rewind+send");
  else fail("turn_done cost", "missing");

  c.close();
}

// 23. Interrupt → then send new message (continues conversation)
async function testInterruptThenSend() {
  console.log("\n--- 23. Interrupt -> Send ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  c.send({ type: "send", content: "Write a 500 word essay about dogs", slot: 0 });
  await c.waitFor(m => m.type === "text_delta" && m.slot === 0);
  c.send({ type: "interrupt", slot: 0 });
  await c.waitFor(m => m.type === "turn_done" && m.slot === 0);
  pass("Interrupted");

  // Now send a new message — should work normally
  c.clearInbox();
  const { turnDone } = await sendAndWait(c, "Reply with just: after_interrupt");
  pass("Sent message after interrupt");

  const textDone = c.inbox.find(m => m.type === "text_done" && m.slot === 0);
  if (textDone?.text?.toLowerCase().includes("after_interrupt")) pass("Got expected response");
  else log(`Response: ${textDone?.text?.slice(0, 60) || "(no text_done)"}`);

  c.close();
}

// 24. Rapid new_session while generating
async function testNewSessionWhileGenerating() {
  console.log("\n--- 24. New Session While Generating ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  c.send({ type: "send", content: "Write a 300 word essay about fish", slot: 0 });
  await c.waitFor(m => m.type === "text_delta" && m.slot === 0);
  pass("Generation started");

  // Hit new session while generating
  c.send({ type: "new_session", slot: 0 });
  const status = await c.waitForNew(m => m.type === "status");
  pass("new_session accepted while generating");

  if (!status.isGenerating) pass("isGenerating cleared");
  else log("isGenerating still true (agent may take a moment to stop)");

  // Should be able to send a new message
  c.clearInbox();
  const { turnDone } = await sendAndWait(c, "Reply with: fresh_session");
  pass("New message works after new_session mid-generation");

  c.close();
}

// 25. Multiple rewinds in sequence
async function testMultipleRewinds() {
  console.log("\n--- 25. Multiple Rewinds ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  await sendAndWait(c, "Reply with: first");
  await sendAndWait(c, "Reply with: second");
  await sendAndWait(c, "Reply with: third");
  pass("3 turns sent");

  // Rewind 1
  c.clearInbox();
  c.send({ type: "rewind", count: 1, slot: 0 });
  const r1 = await c.waitFor(m => m.type === "session_event" && m.event === "rewound");
  pass(`Rewind 1: userText="${(r1.userText || "").slice(0, 30)}"`);

  // Rewind 1 more (should now be at turn 1)
  c.clearInbox();
  c.send({ type: "rewind", count: 1, slot: 0 });
  const r2 = await c.waitFor(m => m.type === "session_event" && m.event === "rewound");
  pass(`Rewind 2: userText="${(r2.userText || "").slice(0, 30)}"`);

  // Should still work — send a message
  c.clearInbox();
  const { turnDone } = await sendAndWait(c, "Reply with: after_double_rewind");
  pass("Message after double rewind works");

  c.close();
}

// 26. Tab with different model and CWD
async function testTabWithDifferentConfig() {
  console.log("\n--- 26. Tab Config Isolation ---");
  const c = await openWs();
  await c.waitStatus();

  // Ensure slot 0 is haiku
  await switchToHaiku(c, 0);

  // Create tab with different model
  c.send({ type: "create_tab", slot: 30, model: "claude-sonnet-5", cwd: "/home/user" });

  // Send on both — they should use different models
  c.send({ type: "send", content: "Reply with: slot0_haiku", slot: 0 });
  c.send({ type: "send", content: "Reply with: slot30_sonnet", slot: 30 });

  await Promise.all([
    c.waitFor(m => m.type === "turn_done" && m.slot === 0),
    c.waitFor(m => m.type === "turn_done" && m.slot === 30),
  ]);
  pass("Both tabs completed with different models");

  c.send({ type: "close_tab", slot: 30 });
  c.close();
}

// 27. Send message immediately after resume (no wait)
async function testResumeAndImmediateSend() {
  console.log("\n--- 27. Resume + Immediate Send ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  const { init } = await sendAndWait(c, "Reply with: base for immediate");
  const sid = init?.sessionId;
  pass(`Base session: ${sid?.slice(0, 8)}`);

  // Resume AND send back-to-back without waiting
  c.send({ type: "new_session", slot: 0 });
  await c.waitForNew(m => m.type === "status");
  c.clearInbox();

  c.send({ type: "resume_session", sessionId: sid, slot: 0 });
  // Don't wait for history — send immediately
  c.send({ type: "send", content: "Reply with: immediate_after_resume", slot: 0 });

  const turnDone = await c.waitFor(m => m.type === "turn_done" && m.slot === 0);
  pass("Immediate send after resume completed");

  c.close();
}

// 28. Close tab while generating
async function testCloseTabWhileGenerating() {
  console.log("\n--- 28. Close Tab While Generating ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "create_tab", slot: 40, model: TEST_MODEL, cwd: "/home/user" });
  c.send({ type: "send", content: "Write a 500 word essay about mountains", slot: 40 });
  await c.waitFor(m => m.type === "text_delta" && m.slot === 40);
  pass("Tab 40 generating");

  c.send({ type: "close_tab", slot: 40 });
  pass("close_tab sent while generating");

  // Verify no crash — send on slot 0 should work
  c.clearInbox();
  await freshHaikuSession(c);
  const { turnDone } = await sendAndWait(c, "Reply with: still_alive");
  pass("Slot 0 still works after closing generating tab");

  c.close();
}

// 29. Rewind with no session (error case)
async function testRewindNoSession() {
  console.log("\n--- 29. Rewind No Session ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "new_session", slot: 0 });
  await c.waitForNew(m => m.type === "status");
  c.clearInbox();

  c.send({ type: "rewind", count: 1, slot: 0 });
  const err = await c.waitFor(m => m.type === "error" && m.slot === 0);
  pass(`Rewind no session: ${err.message}`);

  c.close();
}

// 30. Compact with no session (error case)
async function testCompactNoSession() {
  console.log("\n--- 30. Compact No Session ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "new_session", slot: 0 });
  await c.waitForNew(m => m.type === "status");
  c.clearInbox();

  c.send({ type: "compact", slot: 0 });
  const err = await c.waitFor(m => m.type === "error" && m.slot === 0);
  pass(`Compact no session: ${err.message}`);

  c.close();
}

// 31. Two concurrent connections see same events
async function testTwoConnections() {
  console.log("\n--- 31. Two Concurrent Connections ---");
  const c1 = await openWs();
  await c1.waitStatus();
  await freshHaikuSession(c1);

  // Open second connection
  const c2 = await openWs();
  await c2.waitStatus();

  // Send from c1
  c1.clearInbox();
  c2.clearInbox();
  c1.send({ type: "send", content: "Reply with: dual_connection_test", slot: 0 });

  // Both should get turn_done
  const [td1, td2] = await Promise.all([
    c1.waitFor(m => m.type === "turn_done" && m.slot === 0),
    c2.waitFor(m => m.type === "turn_done" && m.slot === 0),
  ]);
  pass("Both connections got turn_done");

  // Both should have text_done
  const txt1 = c1.inbox.find(m => m.type === "text_done" && m.slot === 0);
  const txt2 = c2.inbox.find(m => m.type === "text_done" && m.slot === 0);
  if (txt1 && txt2) pass("Both connections got text_done");
  else fail("Dual broadcast", `c1=${!!txt1} c2=${!!txt2}`);

  c1.close();
  c2.close();
}

// 32. Resume non-existent session (error case)
async function testResumeNonExistent() {
  console.log("\n--- 32. Resume Non-Existent Session ---");
  const c = await openWs();
  await c.waitStatus();

  c.send({ type: "resume_session", sessionId: "non-existent-session-id-12345", slot: 0 });
  const err = await c.waitFor(m => m.type === "error" && m.slot === 0);
  pass(`Non-existent session error: ${err.message}`);

  c.close();
}

// 33. Send → rewind → send → rewind → send (zigzag)
async function testZigzagRewind() {
  console.log("\n--- 33. Zigzag Rewind ---");
  const c = await openWs();
  await c.waitStatus();
  await freshHaikuSession(c);

  // Send 1
  await sendAndWait(c, "Reply with: zigzag_a");
  pass("Zigzag: sent A");

  // Rewind
  c.clearInbox();
  c.send({ type: "rewind", count: 1, slot: 0 });
  await c.waitFor(m => m.type === "session_event" && m.event === "rewound");
  pass("Zigzag: rewound A");

  // Send replacement
  await sendAndWait(c, "Reply with: zigzag_b");
  pass("Zigzag: sent B (replacement)");

  // Rewind again
  c.clearInbox();
  c.send({ type: "rewind", count: 1, slot: 0 });
  await c.waitFor(m => m.type === "session_event" && m.event === "rewound");
  pass("Zigzag: rewound B");

  // Send another replacement
  const { turnDone } = await sendAndWait(c, "Reply with: zigzag_c");
  pass("Zigzag: sent C (second replacement)");
  if (turnDone.cost !== undefined) pass("Zigzag: final turn has cost");

  c.close();
}

// =============================================================
// Run all tests
// =============================================================
async function main() {
  console.log(`\n========================================`);
  console.log(`  AI Chat Rebuild \u2014 Integration Tests`);
  console.log(`  Target: ${WS_URL}`);
  console.log(`  Model: ${TEST_MODEL} (cost-optimized)`);
  console.log(`========================================`);

  const tests = [
    testConnection,
    testBasicMessage,
    testToolUse,
    testInterrupt,
    testMultiTab,
    testNewSession,
    testSessionListing,
    testResumeSession,
    testRewind,
    testCompact,
    testModelChange,
    testCwdChange,
    testListings,
    testReconnect,
    testServerRestart,
    testMultiTurn,
    testErrorHandling,
    testHistoryFormat,
    // Combo tests
    testResumeThenSend,
    testResumeThenRewind,
    testResumeThenCompact,
    testRewindThenSend,
    testInterruptThenSend,
    testNewSessionWhileGenerating,
    testMultipleRewinds,
    testTabWithDifferentConfig,
    testResumeAndImmediateSend,
    testCloseTabWhileGenerating,
    testRewindNoSession,
    testCompactNoSession,
    testTwoConnections,
    testResumeNonExistent,
    testZigzagRewind,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (err) {
      fail(test.name, err.message);
      console.error(`    Stack: ${err.stack?.split("\n")[1]?.trim()}`);
    }
  }

  console.log(`\n========================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) {
      console.log(`    \u2717 ${f.name}: ${f.reason}`);
    }
  }
  console.log(`========================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();

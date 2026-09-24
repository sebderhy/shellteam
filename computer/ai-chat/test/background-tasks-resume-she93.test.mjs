// SHE-93, the "nothing resumes the agent" half: when a slot's CLI dies with
// background tasks running (a crash, or the cockpit restarting for a release
// at 03:10 while an overnight watcher waits), the agent is resumed with a
// notice naming the lost tasks instead of sitting silent until the user asks
// "So?". The record rides TABS_FILE so it survives the restart itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-she93-"));
const { TABS_FILE } = await import("../lib/constants.mjs");

class FakeAgent extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.sent = []; this.stopped = false; }
  start() {}
  sendMessage(content) { this.sent.push(content); }
  stop() { this.stopped = true; }
  interrupt() {}
  get isBroken() { return false; }
  get isDead() { return false; }
  get isGenerating() { return false; }
}

async function freshSM() {
  const sm = await import(`../lib/session-manager.mjs?v=${Date.now()}-${Math.random()}`);
  sm.setBroadcast(() => {});
  const created = [];
  sm._testSetAgentFactory((opts) => { const a = new FakeAgent(opts); created.push(a); return a; });
  return { sm, created };
}

const TASKS = [{ id: "bgwatch", outputFile: "/tmp/claude-1/tasks/bgwatch.output", startedAt: 1_700_000_000_000 }];
const tick = () => new Promise((r) => setTimeout(r, 20));

test("tracked background tasks are persisted with the tab", async () => {
  const { sm, created } = await freshSM();
  sm.createSlot(3, { model: "claude-opus-5-5" });
  await sm.startAgent(3);
  created[0].emit("background_tasks", { tasks: TASKS });
  sm.flushTabs();
  const saved = JSON.parse(readFileSync(TABS_FILE, "utf8")).find((t) => t.id === 3);
  assert.deepEqual(saved.bgTasks, TASKS);
  created[0].emit("background_tasks", { tasks: [] });
  sm.flushTabs();
  assert.equal(JSON.parse(readFileSync(TABS_FILE, "utf8")).find((t) => t.id === 3).bgTasks, undefined,
    "a finished task leaves no record");
});

test("a CLI dying with tasks running resumes the agent once, with a notice naming them", async () => {
  const { sm, created } = await freshSM();
  sm.createSlot(4, { model: "claude-opus-5-5" });
  await sm.startAgent(4);
  const agent = created[0];
  agent.emit("background_tasks", { tasks: TASKS });
  agent.emit("background_tasks_lost", { tasks: TASKS, exit: "code=137 signal=null" });
  await tick();
  assert.equal(agent.sent.length, 1, "exactly one resume");
  const notice = agent.sent[0];
  assert.match(notice, /^<cockpit-notice>/);
  assert.match(notice, /exited unexpectedly, code=137/);
  assert.match(notice, /bgwatch \(output: \/tmp\/claude-1\/tasks\/bgwatch\.output\)/);
  assert.match(notice, /no completion notification will ever arrive/);
  const last = sm.getHistory(4).at(-1);
  assert.equal(last.type, "user_message");
  assert.equal(last.internal, true, "rendered as a system note, not the user's bubble (SHE-65)");
  assert.equal(sm.listSlots().find((s) => s.id === 4).title ?? null, null, "an internal notice never titles the tab");
  // The record is consumed: a second loss report with nothing tracked is a no-op.
  agent.emit("background_tasks_lost", { tasks: [], exit: "code=1 signal=null" });
  await tick();
  assert.equal(agent.sent.length, 1);
});

test("a cockpit restart: the record survives shutdown and the restarted manager resumes the slot", async () => {
  const first = await freshSM();
  first.sm.createSlot(5, { model: "claude-opus-5-5", cwd: process.env.HOME });
  await first.sm.startAgent(5);
  first.created[0].emit("background_tasks", { tasks: TASKS });
  // server.mjs shutdown(): beginShutdown → flushTabs → stopAllAgents.
  first.sm.beginShutdown();
  first.sm.flushTabs();
  first.sm.stopAllAgents();
  first.sm.flushTabs();
  assert.deepEqual(JSON.parse(readFileSync(TABS_FILE, "utf8")).find((t) => t.id === 5).bgTasks, TASKS,
    "stopping agents for a shutdown must not erase the record");

  const second = await freshSM();
  second.sm.restoreSlots();
  second.sm.resumeLostBackgroundTasks();
  await tick();
  assert.equal(second.created.length, 1, "the slot's agent was started");
  assert.equal(second.created[0].sent.length, 1);
  assert.match(second.created[0].sent[0], /the cockpit restarted/);
  assert.match(second.created[0].sent[0], /bgwatch/);
  second.sm.flushTabs();
  assert.equal(JSON.parse(readFileSync(TABS_FILE, "utf8")).find((t) => t.id === 5).bgTasks, undefined,
    "consumed: the next restart must not nudge again");
});

test("a deliberate stop abandons the tasks: no nudge later", async () => {
  const { sm, created } = await freshSM();
  sm.createSlot(6, { model: "claude-opus-5-5" });
  await sm.startAgent(6);
  created[0].emit("background_tasks", { tasks: TASKS });
  sm.stopAgent(6);
  sm.flushTabs();
  assert.equal(JSON.parse(readFileSync(TABS_FILE, "utf8")).find((t) => t.id === 6).bgTasks, undefined);
  sm.resumeLostBackgroundTasks();
  await tick();
  assert.equal(created.length, 1, "no agent was started for a nudge");
});

test("restoring a tab file without the field is harmless", async () => {
  writeFileSync(TABS_FILE, JSON.stringify([{ id: 0, model: "claude-opus-5-5", cwd: process.env.HOME }]));
  const { sm, created } = await freshSM();
  sm.restoreSlots();
  sm.resumeLostBackgroundTasks();
  await tick();
  assert.equal(created.length, 0);
});

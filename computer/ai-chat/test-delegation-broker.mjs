import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDelegationBroker } from "./lib/delegation-broker.mjs";

function makeDeps() {
  const calls = [];
  const active = new Set();
  const sessions = new Map();
  const cwds = new Map();
  const models = new Map();
  const started = new Set();

  return {
    calls,
    createSlot(slotId, config) {
      calls.push(["createSlot", slotId, config]);
    },
    setSlotModel(slotId, model) {
      calls.push(["setSlotModel", slotId, model]);
      models.set(slotId, model);
    },
    setCwd(slotId, cwd) {
      calls.push(["setCwd", slotId, cwd]);
      cwds.set(slotId, cwd);
    },
    resetSlot(slotId) {
      calls.push(["resetSlot", slotId]);
      sessions.delete(slotId);
      active.delete(slotId);
    },
    resumeSession(slotId, sessionId) {
      calls.push(["resumeSession", slotId, sessionId]);
      sessions.set(slotId, sessionId);
      return { cwd: cwds.get(slotId), model: models.get(slotId) };
    },
    addUserMessage(slotId, message) {
      calls.push(["addUserMessage", slotId, message]);
    },
    isQueryActive(slotId) {
      return active.has(slotId);
    },
    async startAgent(slotId) {
      calls.push(["startAgent", slotId]);
      active.add(slotId);
      started.add(slotId);
    },
    async sendMessage(slotId, message) {
      calls.push(["sendMessage", slotId, message]);
      active.add(slotId);
      return true;
    },
    interruptAgent(slotId) {
      calls.push(["interruptAgent", slotId]);
    },
    now() {
      return 1000 + calls.length;
    },
    stateFile: join(mkdtempSync(join(tmpdir(), "broker-test-")), "broker.json"),
    log() {},
  };
}

describe("delegation broker", () => {
  it("starts a new backend task on an MA worker", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const result = await broker.delegateTask({
      message: "Fix the API tests",
      task_name: "api-tests",
      workspace: "/home/user/projects/shellteam",
      agent_preference: { kind: "backend" },
      requester: { channel: "telegram" },
    });

    assert.equal(result.status, "started");
    assert.match(result.task_id, /^task_/);
    assert.equal(result.task_name, "api-tests");
    assert.equal(result.worker_id, "ma_1");
    assert.equal(result.slot_id, 1000);
    assert.ok(result.hint, "should include a hint about reusing task_name");
    assert.equal(
      deps.calls.some((call) => call[0] === "setSlotModel" && call[2] === "gpt-5.6-sol-max"),
      true,
    );
  });

  it("reuses task by task_name after init/session binding", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const first = await broker.delegateTask({
      message: "Investigate slot management",
      task_name: "slot-management",
      workspace: "/home/user/projects/shellteam",
      requester: { channel: "telegram" },
    });
    await broker.handleWorkerEvent({ type: "init", slot: first.slot_id, sessionId: "sess_1" });
    await broker.handleWorkerEvent({ type: "turn_done", slot: first.slot_id });

    const second = await broker.delegateTask({
      message: "Continue the slot work",
      task_name: "slot-management",
      requester: { channel: "telegram" },
    });

    assert.equal(second.task_id, first.task_id);
    assert.equal(second.task_name, "slot-management");
    assert.equal(
      deps.calls.some((call) => call[0] === "resumeSession" && call[2] === "sess_1"),
      true,
    );
  });

  it("auto-generates task_name when none is provided", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const result = await broker.delegateTask({
      message: "Create a hello world script",
      requester: { channel: "telegram" },
    });

    assert.equal(result.task_name, "create-a-hello-world-script");
    assert.ok(result.hint);
  });

  it("queues follow-up work on a busy task and drains it after turn_done", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const first = await broker.delegateTask({
      message: "Run the first step",
      task_name: "shellteam-tests",
      requester: { channel: "telegram" },
    });
    await broker.handleWorkerEvent({ type: "init", slot: first.slot_id, sessionId: "sess_queue" });

    const queued = await broker.delegateTask({
      message: "Run the second step",
      task_name: "shellteam-tests",
      requester: { channel: "telegram" },
    });

    assert.equal(queued.status, "queued");
    assert.equal(queued.task_id, first.task_id);

    await broker.handleWorkerEvent({ type: "turn_done", slot: first.slot_id });

    const sends = deps.calls.filter((call) => call[0] === "sendMessage");
    assert.equal(sends.length, 2);
    assert.equal(sends[1][2], "Run the second step");
  });

  it("uses different MA workers for concurrent tasks", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const first = await broker.delegateTask({
      message: "Task one",
      task_name: "task-one",
      requester: { channel: "telegram" },
    });
    const second = await broker.delegateTask({
      message: "Task two",
      task_name: "task-two",
      requester: { channel: "telegram" },
    });

    assert.equal(first.worker_id, "ma_1");
    assert.equal(second.worker_id, "ma_2");
    assert.notEqual(first.slot_id, second.slot_id);
  });

  it("creates a new task when fresh=true even if task_name matches", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const first = await broker.delegateTask({
      message: "Initial task",
      task_name: "same-name",
      requester: { channel: "telegram" },
    });
    await broker.handleWorkerEvent({ type: "init", slot: first.slot_id, sessionId: "sess_fresh_1" });
    await broker.handleWorkerEvent({ type: "turn_done", slot: first.slot_id });

    const second = await broker.delegateTask({
      message: "Unrelated task with same name",
      task_name: "same-name",
      fresh: true,
      requester: { channel: "telegram" },
    });

    assert.notEqual(second.task_id, first.task_id);
    assert.equal(second.status, "started");
    assert.equal(
      deps.calls.some((call) => call[0] === "resumeSession" && call[2] === "sess_fresh_1"),
      false,
    );
  });

  it("routes guest tasks to the guest worker pool", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const result = await broker.delegateTask({
      message: "Help the guest",
      requester: { channel: "guest" },
    });

    assert.equal(result.worker_id, "guest_1");
    assert.equal(result.slot_id, 1100);
    const workers = broker.listWorkerStatus("guest");
    assert.equal(workers.length, 2);
  });

  it("persists tasks and restores them on restart", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const first = await broker.delegateTask({
      message: "Persistent task",
      task_name: "persist-me",
      requester: { channel: "telegram" },
    });
    await broker.handleWorkerEvent({ type: "init", slot: first.slot_id, sessionId: "sess_persist" });
    await broker.handleWorkerEvent({ type: "turn_done", slot: first.slot_id });

    const restored = createDelegationBroker(deps);
    const tasks = restored.listTasks("ma");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskName, "persist-me");
    assert.equal(tasks[0].sessionId, "sess_persist");
  });

  it("interrupts a running task by task id", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const task = await broker.delegateTask({
      message: "Long running task",
      requester: { channel: "telegram" },
    });

    const result = broker.interruptTask(task.task_id);
    assert.equal(result.status, "interrupt_requested");
    assert.equal(
      deps.calls.some((call) => call[0] === "interruptAgent" && call[1] === task.slot_id),
      true,
    );
  });

  it("does not interrupt a recycled worker for an old completed task", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const first = await broker.delegateTask({
      message: "Task one",
      requester: { channel: "telegram" },
    });
    await broker.handleWorkerEvent({ type: "turn_done", slot: first.slot_id });

    await broker.delegateTask({
      message: "Task two",
      requester: { channel: "telegram" },
    });

    const result = broker.interruptTask(first.task_id);
    assert.equal(result.status, "cleared_queue");
    assert.equal(
      deps.calls.some((call) => call[0] === "interruptAgent" && call[1] === first.slot_id),
      false,
    );
  });

  it("recovers worker state when queued dispatch fails", async () => {
    const deps = makeDeps();
    let failNextQueuedSend = false;
    const originalSend = deps.sendMessage;
    deps.sendMessage = async (slotId, message) => {
      if (failNextQueuedSend && message === "queued follow-up") {
        failNextQueuedSend = false;
        throw new Error("boom");
      }
      return originalSend(slotId, message);
    };

    const broker = createDelegationBroker(deps);
    const first = await broker.delegateTask({
      message: "primary",
      task_name: "recover-me",
      requester: { channel: "telegram" },
    });
    await broker.handleWorkerEvent({ type: "init", slot: first.slot_id, sessionId: "sess_recover" });

    failNextQueuedSend = true;
    const queued = await broker.delegateTask({
      message: "queued follow-up",
      task_name: "recover-me",
      requester: { channel: "telegram" },
    });
    assert.equal(queued.status, "queued");

    await broker.handleWorkerEvent({ type: "turn_done", slot: first.slot_id });

    const workers = broker.listWorkerStatus("ma");
    const recovered = workers.find((worker) => worker.slotId === first.slot_id);
    assert.equal(recovered.state, "idle");

    const retry = await broker.delegateTask({
      message: "new work after failure",
      requester: { channel: "telegram" },
    });
    assert.equal(retry.status, "started");
  });

  it("keeps guest task_name scoped per guest identity", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const guestA = await broker.delegateTask({
      message: "Guest A task",
      task_name: "follow-up",
      requester: { channel: "guest", sender_id: "guest-a" },
    });
    await broker.handleWorkerEvent({ type: "init", slot: guestA.slot_id, sessionId: "sess_guest_a" });
    await broker.handleWorkerEvent({ type: "turn_done", slot: guestA.slot_id });

    const guestB = await broker.delegateTask({
      message: "Guest B task",
      task_name: "follow-up",
      requester: { channel: "guest", sender_id: "guest-b" },
    });

    assert.notEqual(guestB.task_id, guestA.task_id);

    const guestAResume = await broker.delegateTask({
      message: "Guest A follow-up",
      task_name: "follow-up",
      requester: { channel: "guest", sender_id: "guest-a" },
    });

    assert.equal(guestAResume.task_id, guestA.task_id);
  });

  it("returns task_name in response even when auto-generated", async () => {
    const deps = makeDeps();
    const broker = createDelegationBroker(deps);

    const result = await broker.delegateTask({
      message: "Build a landing page for the new product",
      requester: { channel: "telegram" },
    });

    assert.equal(result.task_name, "build-a-landing-page-for-the-new-product");
    assert.ok(result.hint.includes(result.task_name));
  });

  it("migrates old continuityKey field on restore", async () => {
    const deps = makeDeps();
    // Write old-format state
    const { writeFileSync } = await import("node:fs");
    writeFileSync(deps.stateFile, JSON.stringify({
      nextTaskNumber: 2,
      tasks: [{
        taskId: "task_1",
        continuityKey: "old-key",
        title: "old task",
        workspace: "/home/user",
        sessionId: "sess_old",
        status: "idle",
        ownerType: "ma",
        requesterKey: "ma",
        requester: { channel: "telegram" },
        agentKind: "general",
        provider: "claude",
        model: "claude-opus-4-8",
        workerId: null,
        lastMessageAt: 1000,
        createdAt: 1000,
        lastSummary: "",
        priority: "normal",
        pendingMessages: [],
        continuityMode: "reuse_if_relevant",
      }],
    }));

    const broker = createDelegationBroker(deps);
    const tasks = broker.listTasks("ma");
    assert.equal(tasks[0].taskName, "old-key");
  });
});

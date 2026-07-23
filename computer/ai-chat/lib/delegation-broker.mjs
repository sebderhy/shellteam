import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BROKER_STATE_FILE,
  BROKER_SLOT_POOLS,
  HOME,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_ANTIGRAVITY_MODEL,
} from "./constants.mjs";

const PROVIDER_DEFAULTS = {
  claude: DEFAULT_CLAUDE_MODEL,
  codex: DEFAULT_CODEX_MODEL,
  antigravity: DEFAULT_ANTIGRAVITY_MODEL,
};

const KIND_DEFAULTS = {
  frontend: "claude",
  backend: "codex",
  research: "antigravity",
  general: "claude",
};

const PRIORITY_WEIGHT = {
  high: 0,
  normal: 1,
  low: 2,
};

function stableNow(deps) {
  return deps.now ? deps.now() : Date.now();
}

function summarizeMessage(message) {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

/** Auto-generate a short task name from the first message. */
function generateTaskName(message) {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  // Take first ~60 chars, lowercase, replace non-alphanumeric with dashes, trim dashes
  return text.slice(0, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "task";
}

function normalizePriority(priority) {
  return PRIORITY_WEIGHT[priority] !== undefined ? priority : "normal";
}

function resolveProvider(preference = {}) {
  if (preference.provider && PROVIDER_DEFAULTS[preference.provider]) return preference.provider;
  const kind = preference.kind || "general";
  return KIND_DEFAULTS[kind] || KIND_DEFAULTS.general;
}

function resolveModel(preference = {}) {
  if (preference.model) return preference.model;
  return PROVIDER_DEFAULTS[resolveProvider(preference)] || PROVIDER_DEFAULTS.claude;
}

function normalizeWorkspace(workspace) {
  return workspace || HOME;
}

function ownerTypeFromRequester(requester = {}) {
  return requester.channel === "guest" ? "guest" : "ma";
}

function requesterKeyFromRequester(requester = {}) {
  if (requester.channel === "guest") {
    return `guest:${requester.sender_id || requester.sender_name || "anonymous"}`;
  }
  return "ma";
}

function taskToJSON(task) {
  return {
    taskId: task.taskId,
    taskName: task.taskName,
    title: task.title,
    workspace: task.workspace,
    sessionId: task.sessionId,
    status: task.status,
    ownerType: task.ownerType,
    requesterKey: task.requesterKey,
    requester: task.requester,
    agentKind: task.agentKind,
    provider: task.provider,
    model: task.model,
    workerId: task.workerId,
    lastMessageAt: task.lastMessageAt,
    createdAt: task.createdAt,
    lastSummary: task.lastSummary,
    priority: task.priority,
    pendingMessages: task.pendingMessages || [],
    fresh: task.fresh || false,
  };
}

export function createDelegationBroker(deps) {
  const workers = new Map();
  const tasks = new Map();
  const sessionOwners = new Map();
  const brokerSlots = new Set();
  let nextTaskNumber = 1;
  let nextLeaseNumber = 1;

  for (const [ownerType, slotIds] of Object.entries(BROKER_SLOT_POOLS)) {
    slotIds.forEach((slotId, index) => {
      brokerSlots.add(slotId);
      workers.set(`${ownerType}_${index + 1}`, {
        workerId: `${ownerType}_${index + 1}`,
        slotId,
        ownerType,
        state: "idle",
        leaseId: null,
        taskId: null,
        sessionId: null,
        model: null,
        cwd: null,
        lastUsedAt: 0,
      });
    });
  }

  function persist() {
    if (!deps.stateFile) return;
    mkdirSync(dirname(deps.stateFile), { recursive: true });
    const data = {
      nextTaskNumber,
      tasks: [...tasks.values()].map(taskToJSON),
    };
    writeFileSync(deps.stateFile, JSON.stringify(data, null, 2));
  }

  function restore() {
    if (!deps.stateFile || !existsSync(deps.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(deps.stateFile, "utf8"));
      nextTaskNumber = raw.nextTaskNumber || nextTaskNumber;
      for (const saved of raw.tasks || []) {
        const task = {
          ...saved,
          // Migrate old continuityKey field to taskName
          taskName: saved.taskName || saved.continuityKey || null,
          requesterKey: saved.requesterKey || requesterKeyFromRequester(saved.requester || {}),
          pendingMessages: saved.pendingMessages || [],
        };
        delete task.continuityKey;
        tasks.set(task.taskId, task);
        if (task.sessionId) sessionOwners.set(task.sessionId, task.taskId);
        if (task.workerId && workers.has(task.workerId)) {
          const worker = workers.get(task.workerId);
          worker.taskId = task.taskId;
          worker.sessionId = task.sessionId || null;
          worker.model = task.model || null;
          worker.cwd = task.workspace || null;
          worker.lastUsedAt = task.lastMessageAt || task.createdAt || 0;
          worker.state = "idle";
        }
      }
    } catch (err) {
      deps.log?.("warn", `delegation-broker restore failed: ${err.message}`);
    }
  }

  function buildTaskRecord(input) {
    const now = stableNow(deps);
    const provider = resolveProvider(input.agent_preference || {});
    const model = resolveModel(input.agent_preference || {});
    const taskId = `task_${nextTaskNumber++}`;
    const taskName = input.task_name || generateTaskName(input.message);
    return {
      taskId,
      taskName,
      title: summarizeMessage(input.message),
      workspace: normalizeWorkspace(input.workspace),
      sessionId: null,
      status: "idle",
      ownerType: ownerTypeFromRequester(input.requester),
      requesterKey: requesterKeyFromRequester(input.requester),
      requester: input.requester || {},
      agentKind: input.agent_preference?.kind || "general",
      provider,
      model,
      workerId: null,
      lastMessageAt: now,
      createdAt: now,
      lastSummary: "",
      priority: normalizePriority(input.priority),
      pendingMessages: [],
      fresh: input.fresh || false,
    };
  }

  function findTask(input) {
    const ownerType = ownerTypeFromRequester(input.requester);
    const requesterKey = requesterKeyFromRequester(input.requester);

    // Look up by explicit task_id first
    if (input.task_id) {
      const task = tasks.get(input.task_id);
      if (task && task.ownerType === ownerType && task.requesterKey === requesterKey) return task;
      return null;
    }
    // Then by task_name
    if (input.task_name) {
      return [...tasks.values()].find((task) =>
        task.ownerType === ownerType
        && task.requesterKey === requesterKey
        && task.taskName === input.task_name
        && task.status !== "archived") || null;
    }
    return null;
  }

  function sortQueuedTasks(candidates) {
    return [...candidates].sort((a, b) => {
      const ap = PRIORITY_WEIGHT[a.priority] ?? PRIORITY_WEIGHT.normal;
      const bp = PRIORITY_WEIGHT[b.priority] ?? PRIORITY_WEIGHT.normal;
      if (ap !== bp) return ap - bp;
      const aTime = a.pendingMessages[0]?.enqueuedAt || a.lastMessageAt || a.createdAt;
      const bTime = b.pendingMessages[0]?.enqueuedAt || b.lastMessageAt || b.createdAt;
      return aTime - bTime;
    });
  }

  function chooseIdleWorker(ownerType) {
    const pool = [...workers.values()].filter((worker) =>
      worker.ownerType === ownerType && worker.state === "idle");
    if (pool.length === 0) return null;
    pool.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    return pool[0];
  }

  function reserveWorker(worker, task) {
    worker.state = "reserved";
    worker.leaseId = `lease_${nextLeaseNumber++}`;
    worker.taskId = task.taskId;
    worker.sessionId = task.sessionId;
    worker.model = task.model;
    worker.cwd = task.workspace;
    task.workerId = worker.workerId;
    task.status = "starting";
    return worker.leaseId;
  }

  function detachTaskFromWorker(task, worker) {
    task.workerId = null;
    worker.taskId = null;
    worker.sessionId = null;
    worker.leaseId = null;
    worker.state = "idle";
  }

  function markDispatchFailed(task, worker, err) {
    detachTaskFromWorker(task, worker);
    task.status = "failed";
    task.lastSummary = err.message;
    persist();
  }

  function buildResponse(task, overrides = {}) {
    const resp = {
      task_id: task.taskId,
      task_name: task.taskName,
      provider: task.provider,
      model: task.model,
      session_id: task.sessionId,
      worker_id: task.workerId,
      ...overrides,
    };
    // Nudge the MA to reuse the task_name for follow-ups
    if (overrides.status === "started" || overrides.status === "queued") {
      resp.hint = `To send follow-up messages for this task, pass task_name: "${task.taskName}"`;
    }
    return resp;
  }

  async function configureAndDispatch(worker, task, message) {
    const slotId = worker.slotId;
    deps.createSlot(slotId, { model: task.model, cwd: task.workspace });
    deps.setSlotModel(slotId, task.model);
    deps.setCwd(slotId, task.workspace);

    if (task.sessionId) {
      const ownerTaskId = sessionOwners.get(task.sessionId);
      if (ownerTaskId && ownerTaskId !== task.taskId) {
        throw new Error(`Session ${task.sessionId} is already attached to ${ownerTaskId}`);
      }
      const result = deps.resumeSession(slotId, task.sessionId);
      if (result?.error) throw new Error(result.error);
    } else {
      deps.resetSlot(slotId);
    }

    // The delegated task is agent-authored, not typed by the owner — tag it
    // internal so the worker slot's transcript shows it as a system note, not
    // as the user's own bubble (SHE-65).
    deps.addUserMessage(slotId, message, { internal: true });
    if (!deps.isQueryActive(slotId)) {
      await deps.startAgent(slotId);
    }
    const sent = await deps.sendMessage(slotId, message);
    if (!sent) throw new Error("Worker failed to accept message");

    worker.state = "running";
    worker.lastUsedAt = stableNow(deps);
    task.status = "running";
    task.lastMessageAt = worker.lastUsedAt;
    persist();
  }

  async function dispatchOnWorker(worker, task, message, continuityDecision) {
    reserveWorker(worker, task);
    try {
      await configureAndDispatch(worker, task, message);
      return buildResponse(task, {
        slot_id: worker.slotId,
        status: "started",
        queue_position: 0,
        continuity_decision: continuityDecision,
      });
    } catch (err) {
      markDispatchFailed(task, worker, err);
      throw err;
    }
  }

  async function dispatchTask(task, message) {
    const worker = task.workerId ? workers.get(task.workerId) : chooseIdleWorker(task.ownerType);
    if (!worker || worker.state !== "idle") {
      task.pendingMessages.push({
        message,
        priority: task.priority,
        enqueuedAt: stableNow(deps),
      });
      task.status = "queued";
      persist();
      return buildResponse(task, {
        status: "queued",
        queue_position: queuePosition(task.taskId),
        continuity_decision: "queued",
      });
    }

    return dispatchOnWorker(worker, task, message, task.sessionId ? "reused_existing_task" : "started_new_task");
  }

  function queuePosition(taskId) {
    const queued = sortQueuedTasks([...tasks.values()].filter((task) =>
      task.pendingMessages.length > 0 && task.status === "queued"));
    const idx = queued.findIndex((task) => task.taskId === taskId);
    return idx === -1 ? 0 : idx + 1;
  }

  async function maybeDispatchQueuedTaskForWorker(worker) {
    const currentTask = worker.taskId ? tasks.get(worker.taskId) : null;
    if (currentTask && currentTask.pendingMessages.length > 0) {
      const nextMessage = currentTask.pendingMessages.shift();
      try {
        await dispatchOnWorker(worker, currentTask, nextMessage.message, "continued_existing_task");
      } catch (err) {
        currentTask.pendingMessages.unshift(nextMessage);
        currentTask.status = "failed";
        currentTask.lastSummary = err.message;
        persist();
      }
      return;
    }

    if (currentTask) {
      detachTaskFromWorker(currentTask, worker);
      persist();
    }

    const queuedTasks = sortQueuedTasks([...tasks.values()].filter((task) =>
      task.ownerType === worker.ownerType && task.pendingMessages.length > 0));
    const nextTask = queuedTasks[0];
    if (!nextTask) return;
    const nextMessage = nextTask.pendingMessages.shift();
    try {
      await dispatchOnWorker(worker, nextTask, nextMessage.message, "started_queued_task");
    } catch (err) {
      nextTask.pendingMessages.unshift(nextMessage);
      nextTask.status = "failed";
      nextTask.lastSummary = err.message;
      persist();
    }
  }

  async function handleWorkerEvent(event) {
    if (!isBrokerSlot(event.slot)) return;
    const worker = [...workers.values()].find((entry) => entry.slotId === event.slot);
    if (!worker) return;
    const task = worker.taskId ? tasks.get(worker.taskId) : null;

    if (event.type === "init" && event.sessionId && task) {
      const existingOwner = sessionOwners.get(event.sessionId);
      if (existingOwner && existingOwner !== task.taskId) {
        deps.log?.("warn", `delegation-broker session collision: ${event.sessionId} owned by ${existingOwner}`);
      }
      task.sessionId = event.sessionId;
      worker.sessionId = event.sessionId;
      sessionOwners.set(event.sessionId, task.taskId);
      persist();
      return;
    }

    if (!task) return;

    if (event.type === "turn_done") {
      worker.lastUsedAt = stableNow(deps);
      task.status = task.pendingMessages.length > 0 ? "queued" : "idle";
      task.lastMessageAt = worker.lastUsedAt;
      persist();
      await maybeDispatchQueuedTaskForWorker(worker);
      return;
    }

    if ((event.type === "server" && event.subtype === "cli_exit") || event.type === "error") {
      detachTaskFromWorker(task, worker);
      task.status = "failed";
      task.lastSummary = event.message || event.subtype || "worker exited";
      persist();
    }
  }

  async function delegateTask(input) {
    if (!input?.message) throw new Error("message is required");
    const isFresh = input.fresh === true;

    let task = isFresh ? null : findTask(input);
    if (!task) {
      if (input.task_id && !input.task_name) {
        // Explicit task_id that doesn't exist — error
        throw new Error("No existing task matched the requested task_id");
      }
      task = buildTaskRecord(input);
      tasks.set(task.taskId, task);
    }

    if (task.ownerType !== ownerTypeFromRequester(input.requester)) {
      throw new Error("Task owner mismatch");
    }
    if (task.requesterKey !== requesterKeyFromRequester(input.requester)) {
      throw new Error("Task requester mismatch");
    }

    // Update task name if provided and task didn't have one
    if (input.task_name && !task.taskName) {
      task.taskName = input.task_name;
    }
    task.lastMessageAt = stableNow(deps);
    task.priority = normalizePriority(input.priority || task.priority);
    persist();
    return dispatchTask(task, input.message);
  }

  function listTasks(ownerType = "ma") {
    return [...tasks.values()]
      .filter((task) => task.ownerType === ownerType)
      .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt))
      .map((task) => ({
        taskId: task.taskId,
        taskName: task.taskName,
        title: task.title,
        status: task.status,
        workspace: task.workspace,
        agentKind: task.agentKind,
        provider: task.provider,
        model: task.model,
        sessionId: task.sessionId,
        queueDepth: task.pendingMessages.length,
        workerId: task.workerId,
        lastMessageAt: task.lastMessageAt,
      }));
  }

  function listWorkerStatus(ownerType = "ma") {
    return [...workers.values()]
      .filter((worker) => worker.ownerType === ownerType)
      .map((worker) => ({
        workerId: worker.workerId,
        slotId: worker.slotId,
        ownerType: worker.ownerType,
        state: worker.state,
        taskId: worker.taskId,
        sessionId: worker.sessionId,
        model: worker.model,
        cwd: worker.cwd,
        lastUsedAt: worker.lastUsedAt,
      }));
  }

  function interruptTask(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const worker = task.workerId ? workers.get(task.workerId) : null;
    if (!worker || worker.taskId !== taskId || worker.state === "idle") {
      task.workerId = null;
      task.pendingMessages = [];
      task.status = "idle";
      persist();
      return { task_id: task.taskId, status: "cleared_queue" };
    }
    deps.interruptAgent(worker.slotId);
    return { task_id: task.taskId, status: "interrupt_requested", worker_id: worker.workerId };
  }

  function isBrokerSlot(slotId) {
    return brokerSlots.has(slotId);
  }

  restore();

  return {
    delegateTask,
    handleWorkerEvent,
    interruptTask,
    isBrokerSlot,
    listTasks,
    listWorkerStatus,
  };
}

export function createLiveDelegationBroker(deps) {
  return createDelegationBroker({
    stateFile: BROKER_STATE_FILE,
    ...deps,
  });
}

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOME, TABS_FILE, SESSION_FILE, MAX_HISTORY, CODEX_HISTORY_DIR, WORKSPACE_LOCK } from "./constants.mjs";
import { loadModel, getCliEnv, loadApiKey, saveApiKey, loadOpenAIApiKey } from "./session.mjs";
import { loadAdapterClass, supports, agentIdFor } from "./agents/registry.mjs";
import { handoffSession } from "./portable/index.mjs";
import {
  findSessionFile,
  readSessionForReplay,
  truncateSessionFile,
  listSessions,
  cwdFromSessionPath,
  familyOfSession,
  codexSessionCwd,
  appendClaudeSessionMarker,
  isInternalUserContent,
} from "./history.mjs";

/**
 * SessionManager — owns the slot map, agent lifecycle, history tracking,
 * and tab state persistence. The single source of truth for all session state.
 *
 * Each slot has:
 *   { config: { model, cwd }, agent: CodingAgent|null, sessionId, history: [],
 *     isGenerating: false, streamingText: "", totalCost: 0 }
 */

const slots = new Map();
let broadcastFn = () => {};
let apiKeySource = null;
let saveTabsTimer = null;
let _agentFactory = null; // test-only: override agent creation

// --- Helpers ---

/**
 * Pin a cwd inside the workspace lock (guest cockpit — see
 * docs/decisions/20260707-scoped-guest-cockpit.md). No lock (the default):
 * the dir passes through UNTOUCHED — zero behavior change, pinned by the
 * purity guarantee. Locked: a dir equal to or inside the lock passes
 * (path-SEGMENT-safe — /x/acme-project-evil does NOT pass a /x/acme-project lock);
 * anything else is loudly clamped to the lock itself. Every cwd write path
 * in this module funnels through here.
 */
export function clampToWorkspaceLock(dir, lock = WORKSPACE_LOCK) {
  if (!lock) return dir;
  if (!dir) return lock;
  const abs = resolve(dir);
  if (abs === lock || abs.startsWith(lock + "/")) return abs;
  console.warn(`[session-mgr] Workspace lock: cwd ${abs} is outside the locked workspace ${lock} — pinning to the lock`);
  return lock;
}

function defaultConfig() {
  return { model: loadModel(), cwd: clampToWorkspaceLock(HOME) };
}

const MAX_WATCHDOG_RESTARTS = 2;

/** Extract cost from the last turn_done/result message in a history array. */
function extractCostFromHistory(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "turn_done" && messages[i].cost !== undefined) return messages[i].cost;
    if (messages[i].type === "result" && messages[i].total_cost_usd !== undefined) return messages[i].total_cost_usd;
  }
  return 0;
}

/**
 * THE single slot-creation path (SHE-52). Only the authoritative create
 * routes may call this: createSlot (client create_tab / delegation broker),
 * forkSlot, restoreSlots (cold-start restore), the module-load default
 * slot 0, and _testInjectAgent. Everything else looks slots up with
 * getSlot() and treats "missing" as missing — the old ensureSlot-everywhere
 * pattern meant ANY read or stale command silently resurrected a slot
 * another device had just closed ("empty chat tabs keep appearing", SHE-78).
 */
function materializeSlot(id) {
  if (!slots.has(id)) {
    slots.set(id, {
      config: defaultConfig(),
      agent: null,
      sessionId: null,
      createdAt: Date.now(),
      history: [],
      isGenerating: false,
      streamingText: "",
      totalCost: 0,
      watchdogRestarts: 0,
      lastUsedAt: Date.now(),
    });
  }
  return slots.get(id);
}

/** Pure lookup — never creates. The default accessor for every read/mutate. */
function getSlot(id) {
  return slots.get(id);
}

function touchSlot(slotId) {
  const slot = getSlot(slotId);
  if (slot) slot.lastUsedAt = Date.now();
}

export function markSlotUsed(slotId) {
  // Touch is a VIEW action (tab switch, late materialization) — it must never
  // create a slot. Without this guard, switching to a tab another device had
  // just closed resurrected it server-side as an empty slot, and the next
  // status broadcast re-materialized it on every device (SHE-78).
  if (!slots.has(slotId)) {
    console.warn(`[session-mgr] touch of unknown slot ${slotId} ignored — closed on another device?`);
    return false;
  }
  touchSlot(slotId);
  saveTabs();
  return true;
}

export function hasSlot(slotId) {
  return slots.has(slotId);
}

// Ensure slot 0 exists at startup
materializeSlot(0);

// --- Broadcast ---

export function setBroadcast(fn) { broadcastFn = fn; }

function broadcast(obj) { broadcastFn(obj); }

/** Send a protocol message tagged with slot to all clients. */
function slotBroadcast(slotId, type, data = {}) {
  broadcast({ type, slot: slotId, ...data });
}

// --- Public API: state queries ---

export function getApiKeySource() { return apiKeySource; }
export function setApiKeySource(s) { apiKeySource = s; }
// State queries are PURE READS: a getter on a missing slot returns the
// neutral default and never creates. The old ensureSlot-backed getters meant
// e.g. buildStatus() or a stale client's read resurrected closed slots as a
// side effect (SHE-50's buildStatus vector, generalized by SHE-52).
export function isQueryActive(slotId = 0) { return getSlot(slotId)?.agent != null; }
export function getIsGenerating(slotId = 0) { return getSlot(slotId)?.isGenerating ?? false; }
export function getSessionId(slotId = 0) { return getSlot(slotId)?.sessionId ?? null; }
export function getCwd(slotId = 0) { return getSlot(slotId)?.config.cwd ?? clampToWorkspaceLock(HOME); }
export function getTotalCost(slotId = 0) { return getSlot(slotId)?.totalCost ?? 0; }
export function getSlotModel(slotId = 0) { return getSlot(slotId)?.config.model ?? loadModel(); }
export function getHistory(slotId = 0) { return getSlot(slotId)?.history ?? []; }

// --- Public API: slot management ---

/**
 * The client-facing create_tab policy (SHE-78 / SHE-52): the server owns slot
 * EXISTENCE. Only a create explicitly marked `fresh` (the + button, or a
 * reconciled draft tab the server never acked) may bring a new slot into
 * being. An unmarked create for an unknown id is a stale client replaying
 * tabs that were closed from another device while it was offline — honoring
 * it resurrected every closed tab on reconnect ("empty chat tabs keep
 * appearing"). Returns false when refused so the caller can re-sync the
 * stale client instead of silently diverging.
 */
export function clientCreateSlot(id, configOverrides, fresh = false) {
  if (!slots.has(id) && !fresh) {
    console.warn(`[session-mgr] create_tab ${id} refused: unknown slot without fresh flag — stale-client replay (SHE-78)`);
    return false;
  }
  createSlot(id, configOverrides);
  return true;
}

/**
 * Allocate a canonical slot id server-side (SHE-52). The client's proposed id
 * is only a HINT: two browsers holding the same snapshot compute the same
 * `nextSlotId`, and honoring both raced creates verbatim silently merged two
 * users' intended conversations into ONE server slot. A free hint is granted
 * (keeps the optimistic client id stable in the common case); a taken or
 * absent hint gets the next id above every non-excluded slot. `isExcluded`
 * lets the caller keep out-of-band ranges (delegation-broker slots) from
 * inflating user tab ids.
 */
// Ids handed out by allocateSlotId whose slot does not EXIST yet because its
// creation spans an await (forkSlot's portable-session export). Existence
// alone can't make allocation atomic across that boundary: a second fork
// arriving mid-export saw the id as free, was granted the same allocation,
// and the two forks silently collapsed into one visible tab (round-4 audit
// P1 — the async counterpart of the raced create_tab in SHE-52). Reserved
// synchronously before the first await, released in a finally.
const reservedSlotIds = new Set();

export function allocateSlotId(hint, isExcluded = () => false) {
  if (hint !== undefined && hint !== null && !slots.has(hint) && !reservedSlotIds.has(hint)) return hint;
  let max = -1;
  for (const id of slots.keys()) {
    if (typeof id === "number" && !isExcluded(id) && id > max) max = id;
  }
  let candidate = max + 1;
  while (slots.has(candidate) || reservedSlotIds.has(candidate)) candidate++;
  return candidate;
}

export function createSlot(id, configOverrides) {
  const existed = slots.has(id);
  const slot = materializeSlot(id);
  // An existing slot is server-authoritative for its model and cwd — the server
  // holds the latest values (set_cwd / model_changed update it directly). The
  // frontend re-issues create_tab for every tab on reconnect (and every device
  // pushes its own possibly-stale config); honoring those overrides here would
  // clobber a deliberately-set workspace. This bites BEFORE the first message is
  // sent too — a slot whose cwd the user just set has no sessionId yet, so a
  // reconnect from a stale client would silently revert it and the agent would
  // spawn in the wrong folder. Only apply overrides when the slot is brand new.
  if (configOverrides && !existed) {
    Object.assign(slot.config, configOverrides);
    slot.config.cwd = clampToWorkspaceLock(slot.config.cwd);
  }
  touchSlot(id);
  saveTabs();
}

export function deleteSlot(id) {
  const slot = slots.get(id);
  if (slot?.agent) slot.agent.stop();
  slots.delete(id);
  saveTabs();
}

/**
 * Re-lay the slots Map in `orderedIds` order. Map iteration is insertion order,
 * which is what listSlots()/saveTabs() emit and the client renders top-to-bottom,
 * so re-inserting in a new order makes a drag-reorder durable (saveTabs → survives
 * restart) and broadcastable (survives multi-device). Never drops a slot: ids not
 * in `orderedIds` keep their current relative order at the end; unknown ids are
 * ignored. (SHE-75. This is the tab-ORDER slice only; the fuller server-authoritative
 * slot refactor is SHE-52.)
 */
function _applyOrder(orderedIds) {
  const seen = new Set();
  const finalIds = [];
  for (const id of orderedIds) {
    if (slots.has(id) && !seen.has(id)) { finalIds.push(id); seen.add(id); }
  }
  for (const id of slots.keys()) if (!seen.has(id)) finalIds.push(id);
  const entries = finalIds.map((id) => [id, slots.get(id)]);
  slots.clear();
  for (const [id, s] of entries) slots.set(id, s);
}

export function reorderSlots(orderedIds) {
  if (!Array.isArray(orderedIds)) return;
  _applyOrder(orderedIds);
  saveTabs();
}

export function listSlots() {
  return [...slots.entries()].map(([id, s]) => ({
    id,
    sessionId: s.sessionId,
    isGenerating: s.isGenerating,
    createdAt: s.createdAt || Date.now(),
    lastUsedAt: s.lastUsedAt || Date.now(),
    label: deriveLabel(id),
    ...s.config,
  }));
}

function deriveLabel(slotId) {
  const slot = slots.get(slotId);
  if (!slot) return null;
  // A title captured at the first real user message is stable for the life of
  // the conversation — compaction rewrites history (the old first message is
  // gone and the trimmed tail starts with compaction-turn text), so deriving
  // from post-compaction history produced titles like "local stdout compacted…"
  // (SHE-43). Never re-derive once a title exists.
  if (slot.title) return slot.title;
  if (slot.history[0]?.type === "session_event" && slot.history[0]?.event === "compacted") {
    return null; // compacted with no captured title — better unnamed than garbage
  }
  for (const msg of slot.history) {
    if (msg.type === "user_message" && msg.content && !msg.internal) {
      return truncateTitle(msg.content);
    }
  }
  return null;
}

function truncateTitle(content) {
  const text = String(content);
  return text.length > 30 ? text.slice(0, 30) + "..." : text;
}

// --- Public API: config changes ---

export function setSlotModel(slotId, model) {
  const slot = getSlot(slotId);
  if (!slot) return { error: "This tab no longer exists — it was closed on another device." };
  const oldModel = slot.config.model;
  slot.config.model = model;
  touchSlot(slotId);
  if (oldModel === model || !slot.sessionId) {
    saveTabs();
    return { reset: false };
  }
  // Session files are model-agnostic within an agent family: `<cli> --resume`
  // accepts a different model, so a same-family switch keeps the conversation.
  // Cross-family session IDs are not portable (Codex thread IDs ≠ Claude UUIDs
  // ≠ OpenCode ses_…) — there the conversation must reset.
  if (agentIdFor(oldModel) === agentIdFor(model)) {
    console.log(`[session-mgr] Slot ${slotId}: model changed ${oldModel} → ${model} (same family) — keeping session ${slot.sessionId}`);
    stopAgent(slotId);
    saveTabs();
    return { reset: false };
  }
  console.log(`[session-mgr] Slot ${slotId}: model changed ${oldModel} → ${model} (cross-family) — resetting session`);
  resetSlot(slotId);
  return { reset: true };
}

/**
 * Switch a slot's model, translating the live conversation when the switch
 * crosses an agent family (portable sessions, roadmap B1). Unlike the legacy
 * setSlotModel — which resets on a cross-family switch — this carries the
 * conversation over by synthesizing a native session file the target CLI
 * resumes as its own.
 *
 * Returns one of:
 *   { reset: false }                         — same-family switch, or fresh slot (no session)
 *   { reset: false, handoff: {...} }         — cross-family, conversation translated
 *   { error: "<user-facing cause>" }         — refused (generating) or handoff failed
 *
 * Failure policy (invariants 7/8, house rule): on any handoff error the model
 * is NOT changed and the source session stays intact and usable — no silent
 * fallback, the caller surfaces the real cause.
 */
export async function switchSlotModel(slotId, model) {
  const slot = getSlot(slotId);
  if (!slot) return { error: "This tab no longer exists — it was closed on another device." };
  const oldModel = slot.config.model;
  if (oldModel === model) { touchSlot(slotId); saveTabs(); return { reset: false }; }

  const fromFamily = agentIdFor(oldModel);
  const toFamily = agentIdFor(model);

  // Fresh slot or same family → no translation needed; reuse setSlotModel's
  // proven semantics (config change / keep session on same family).
  if (!slot.sessionId || fromFamily === toFamily) {
    return setSlotModel(slotId, model);
  }

  // Cross-family with a live session → portable handoff. Turn-boundary only
  // (invariant 1): refuse mid-generation so no active tool loop is in flight.
  if (slot.isGenerating) {
    return { error: "Can't switch agents while a turn is generating — wait for it to finish, then switch." };
  }

  const fromSessionId = slot.sessionId;
  const cwd = slot.config.cwd;
  let handoff;
  try {
    handoff = await handoffSession({ fromFamily, fromSessionId, fromModel: oldModel, toFamily, toModel: model, cwd });
  } catch (e) {
    console.error(`[session-mgr] Slot ${slotId}: portable handoff ${fromFamily}(${fromSessionId}) → ${toFamily} FAILED: ${e.stack || e.message}`);
    return {
      error: `Couldn't translate the session for ${toFamily}: ${e.message}. Your ${fromFamily} conversation is untouched — retry, or start a new chat with ${model}.`,
    };
  }

  // Commit: stop the old agent, repoint the slot at the fresh native session.
  stopAgent(slotId);
  slot.config.model = model;
  slot.sessionId = handoff.nativeSessionId;
  slot.sessionFamily = toFamily;

  // Seed the cockpit-owned protocol JSONL for non-Claude targets (mirrors the
  // `init` handler): the CLI wrote its native file, but the cockpit persists its
  // own protocol history for agents whose CLI does not own history.
  if (!supports(model, "cliOwnsHistory")) {
    appendCodexHistory(handoff.nativeSessionId, { type: "session_meta", model, cwd, timestamp: Date.now() });
    for (const msg of slot.history) appendCodexHistory(handoff.nativeSessionId, msg);
  }

  // Visible, persisted handoff marker (invariant: no invisible magic). addToHistory
  // persists it to whichever store backs the slot — protocol JSONL for non-Claude,
  // the native .jsonl for Claude — so it survives a reconnect replay for every family.
  addToHistory(slotId, {
    type: "session_event", event: "handoff",
    fromFamily, toFamily, toModel: model, timestamp: Date.now(),
  });

  if (slotId === 0) saveSessionIdToDisk(handoff.nativeSessionId);
  touchSlot(slotId);
  saveTabs();
  console.log(`[session-mgr] Slot ${slotId}: handoff ${fromFamily} → ${toFamily} committed — session ${handoff.nativeSessionId} (csf=${handoff.csfId})`);
  return { reset: false, handoff: { fromFamily, toFamily, toModel: model, csfId: handoff.csfId, stats: handoff.stats } };
}

/**
 * Fork a slot's live conversation into a brand-new slot (roadmap B1 fast-follow).
 * The fork is a fresh native session the target CLI resumes as its own, seeded
 * with the full history of the source — so you can branch a conversation and
 * explore a different direction without touching the original.
 *
 * Reuses the portable-sessions engine for BOTH same-family and cross-family
 * forks: handoffSession() always writes a NEW native session file and never
 * mutates the source, which is exactly a fork. Same-family forks lose only the
 * reasoning traces (omissible by design — never replayed to the API); message,
 * tool-call, and tool-result fidelity is preserved (invariant 4/5). Passing a
 * `toModel` in a different family forks *and* switches agent in one step.
 *
 * The source slot is left byte-for-byte untouched. On any error no new slot is
 * created and the original is intact (no silent fallback — the caller surfaces
 * the real cause).
 *
 * Returns { newSlotId, sessionId, model, cwd, fork:{...}, history } or { error }.
 */
export async function forkSlot(sourceSlotId, newSlotId, toModel = null) {
  const source = slots.get(sourceSlotId);
  if (!source || !source.sessionId) {
    return { error: "Nothing to fork yet — start the conversation first." };
  }
  if (source.isGenerating) {
    return { error: "Can't fork while a turn is generating — wait for it to finish, then fork." };
  }
  if (slots.has(newSlotId) || reservedSlotIds.has(newSlotId)) {
    return { error: `Slot ${newSlotId} already exists — pick a fresh slot id for the fork.` };
  }

  // Reserve the id BEFORE the awaited export so a concurrent fork/create
  // can't be granted it mid-flight; released in the finally on every path,
  // so a failed export leaves no ghost reservation.
  reservedSlotIds.add(newSlotId);
  try {
    return await forkIntoReservedSlot(source, sourceSlotId, newSlotId, toModel);
  } finally {
    reservedSlotIds.delete(newSlotId);
  }
}

/** The body of forkSlot; only runs while `newSlotId` is reserved. */
async function forkIntoReservedSlot(source, sourceSlotId, newSlotId, toModel) {
  const fromModel = source.config.model;
  const model = toModel || fromModel;
  const fromFamily = agentIdFor(fromModel);
  const toFamily = agentIdFor(model);
  const cwd = clampToWorkspaceLock(source.config.cwd);

  let handoff;
  try {
    handoff = await handoffSession({
      fromFamily, fromSessionId: source.sessionId, fromModel,
      toFamily, toModel: model, cwd,
    });
  } catch (e) {
    console.error(`[session-mgr] Fork slot ${sourceSlotId}(${source.sessionId}) → new slot ${newSlotId} FAILED: ${e.stack || e.message}`);
    return { error: `Couldn't fork the conversation: ${e.message}. The original is untouched — retry, or start a new chat.` };
  }

  // Materialize the fork as a brand-new slot; the source keeps its own session,
  // history, and agent process entirely unchanged.
  const fork = materializeSlot(newSlotId);
  fork.config = { ...source.config, model, cwd };
  fork.sessionId = handoff.nativeSessionId;
  fork.sessionFamily = toFamily;
  fork.title = source.title || null;
  fork.totalCost = source.totalCost;
  fork.createdAt = Date.now();
  fork.history = [];

  // For CLIs whose history the cockpit owns (Codex/Gemini/OpenCode), seed the
  // protocol JSONL under the fork's new session id so it survives a restart /
  // reconnect replay. (Claude owns its own file, already written by handoff.)
  if (!supports(model, "cliOwnsHistory")) {
    appendCodexHistory(handoff.nativeSessionId, { type: "session_meta", model, cwd, timestamp: Date.now() });
  }
  // Copy the visible transcript so the fork opens showing the shared history.
  // addToHistory persists each to the protocol JSONL for non-Claude targets.
  for (const msg of source.history) addToHistory(newSlotId, structuredClone(msg));

  // Visible, persisted marker at the branch point (mirrors the handoff marker).
  addToHistory(newSlotId, {
    type: "session_event", event: "fork",
    fromSlot: sourceSlotId, fromFamily, toFamily, toModel: model,
    crossFamily: fromFamily !== toFamily, timestamp: Date.now(),
  });

  touchSlot(newSlotId);
  saveTabs();
  console.log(
    `[session-mgr] Forked slot ${sourceSlotId}(${source.sessionId}) → slot ${newSlotId}(${handoff.nativeSessionId}) — ` +
      `${fromFamily}→${toFamily}, ${source.history.length} msgs copied [csf=${handoff.csfId}]`,
  );
  return {
    newSlotId,
    sessionId: handoff.nativeSessionId,
    model,
    cwd,
    fork: { fromFamily, toFamily, toModel: model, crossFamily: fromFamily !== toFamily, csfId: handoff.csfId, stats: handoff.stats },
    history: fork.history,
  };
}

export function setCwd(slotId, dir) {
  const slot = getSlot(slotId);
  if (!slot) { console.warn(`[session-mgr] setCwd on unknown slot ${slotId} ignored`); return; }
  slot.config.cwd = clampToWorkspaceLock(dir);
  touchSlot(slotId);
  saveTabs();
}

export function setSessionId(slotId, id) {
  const slot = getSlot(slotId);
  if (!slot) { console.warn(`[session-mgr] setSessionId on unknown slot ${slotId} ignored`); return; }
  slot.sessionId = id;
  touchSlot(slotId);
  if (slotId === 0) saveSessionIdToDisk(id);
  saveTabs();
}

// Custom tab title. Persisted as slot.title, which deriveLabel returns ahead of
// any auto-derived first-message title and which survives restarts/compaction.
// An empty title clears the custom name so the label falls back to auto-derive.
// Renaming does NOT touch recency (no touchSlot) — it isn't a use of the tab.
export function renameSlot(slotId, title) {
  const slot = slots.get(slotId);
  if (!slot) return false;
  const clean = (title || "").trim().slice(0, 40);
  slot.title = clean || null;
  saveTabs();
  return true;
}

// --- Public API: agent lifecycle ---

export async function startAgent(slotId = 0) {
  const slot = getSlot(slotId);
  if (!slot) { console.warn(`[session-mgr] startAgent on unknown slot ${slotId} refused`); return; }
  if (slot.agent) return; // already running

  let savedSession = slot.sessionId || (slotId === 0 ? loadSessionIdFromDisk() : null);
  const { model, cwd } = slot.config;

  // Backstop: never resume a session we can't safely continue. Drop the saved
  // session and start fresh — instead of failing loudly on every turn — when:
  //  - Cross-family pairing: session IDs are agent-family-specific (Codex thread
  //    IDs ≠ Claude UUIDs ≠ OpenCode ses_…). A mismatch — caused by model
  //    switches, restored tab state, or stale-agent events — makes
  //    `<cli> --resume <id>` fail with "No conversation found".
  //  - Missing Claude transcript: for a Claude model, findSessionFile reliably
  //    searches ~/.claude/projects, so an unclassifiable id (familyOfSession
  //    null → no JSONL on disk) means `claude --resume <id>` will fail with "No
  //    conversation found" on every message and hang the chat. We only apply
  //    this to Claude: Codex/OpenCode may store rollouts outside our search
  //    path, so a null family there is not proof the session is gone.
  if (savedSession) {
    // Prefer the slot's recorded family (authoritative, set on init/handoff);
    // fall back to file sniffing for pre-existing tabs that predate the field.
    const sessionFamily = slot.sessionFamily || familyOfSession(savedSession);
    const modelFamily = agentIdFor(model);
    const crossFamily = sessionFamily && sessionFamily !== modelFamily;
    const missingTranscript = !sessionFamily && modelFamily === "claude";
    if (crossFamily || missingTranscript) {
      const reason = crossFamily
        ? `belongs to "${sessionFamily}" but model ${model} is "${modelFamily}"`
        : "has no Claude transcript on disk (orphaned)";
      console.warn(`[session-mgr] Slot ${slotId}: session ${savedSession} ${reason} — dropping orphaned session, starting fresh`);
      savedSession = null;
      slot.sessionId = null;
      slot.sessionFamily = null;
      if (slotId === 0) saveSessionIdToDisk(null);
      saveTabs();
    }
  }

  let agent;
  if (_agentFactory) {
    agent = _agentFactory({ sessionId: savedSession, model, cwd });
  } else {
    const AgentClass = await loadAdapterClass(model);
    agent = new AgentClass({ sessionId: savedSession, model, cwd, env: getCliEnv(cwd) });
  }
  console.log(`[session-mgr] Slot ${slotId}: starting ${agent.constructor.name} (session=${savedSession || "new"}, model=${model})`);

  slot.agent = agent;
  wireAgentEvents(slotId, agent);
  agent.start();
}

export function stopAgent(slotId = 0) {
  const slot = getSlot(slotId);
  if (!slot) return;
  if (slot.agent) slot.agent.stop();
  slot.agent = null;
  slot.isGenerating = false;
  slot.streamingText = "";
}

export function stopAllAgents() {
  for (const [id] of slots) stopAgent(id);
}

export function interruptAgent(slotId = 0) {
  const slot = getSlot(slotId);
  if (slot?.agent) slot.agent.interrupt();
}

export async function sendMessage(slotId, content, { isWatchdogResend = false } = {}) {
  const slot = getSlot(slotId);
  if (!slot) { console.warn(`[session-mgr] sendMessage on unknown slot ${slotId} refused`); return false; }
  if (!slot.agent) {
    console.warn(`[session-mgr] Slot ${slotId}: no active agent, cannot send`);
    return false;
  }
  // If the SDK is in a broken or dead state, kill the adapter so startAgent creates a fresh one
  if (slot.agent.isBroken || slot.agent.isDead) {
    console.log(`[session-mgr] Slot ${slotId}: restarting ${slot.agent.isBroken ? 'broken' : 'dead'} agent`);
    stopAgent(slotId);
    await startAgent(slotId);
  }
  slot.lastSentContent = content;
  if (!isWatchdogResend) slot.watchdogRestarts = 0;
  touchSlot(slotId);
  // Mark the slot generating at DISPATCH, not on the agent's first event. The
  // adapters only flip isGenerating on `init`/`text_delta`/`tool_start`, which
  // for a slow-to-first-token agent (Codex/GPT reasoning) can be many seconds
  // away. Any buildStatus() broadcast in that gap (the 30s availability poll,
  // another tab's model/cost event, a reconnect) would otherwise report this
  // slot as idle, and the client's status reconciliation would tear down the
  // live Stop button + running-tab dot mid-request (SHE-90/SHE-88/SHE-89).
  slot.isGenerating = true;
  slot.agent.sendMessage(content);
  return true;
}

// --- Public API: session operations ---

export function resetSlot(slotId) {
  const slot = getSlot(slotId);
  if (!slot) { console.warn(`[session-mgr] resetSlot on unknown slot ${slotId} refused — closed on another device?`); return false; }
  stopAgent(slotId);
  slot.sessionId = null;
  slot.sessionFamily = null;
  slot.history = [];
  slot.title = null;
  slot.totalCost = 0;
  slot.isGenerating = false;
  slot.streamingText = "";
  if (slotId === 0) {
    saveSessionIdToDisk(null);
  }
  saveTabs();
}

export function resumeSession(slotId, sessionId) {
  const sessions = listSessions();
  const target = sessions.find(s => s.sessionId === sessionId);
  if (!target) return { error: "Session not found" };

  const slot = getSlot(slotId);
  if (!slot) return { error: "This tab no longer exists — it was closed on another device." };
  stopAgent(slotId);

  // Switch cwd to match session's workspace (clamped: a resumed session must
  // not tunnel a locked guest cockpit out of its workspace)
  const sessionCwd = clampToWorkspaceLock(target.cwd || cwdFromSessionPath(target.path));
  slot.config.cwd = sessionCwd;

  // Restore model from session metadata
  if (target.model) slot.config.model = target.model;

  slot.sessionId = sessionId;
  slot.sessionFamily = agentIdFor(slot.config.model);
  touchSlot(slotId);
  if (slotId === 0) saveSessionIdToDisk(sessionId);

  // Read history from JSONL and convert to protocol format
  const replayMessages = readSessionForReplay(target.path);
  slot.history = replayMessages;
  slot.totalCost = extractCostFromHistory(replayMessages);

  saveTabs();
  return { cwd: sessionCwd, model: target.model };
}

/**
 * Reload a slot's history, cost, and label from the session file on disk.
 * Used after console mode (PTY) where turns happen outside SessionManager.
 */
export function refreshSlotFromDisk(slotId) {
  const slot = getSlot(slotId);
  if (!slot?.sessionId) return;

  const sessionFile = findSessionFile(slot.sessionId);
  if (!sessionFile) return;

  const freshMessages = readSessionForReplay(sessionFile);
  slot.history = freshMessages;
  slot.totalCost = extractCostFromHistory(freshMessages);

  saveTabs();
  console.log(`[session-mgr] Slot ${slotId}: refreshed from disk (${freshMessages.length} messages, cost=${slot.totalCost})`);
  return freshMessages;
}

export function rewindSlot(slotId, count = 1) {
  const slot = getSlot(slotId);
  if (!slot?.sessionId) return { error: "No active session" };
  if (slot.isGenerating) return { error: "Cannot rewind while generating" };
  if (!supports(slot.config.model, "rewind")) return { error: "Rewind is not supported for this model. Start a new session instead." };

  const sessionFile = findSessionFile(slot.sessionId);
  if (!sessionFile) return { error: "Session file not found" };

  // Truncate the JSONL file
  const fileUserText = truncateSessionFile(sessionFile, count);

  // Stop agent so it restarts with truncated context
  stopAgent(slotId);

  // Trim local history
  const histUserText = rewindHistory(slotId, count);

  return { userText: histUserText || fileUserText || "" };
}

function rewindHistory(slotId, count = 1) {
  const slot = slots.get(slotId);
  if (!slot) return "";
  const history = slot.history;
  let removed = 0;
  let userText = "";

  while (history.length > 0 && removed < count) {
    // Remove trailing turn_done/result/assistant/tool messages
    while (history.length > 0) {
      const last = history[history.length - 1];
      if (last.type === "turn_done" || last.type === "result" ||
          last.type === "text_done" || last.type === "tool_start" ||
          last.type === "tool_input" || last.type === "tool_result" ||
          last.type === "ask_user" || last.type === "plan_start" ||
          last.type === "plan_done" || last.type === "subagent_done" ||
          last.type === "assistant") {
        history.pop();
      } else {
        break;
      }
    }
    // Remove the user message
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last.type === "user_message") {
        const msg = history.pop();
        userText = msg.content || "";
        removed++;
      } else {
        break;
      }
    }
  }

  return userText;
}

export async function compactSlot(slotId) {
  const slot = getSlot(slotId);
  if (!slot?.sessionId) return { error: "No active session" };

  stopAgent(slotId);
  await startAgent(slotId);
  await sendMessage(slotId, "/compact");
  return {};
}

// --- Public API: replay state to a new socket ---

export function replayStateToSocket(ws, shouldIncludeSlot = () => true) {
  for (const [id, slot] of slots) {
    if (!shouldIncludeSlot(id)) continue;
    if (slot.isGenerating && slot.streamingText) {
      ws.send(JSON.stringify({
        type: "streaming_catchup",
        text: slot.streamingText,
        slot: id,
      }));
    }
  }
}

// --- Agent event wiring ---

function wireAgentEvents(slotId, agent) {
  const slot = getSlot(slotId);
  if (!slot) return;

  // Stale-agent guard: once an agent is stopped/replaced (slot.agent points
  // elsewhere), its late events must NOT mutate slot state or trigger restarts.
  // Without this, a killed Codex process's trailing `init`/`turn_done` could
  // re-pin a Codex session ID onto a slot whose model was switched to Claude,
  // producing an unresumable cross-family pairing.
  const on = (event, handler) => agent.on(event, (data) => {
    if (slot.agent !== agent) return;
    handler(data);
  });

  on("init", (data) => {
    touchSlot(slotId);
    if (data.sessionId) {
      const isNew = !slot.sessionId;
      slot.sessionId = data.sessionId;
      slot.sessionFamily = agentIdFor(slot.config.model);
      if (slotId === 0) saveSessionIdToDisk(slot.sessionId);
      saveTabs();
      // For agents whose CLI does not persist history itself (Codex/Gemini/OpenCode),
      // write a metadata line + retroactively persist any history accumulated before sessionId was set.
      if (isNew && !supports(slot.config.model, "cliOwnsHistory")) {
        appendCodexHistory(data.sessionId, {
          type: "session_meta",
          model: slot.config.model,
          cwd: slot.config.cwd,
          timestamp: Date.now(),
        });
        for (const msg of slot.history) appendCodexHistory(data.sessionId, msg);
      }
    }
    apiKeySource = data.apiKeySource || apiKeySource;
    slot.isGenerating = true;
    slotBroadcast(slotId, "init", data);
  });

  on("text_delta", (data) => {
    touchSlot(slotId);
    slot.isGenerating = true;
    slot.streamingText += data.text;
    slotBroadcast(slotId, "text_delta", data);
  });

  on("text_done", (data) => {
    touchSlot(slotId);
    slot.streamingText = "";
    addToHistory(slotId, { type: "text_done", text: data.text });
    slotBroadcast(slotId, "text_done", data);
  });

  on("tool_start", (data) => {
    touchSlot(slotId);
    slot.isGenerating = true;
    addToHistory(slotId, { type: "tool_start", id: data.id, name: data.name });
    slotBroadcast(slotId, "tool_start", data);
  });

  on("tool_input", (data) => {
    touchSlot(slotId);
    addToHistory(slotId, { type: "tool_input", id: data.id, input: data.input });
    slotBroadcast(slotId, "tool_input", data);
  });

  on("tool_result", (data) => {
    touchSlot(slotId);
    addToHistory(slotId, { type: "tool_result", id: data.id, content: data.content, is_error: data.is_error });
    slotBroadcast(slotId, "tool_result", data);
  });

  on("ask_user", (data) => {
    touchSlot(slotId);
    addToHistory(slotId, { type: "ask_user", id: data.id, questions: data.questions });
    slotBroadcast(slotId, "ask_user", data);
  });

  on("plan_start", (data) => {
    touchSlot(slotId);
    addToHistory(slotId, { type: "plan_start" });
    slotBroadcast(slotId, "plan_start", data);
  });

  on("plan_done", (data) => {
    touchSlot(slotId);
    addToHistory(slotId, { type: "plan_done", plan: data.plan });
    slotBroadcast(slotId, "plan_done", data);
  });

  on("subagent_progress", (data) => {
    slotBroadcast(slotId, "subagent_progress", data);
  });

  on("subagent_done", (data) => {
    touchSlot(slotId);
    addToHistory(slotId, { type: "subagent_done", parent_id: data.parent_id, steps: data.steps });
    slotBroadcast(slotId, "subagent_done", data);
  });

  on("turn_done", (data) => {
    touchSlot(slotId);
    const wasGenerating = slot.isGenerating;
    slot.isGenerating = false;
    slot.streamingText = "";
    if (data.cost !== undefined) slot.totalCost = data.cost;
    // Clear lastSentContent on normal completion (not watchdog) so stale messages aren't resent
    if (data.subtype !== "watchdog_timeout") slot.lastSentContent = null;
    addToHistory(slotId, { type: "turn_done", cost: data.cost, usage: data.usage,
      context_window: data.context_window,
      is_error: data.is_error, errors: data.errors, subtype: data.subtype });
    slotBroadcast(slotId, "turn_done", data);

    // Auto-restart on watchdog timeout: resume session and resend last message
    if (data.subtype === "watchdog_timeout") {
      if (!wasGenerating) {
        // Idle watchdog misfire — no turn was in flight, so there is nothing
        // to recover. Restarting here tears down a healthy session and burns
        // the retry budget down to the give-up error (SHE-69).
        console.log(`[session-mgr] Slot ${slotId}: watchdog fired while idle — ignoring`);
        return;
      }
      slot.watchdogRestarts = (slot.watchdogRestarts || 0) + 1;
      if (slot.watchdogRestarts > MAX_WATCHDOG_RESTARTS) {
        console.log(`[session-mgr] Slot ${slotId}: watchdog restart limit (${MAX_WATCHDOG_RESTARTS}) reached — giving up`);
        slot.lastSentContent = null;
        slotBroadcast(slotId, "error", {
          message: "The agent became unresponsive and could not recover after retrying. Please start a new chat or resend your message.",
        });
        return;
      }
      const lastContent = slot.lastSentContent;
      console.log(`[session-mgr] Slot ${slotId}: watchdog timeout — auto-restarting (attempt ${slot.watchdogRestarts}/${MAX_WATCHDOG_RESTARTS})`);
      stopAgent(slotId);
      startAgent(slotId).then(() => {
        if (wasGenerating && lastContent) {
          console.log(`[session-mgr] Slot ${slotId}: resending last user message after watchdog restart`);
          sendMessage(slotId, lastContent, { isWatchdogResend: true });
        }
      });
    }
  });

  on("error", (data) => {
    slotBroadcast(slotId, "error", data);
  });

  on("session_event", (data) => {
    touchSlot(slotId);
    if (data.event === "compacted") {
      // Trim history: keep only last 3 messages + a compact marker
      const kept = slot.history.slice(-3);
      slot.history = [{ type: "session_event", event: "compacted", timestamp: Date.now() }, ...kept];
      // Session stays alive — compaction compresses context in-place, not a reset.
      saveTabs();
    }
    slotBroadcast(slotId, "session_event", data);
  });
}

// --- History management ---

function addToHistory(slotId, msg) {
  const slot = slots.get(slotId);
  if (!slot) return;
  // Capture the stable tab title from the first real user message (see
  // deriveLabel) and persist it so it survives restarts and compaction.
  // Internal envelopes never title a tab.
  if (!slot.title && msg.type === "user_message" && msg.content && !msg.internal) {
    slot.title = truncateTitle(msg.content);
    saveTabs();
  }
  slot.history.push(msg);
  if (slot.history.length > MAX_HISTORY) {
    slot.history = slot.history.slice(-MAX_HISTORY);
  }
  if (!slot.sessionId) return;
  // Persist history ourselves for agents whose CLI does not (Codex/Gemini/OpenCode).
  if (!supports(slot.config.model, "cliOwnsHistory")) {
    appendCodexHistory(slot.sessionId, msg);
  } else if (msg.type === "session_event") {
    // Claude owns its native transcript, but our lineage markers (handoff/fork)
    // aren't in it — persist them so they survive a reconnect replay too.
    appendClaudeSessionMarker(slot.sessionId, msg);
  }
}

function appendCodexHistory(threadId, msg) {
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
  appendFileSync(join(CODEX_HISTORY_DIR, `${threadId}.jsonl`), JSON.stringify(msg) + "\n");
}

/**
 * Add a user message to history (called by server before sending to agent).
 * Injected turns the human did not type — async task notifications, delegated
 * tasks, command echoes — are tagged internal (explicitly via opts or by the
 * shared envelope classifier) so the UI never renders them as the user's own
 * bubble (SHE-65). The tag persists, so replays and handoffs stay classified.
 */
export function addUserMessage(slotId, content, { internal = false } = {}) {
  touchSlot(slotId);
  addToHistory(slotId, {
    type: "user_message",
    content,
    timestamp: Date.now(),
    ...((internal || isInternalUserContent(content)) ? { internal: true } : {}),
  });
}

export function pruneStaleSlots(maxAgeDays) {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const removed = [];
  for (const [id, slot] of [...slots.entries()]) {
    if (id === 0) continue;
    if (slot.isGenerating) continue;
    if (!slot.lastUsedAt || slot.lastUsedAt >= cutoff) continue;
    if (slot.agent) slot.agent.stop();
    slots.delete(id);
    removed.push({ id, sessionId: slot.sessionId || null });
  }
  if (removed.length > 0) saveTabs();
  return { removed, kept: slots.size };
}

export function setSlotLastUsedAt(slotId, timestamp) {
  const slot = getSlot(slotId);
  if (slot) slot.lastUsedAt = timestamp;
}

/** Test-only: inject a mock agent into a slot and wire its events. */
export function _testInjectAgent(slotId, agent) {
  const slot = materializeSlot(slotId);
  if (slot.agent) slot.agent.stop();
  slot.agent = agent;
  wireAgentEvents(slotId, agent);
}

/** Test-only: override agent creation so startAgent() doesn't spawn real CLI processes. */
export function _testSetAgentFactory(factory) {
  _agentFactory = factory;
}

// --- Tab state persistence ---

function writeTabsNow() {
  const data = [...slots.entries()].map(([id, s]) => ({
    id,
    sessionId: s.sessionId,
    sessionFamily: s.sessionFamily || null,
    title: s.title || null,
    createdAt: s.createdAt || Date.now(),
    lastUsedAt: s.lastUsedAt || Date.now(),
    ...s.config,
  }));
  try { writeFileSync(TABS_FILE, JSON.stringify(data)); }
  catch (e) { console.error("[session-mgr] Failed to save tab state:", e.message); }
}

function saveTabs() {
  if (saveTabsTimer) clearTimeout(saveTabsTimer);
  saveTabsTimer = setTimeout(writeTabsNow, 300);
}

/**
 * Flush the debounced tab save synchronously. Called on graceful shutdown so a
 * tab created/closed within the 300 ms debounce window still survives the
 * restart — the client must never need to resurrect tabs the server forgot.
 */
export function flushTabs() {
  // Only when a save is actually pending: an unconditional write could clobber
  // TABS_FILE with pre-restore state on a very early shutdown.
  if (!saveTabsTimer) return;
  clearTimeout(saveTabsTimer);
  saveTabsTimer = null;
  writeTabsNow();
}

/**
 * Correct a restored slot's cwd to match where its session actually lives.
 * Claude encodes cwd in the session file path; Codex stores it in session_meta.
 * Either way the session's own record — not the persisted tab or a stale
 * frontend value — is the authoritative workspace for that conversation.
 */
function correctCwdFromSession(slot, sessionFile, sessionId, slotId) {
  const recordedCwd = sessionFile.startsWith(CODEX_HISTORY_DIR)
    ? codexSessionCwd(sessionId)
    : cwdFromSessionPath(sessionFile);
  const sessionCwd = recordedCwd ? clampToWorkspaceLock(recordedCwd) : recordedCwd;
  if (sessionCwd && sessionCwd !== slot.config.cwd) {
    console.log(`[session-mgr] Slot ${slotId}: correcting cwd from ${slot.config.cwd} to ${sessionCwd}`);
    slot.config.cwd = sessionCwd;
  }
}

export function restoreSlots() {
  if (!existsSync(TABS_FILE)) return;
  let saved;
  try { saved = JSON.parse(readFileSync(TABS_FILE, "utf8")); }
  catch (e) {
    // A corrupt tabs file must not silently eat every saved tab — keep the
    // evidence and start fresh.
    console.error(`[session-mgr] Corrupt tab state ${TABS_FILE}: ${e.message} — backing up to .corrupt and starting fresh`);
    try { renameSync(TABS_FILE, TABS_FILE + ".corrupt"); } catch {}
    return;
  }
  if (!Array.isArray(saved)) return;

  const savedIds = new Set(saved.map((s) => s.id));

  for (const s of saved) {
    const slot = materializeSlot(s.id);
    if (s.model) slot.config.model = s.model;
    if (s.cwd) slot.config.cwd = clampToWorkspaceLock(s.cwd);
    slot.sessionId = s.sessionId || null;
    slot.sessionFamily = s.sessionFamily || null;
    slot.title = s.title || null;
    slot.createdAt = s.createdAt || slot.createdAt || Date.now();
    slot.lastUsedAt = s.lastUsedAt || Date.now();

    // Load history and correct cwd from the session's authoritative record
    if (s.sessionId) {
      const sessionFile = findSessionFile(s.sessionId);
      if (sessionFile) {
        correctCwdFromSession(slot, sessionFile, s.sessionId, s.id);
        slot.history = readSessionForReplay(sessionFile);
        slot.totalCost = extractCostFromHistory(slot.history);
      }
    }
  }

  // Restore slot 0's session from its dedicated legacy file ONLY when slot 0 was
  // an actual saved tab. If the user had closed slot 0 (absent from `saved`), it
  // must stay closed — resurrecting it here, or leaving the pristine slot 0 that
  // the module-load `materializeSlot(0)` created, was a path for the closed tab to
  // reappear after a restart (SHE-50).
  if (savedIds.has(0)) {
    const slot0 = materializeSlot(0);
    if (!slot0.sessionId) {
      slot0.sessionId = loadSessionIdFromDisk();
    }
    if (slot0.sessionId && slot0.history.length === 0) {
      const sessionFile = findSessionFile(slot0.sessionId);
      if (sessionFile) {
        correctCwdFromSession(slot0, sessionFile, slot0.sessionId, 0);
        slot0.history = readSessionForReplay(sessionFile);
      }
    }
  } else if (slots.size > 1) {
    // Drop the empty slot 0 left by the startup `materializeSlot(0)` — the user had
    // other tabs and never kept slot 0. Only when it's pristine (no session, no
    // history), never when it holds a live conversation.
    const s0 = slots.get(0);
    if (s0 && !s0.sessionId && s0.history.length === 0) slots.delete(0);
  }

  // Honor the persisted tab ORDER (drag-reordering, SHE-75): the module-load
  // `materializeSlot(0)` inserted slot 0 first regardless of where the user dragged it,
  // and slot 0's session is restored above rather than via the ordered loop, so
  // re-lay the Map in the saved file order before the first snapshot goes out.
  _applyOrder(saved.map((s) => s.id));

  console.log(`[session-mgr] Restored ${saved.length} tab(s) from saved state`);
}

// --- Session ID disk persistence (slot 0 only) ---

function loadSessionIdFromDisk() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    return data.sessionId || null;
  } catch { return null; }
}

function saveSessionIdToDisk(id) {
  writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id || null }));
}

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";

// Process group of `pid` (field 5 of /proc/<pid>/stat), or null once it exited.
function processGroupOf(pid) {
  let stat;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; }
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
}

// Process groups of every live descendant of `pid`. Tools a CLI starts in
// their own session (OpenCode's bash tool calls setsid) leave the CLI's group,
// so signalling that group alone orphans them (SHE-119).
function descendantGroups(pid) {
  const groups = new Set();
  const stack = [pid];
  while (stack.length) {
    const parent = stack.pop();
    let tasks;
    try { tasks = readdirSync(`/proc/${parent}/task`); } catch { continue; }  // exited
    for (const task of tasks) {
      let children;
      try { children = readFileSync(`/proc/${parent}/task/${task}/children`, "utf8"); } catch { continue; }
      for (const child of children.split(" ").filter(Boolean).map(Number)) {
        stack.push(child);
        const group = processGroupOf(child);
        if (group) groups.add(group);
      }
    }
  }
  return groups;
}

/**
 * Abstract base class for coding agents.
 *
 * Subclasses implement start/sendMessage/interrupt/stop and emit
 * protocol events that the SessionManager forwards to WebSocket clients.
 *
 * Events emitted (all include the data object as first argument):
 *   init          { sessionId }
 *   text_delta    { text }
 *   text_done     { text }
 *   tool_start    { id, name }
 *   tool_input    { id, input }
 *   tool_result   { id, content, is_error? }
 *   ask_user      { id, questions[] }
 *   plan_start    {}
 *   plan_done     { plan }
 *   subagent_progress { parent_id, step }
 *   subagent_done { parent_id, steps }
 *   turn_done     { cost?, usage?, is_error?, errors? }
 *   error         { message }
 *   session_event { event } (compacted, resumed, etc.)
 */
export class CodingAgent extends EventEmitter {
  constructor({ sessionId, model, cwd, env }) {
    super();
    this._sessionId = sessionId || null;
    this._model = model;
    // Ensure cwd exists — spawn() throws ENOENT if the directory is missing
    if (cwd && !existsSync(cwd)) {
      mkdirSync(cwd, { recursive: true });
      console.log(`[coding-agent] Created missing cwd: ${cwd}`);
    }
    this._cwd = cwd;
    this._env = env;
    this._isGenerating = false;
    this._isActive = false;
    this._killTimer = null;     // pending graceful-signal → SIGKILL escalation
    this._interrupted = false;  // Stop pressed: subclasses drop further output
    this._queued = [];          // messages sent mid-turn, run once it settles
    // Has the CLI said anything since its process got this turn's message?
    // undefined = the adapter can't tell (a CLI that prints only at the end).
    this._turnHeard = undefined;
  }

  /** Start the agent process/query. */
  start() {
    throw new Error("start() must be implemented by subclass");
  }

  /** Send a user message (string or content blocks array). */
  sendMessage(_content) {
    throw new Error("sendMessage() must be implemented by subclass");
  }

  /** Cancel current generation. */
  interrupt() {
    throw new Error("interrupt() must be implemented by subclass");
  }

  /** Kill the agent process. */
  stop() {
    throw new Error("stop() must be implemented by subclass");
  }

  // Messages waiting behind a turn keep the slot "working" for the UI.
  get isGenerating() { return this._isGenerating || this._queued.length > 0; }
  get sessionId() { return this._sessionId; }
  get isActive() { return this._isActive; }

  // --- Mid-turn messages for one-process-per-turn CLIs (Codex, OpenCode,
  // Antigravity) ---
  //
  // These CLIs have no stdin to hand a follow-up to: each turn is its own
  // process resuming the session. A second process spawned mid-turn runs
  // concurrently on the same session — Codex dies on the thread's writer lock
  // (SHE-107); OpenCode and Antigravity let both processes answer into one
  // conversation, and Stop only reaches the newer one (SHE-118). So a message
  // sent while a turn runs waits until that turn's process has exited, then
  // runs as its own turn: the "queued until the agent is free" a mid-turn
  // message gets with Claude Code. Subclasses implement _send(prompt), call
  // _queueIfBusy() at its top, and _drainQueue() once a process has closed.

  /** True while a turn or its process still owns the session. */
  _isBusy() { return this._isGenerating || !!this._process; }

  _queueIfBusy(prompt) {
    if (!this._isBusy()) return false;
    this._queued.push(prompt);
    console.log(`[${this.constructor.name}] turn in progress — message queued (${this._queued.length} waiting)`);
    return true;
  }

  /**
   * The turn_done for a Stop. A Stop that lands before the CLI acknowledged the
   * message kills it before the message was recorded, so it is NOT part of the
   * conversation (the agent never saw it); `undelivered` lets the chat say so
   * instead of implying it was received. `dropped` = queued or pending messages
   * the Stop discarded, which never reached the CLI either.
   */
  _interruptedTurnDone(dropped = false) {
    const undelivered = dropped ? true : this._turnHeard === undefined ? undefined : !this._turnHeard;
    return { subtype: "interrupted", undelivered };
  }

  _drainQueue() {
    if (!this._queued.length || !this._isActive || this._isBusy()) return;
    const next = this._queued.shift();
    console.log(`[${this.constructor.name}] turn settled — running the queued message (${this._queued.length} still waiting)`);
    this._send(next);
  }

  /**
   * Normalize a child-process exit for classification. CLIs that trap
   * SIGTERM/SIGINT exit with 128+signum and `signal=null` — observed: Claude
   * Code always exits code=143 on SIGTERM — which defeats `signal !==
   * "SIGTERM"` guards, so every deliberate kill (idle timeout, stop, watchdog
   * restart) painted as a red "CLI exited code=143" error (SHE-69).
   */
  _exitSignal(code, signal) {
    return signal || (code === 143 ? "SIGTERM" : code === 130 ? "SIGINT" : null);
  }

  /**
   * Human-readable message for a child-process spawn/exec failure. ENOENT (the
   * CLI binary isn't installed — the #1 fresh-box failure) gets a plain-English
   * explanation with an install hint instead of a raw errno.
   */
  _processErrorMessage(label, err, installHint) {
    if (err?.code === "ENOENT") {
      const hint = installHint ? `install it with \`${installHint}\`` : "install it";
      return `The ${label} CLI isn't installed on this box (binary not found in PATH) — ${hint}, or switch to another agent.`;
    }
    return `${label} CLI process error: ${err.message}`;
  }

  /**
   * Fail the current turn loudly: emit the error AND end the turn. A spawn
   * failure emits no `close` event, so without this the UI hangs in
   * "Working…" forever on a dead process. turn_done is emitted UNCONDITIONALLY
   * (not gated on _isGenerating): adapters only set that flag once the CLI
   * starts streaming, which a failed spawn never reaches — but the client is
   * already waiting. A spurious turn_done to an idle client is a no-op;
   * a missing one is a permanent hang.
   */
  _failTurn(message) {
    if (!this._isActive) return;
    this.emit("error", { message });
    this._isGenerating = false;
    // No errors payload: the message was just broadcast via `error` — carrying
    // it here too would render the same text twice in the conversation.
    this.emit("turn_done", { is_error: true });
  }

  /**
   * Signal the child's whole process GROUP, not just its direct PID. A CLI
   * agent (Codex/OpenCode) spawns its tools and MCP servers as child
   * processes; when spawned `detached` they share the CLI's process group, so
   * `kill(-pid)` reaps the entire tree. Killing only the parent orphaned those
   * children and the turn kept producing output after Stop (SHE-90 follow-up).
   * Requires the subclass to spawn with `detached: true`.
   */
  _killTree(proc, signal) {
    if (!proc || proc.killed || proc.pid == null) return;
    // Only a real child pid may be signalled as a group. kill(-1) is the
    // broadcast to EVERY process this user owns (it took down the systemd user
    // manager, cockpit and all, three times on 2026-09-07 via a test's fake
    // pid), and kill(-0) is the cockpit's own group. Refuse loudly.
    if (!Number.isInteger(proc.pid) || proc.pid <= 1) {
      console.error(`[agent] refusing to signal process group ${proc.pid} — not a spawned child`);
      return;
    }
    // Collect the escaped groups first: once the CLI dies its tools are
    // reparented and can no longer be found from its pid.
    const ownGroup = processGroupOf(process.pid);
    const escaped = [...descendantGroups(proc.pid)]
      .filter((g) => g > 1 && g !== proc.pid && g !== ownGroup);
    try {
      process.kill(-proc.pid, signal);   // negative pid = process group
    } catch (err) {
      if (err?.code !== "ESRCH") {
        try { proc.kill(signal); } catch { /* already dead */ }
      }
    }
    for (const group of escaped) {
      console.log(`[agent] ${signal} to tool process group ${group} (left the CLI's group)`);
      try { process.kill(-group, signal); } catch (err) {
        if (err?.code !== "ESRCH") console.warn(`[agent] could not signal group ${group}: ${err.message}`);
      }
    }
  }

  /**
   * Terminate the current turn's process tree: a graceful signal now, then
   * SIGKILL if it hasn't died within the grace window. The escalation timer
   * captures its own `proc` ref (not this._process) so a later spawn can't make
   * it kill the wrong PID; the subclass's `close` handler clears `_killTimer`,
   * closing the PID-reuse window.
   */
  _terminate(proc, firstSignal, escalateMs = 2000) {
    if (!proc) return;
    this._killTree(proc, firstSignal);
    if (!this._killTimer) {
      this._killTimer = setTimeout(() => {
        this._killTimer = null;
        this._killTree(proc, "SIGKILL");
      }, escalateMs);
    }
  }
}

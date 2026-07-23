import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";

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

  get isGenerating() { return this._isGenerating; }
  get sessionId() { return this._sessionId; }
  get isActive() { return this._isActive; }

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
    try {
      process.kill(-proc.pid, signal);   // negative pid = process group
    } catch (err) {
      if (err?.code === "ESRCH") return;  // already gone
      try { proc.kill(signal); } catch { /* already dead */ }
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

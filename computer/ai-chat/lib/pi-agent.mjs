import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { splitContent, textWithImagePaths } from "./attachments.mjs";
import { piLayer } from "./agent-layer.mjs";
import { CodingAgent } from "./coding-agent.mjs";
import { piModel } from "./model-catalog.mjs";

// Idle watchdog: the longest silence between Pi's events, while no tool is
// running, before the process is treated as wedged. Pi streams text, thinking
// and tool-call deltas as they are produced, so a healthy turn is never quiet
// for long; a running tool can be (a long build prints nothing), and is left
// to its own timeout.
const WATCHDOG_IDLE_MS = 15 * 60 * 1000;
// How long a turn's closing statistics may take before the turn ends without.
const STATS_TIMEOUT_MS = 10_000;

// Pi's built-in tools are lowercase; the cockpit renders the PascalCase names
// the Claude and Codex adapters use. MCP and extension tools pass through.
const TOOL_NAME_MAP = { bash: "Bash", read: "Read", edit: "Edit", write: "Write" };

/** The provider/model/thinking flags for a catalog model id. Throws when Pi can't run it. */
export function piModelArgs(model) {
  const m = piModel(model);
  if (!m?.upstream) throw new Error(`Model "${model}" is not one of Pi's models in config/models.json`);
  const effort = m.options?.reasoningEffort;
  return ["--provider", "shellteam", "--model", m.upstream, ...(effort ? ["--thinking", effort] : [])];
}

/** A new cockpit-minted Pi session id. The prefix tells history.mjs the family. */
export function newPiSessionId() {
  return `pi-${randomUUID()}`;
}

/**
 * PiAgent — drives `pi --mode rpc`, one long-lived process per chat.
 *
 * RPC mode (docs/rpc.md in the Pi package) takes JSON commands on stdin and
 * streams session events on stdout: text, thinking and tool-call deltas, tool
 * execution start/update/end, compaction, retries, and `agent_settled` when Pi
 * has nothing left to do. That gives the chat live text, mid-turn messages
 * read by the running turn (`streamingBehavior: "steer"`), a real abort, and
 * compaction as a command.
 *
 * The cockpit picks the session id (`pi-<uuid>`) and passes it with
 * `--session-id`, which opens that session or creates it, so a resume and a
 * first start are the same spawn.
 */
export class PiAgent extends CodingAgent {
  constructor(opts) {
    super(opts);
    this._sessionId = opts.sessionId || newPiSessionId();
    this._initEmitted = false;
    this._process = null;
    this._dead = false;
    this._streamingText = "";
    this._watchdog = null;
    this._watchdogIdleMs = WATCHDOG_IDLE_MS;
    this._statsTimeoutMs = STATS_TIMEOUT_MS;
    this._runningTools = new Set();
    this._shownTools = new Set();
    this._turnErrors = [];
    this._compacting = false;
    this._compactEmitted = false;
    this._aborting = null;
    this._runActive = false;   // Pi's run is under way (agent_start .. agent_settled)
    this._held = [];           // mid-turn messages waiting for that run to start
    this._awaiting = 0;        // queued messages Pi has not answered yet
    this._expectRuns = 0;      // queued messages Pi started a run of their own for
    this._settled = false;     // Pi settled; the turn ends once nothing is pending
    this._nextId = 1;
    this._pending = new Map();  // command id -> response handler
    this._recentStderr = "";
  }

  get streamingText() { return this._streamingText; }
  get isBroken() { return false; }
  get isDead() { return this._dead; }

  start() {
    this._isActive = true;
    let args;
    try {
      args = ["--mode", "rpc", ...piModelArgs(this._model)];
    } catch (err) {
      this._dead = true;
      console.error(`[pi-agent] ${err.message}`);
      this._failTurn(err.message);
      return;
    }
    const layer = piLayer(this._cwd);
    args.push(...layer.args, "--session-id", this._sessionId);
    console.log(`[pi-agent] spawn: pi ${args.join(" ")}`);

    const proc = spawn("pi", args, {
      cwd: this._cwd,
      env: { ...this._env, ...layer.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so stop() reaches Pi and every tool it started.
      detached: true,
    });
    this._process = proc;

    // Without this handler a spawn failure (pi not installed) is an uncaught
    // EventEmitter error that takes down the whole cockpit.
    proc.on("error", (err) => {
      console.error(`[pi-agent] process error: ${err.message}`);
      if (this._process === proc) this._process = null;
      this._dead = true;
      this._failTurn(this._processErrorMessage("Pi", err, "npm install -g @earendil-works/pi-coding-agent"));
    });
    proc.stdin.on("error", (err) => console.error(`[pi-agent] stdin: ${err.message}`));

    // Records are split on LF only: Unicode line separators are valid inside
    // Pi's JSON strings (docs/json.md), and setEncoding keeps a multi-byte
    // character split across two chunks whole.
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        this._processLine(line);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (text) => {
      this._recentStderr = (this._recentStderr + text).slice(-2000);
      const t = text.trim();
      if (t) console.error(`[pi-agent] stderr: ${t}`);
    });

    proc.on("close", (code, signal) => {
      if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
      if (this._process !== proc) return;  // a stop() already let go of it
      if (buffer.trim()) this._processLine(buffer);
      this._process = null;
      this._dead = true;
      this._clearWatchdog();
      for (const reject of this._pending.values()) reject(new Error("Pi exited"));
      this._pending.clear();
      console.log(`[pi-agent] exited code=${code} signal=${signal}`);
      if (this._isGenerating) {
        const watchdog = this._watchdogTriggered;
        const reason = this._recentStderr.trim().split("\n").filter(Boolean).pop();
        const message = watchdog
          ? null
          : `Pi exited unexpectedly (code=${code} signal=${signal})${reason ? `: ${reason}` : ""}`;
        if (message) this.emit("error", { message });
        this._endTurn(watchdog ? { subtype: "watchdog_timeout" } : { is_error: true });
      }
    });
  }

  sendMessage(content) {
    this._send(textWithImagePaths(splitContent(content)));
  }

  _send(prompt) {
    if (this._aborting) {
      this._aborting.then(() => this._send(prompt));
      return;
    }
    if (!this._process) {
      this._failTurn("Pi is not running for this chat. Send the message again to restart it.");
      return;
    }
    if (!this._initEmitted) {
      this._initEmitted = true;
      this.emit("init", { sessionId: this._sessionId, apiKeySource: "env" });
    }
    if (prompt.trim() === "/compact") {
      this._compact();
      return;
    }
    if (!this._isGenerating) {
      this._beginTurn();
      this._prompt(prompt);
    } else if (this._runActive) {
      // A mid-turn message is read by the running turn, after its current tool
      // calls (SHE-126, as Codex steers): same process, Stop still reaches it.
      this._prompt(prompt, "steer");
    } else {
      // Pi has accepted the turn's prompt but its run has not started: a
      // queued prompt now becomes a run of its own that settles at once and is
      // never answered (seen live, 16 Nov 2026). Held until the run starts.
      this._held.push(prompt);
    }
  }

  _prompt(message, streamingBehavior) {
    // A queued message (steer/followUp) keeps the turn open until Pi answers
    // it, and if Pi starts a run of its own for it, until that run settles.
    if (streamingBehavior) this._awaiting++;
    this._command({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) }, (res) => {
      if (!streamingBehavior) return;
      this._awaiting--;
      if (res?.success && res.data?.disposition === "started") this._expectRuns++;
      this._maybeFinish();
    })
      .then((data) => {
        if (data?.disposition === "handled" && !streamingBehavior) this._finishTurn();
      })
      .catch((err) => {
        console.error(`[pi-agent] prompt refused: ${err.message}`);
        this.emit("error", { message: `Pi refused the message: ${err.message}` });
        if (!streamingBehavior) this._endTurn({ is_error: true });
      });
  }

  // Pi's run started. Messages held meanwhile were sent before Pi read the
  // first one: separate requests, each answered in turn (followUp), as Codex
  // does with a burst; steering is for a message sent while Pi works.
  _onRunStart() {
    this._runActive = true;
    this._settled = false;
    if (this._expectRuns) this._expectRuns--;
    for (const message of this._held.splice(0)) this._prompt(message, "followUp");
  }

  // Pi has nothing left to do. A message held while its run was ending starts
  // the next run, in the same turn; otherwise the turn ends once no queued
  // message is still waiting for Pi's answer or for a run of its own.
  _onRunSettled() {
    this._runActive = false;
    if (this._held.length) {
      this._prompt(this._held.shift());
      return;
    }
    if (this._compacting) return;
    this._settled = true;
    this._maybeFinish();
  }

  _maybeFinish() {
    if (!this._settled || this._runActive || this._awaiting || this._expectRuns) return;
    this._settled = false;
    this._finishTurn();
  }

  _compact() {
    if (this._isGenerating) {
      this.emit("error", { message: "Pi is busy: compact once the current turn is done." });
      return;
    }
    this._beginTurn();
    this._compacting = true;
    this._compactEmitted = false;
    this._command({ type: "compact" })
      .then((data) => {
        if (!this._compactEmitted) this._emitCompacted(data?.summary);
        this._finishTurn();
      })
      .catch((err) => {
        // A chat too short to summarize has nothing to compact: that is done,
        // not failed (Compact & send then simply sends).
        if (/nothing to compact/i.test(err.message)) {
          console.log(`[pi-agent] compact: ${err.message}`);
          this._finishTurn();
          return;
        }
        this.emit("error", { message: `Compaction failed: ${err.message}` });
        this._endTurn({ is_error: true });
      })
      .finally(() => { this._compacting = false; });
  }

  interrupt() {
    if (!this._isGenerating) return;
    // Drop whatever Pi still prints for this turn, empty its queue of
    // follow-ups, and abort the run. The turn ends now for the chat.
    this._interrupted = true;
    this._held = [];
    this._runActive = false;
    this._awaiting = 0;
    this._expectRuns = 0;
    this._settled = false;
    this._command({ type: "clear_queue" })
      .catch((err) => console.warn(`[pi-agent] clear_queue: ${err.message}`));
    // Pi answers `abort` once the session is idle, after the aborted run's
    // last event: until then a new message would be counted in the old run.
    this._aborting = this._command({ type: "abort" })
      .catch((err) => console.warn(`[pi-agent] abort: ${err.message}`))
      .finally(() => { this._aborting = null; this._interrupted = false; });
    this._endTurn(this._interruptedTurnDone(false));
  }

  stop() {
    this._clearWatchdog();
    this._isActive = false;
    this._isGenerating = false;
    this._streamingText = "";
    const proc = this._process;
    this._process = null;
    if (proc) {
      // Closing stdin asks Pi for an orderly shutdown; the group signal makes
      // sure its tools go too.
      try { proc.stdin.end(); } catch { /* already closed */ }
      this._terminate(proc, "SIGTERM");
    }
  }

  // --- RPC plumbing ---

  // `onResponse` runs synchronously when Pi's answer is read, before any event
  // that follows it on the same chunk (a promise callback would run after).
  _command(cmd, onResponse) {
    const id = `c${this._nextId++}`;
    return new Promise((resolve, reject) => {
      if (!this._process) { onResponse?.(null); reject(new Error("Pi is not running")); return; }
      this._pending.set(id, (res) => {
        onResponse?.(res instanceof Error ? null : res);
        if (res instanceof Error) reject(res);
        else if (res.success) resolve(res.data);
        else reject(new Error(res.error || `${cmd.type} failed`));
      });
      this._process.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
    });
  }

  _processLine(line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      console.warn(`[pi-agent] unparseable: ${line.slice(0, 200)}`);
      return;
    }
    if (event.type === "response") {
      const handler = this._pending.get(event.id);
      if (handler) { this._pending.delete(event.id); handler(event); }
      else if (!event.success) console.warn(`[pi-agent] ${event.command} failed: ${event.error}`);
      return;
    }
    if (this._isGenerating) this._resetWatchdog();
    // After a Stop the turn is over for the chat; Pi winds down on its own.
    if (this._interrupted) return;
    this._translate(event);
  }

  _translate(event) {
    switch (event.type) {
      case "message_update":
        this._onMessageUpdate(event.assistantMessageEvent || {});
        break;

      case "message_end": {
        const msg = event.message || {};
        if (msg.role === "assistant" && msg.stopReason === "error" && msg.errorMessage) {
          this._turnErrors.push(msg.errorMessage);
        }
        break;
      }

      case "tool_execution_start": {
        this._runningTools.add(event.toolCallId);
        this._showTool(event.toolCallId, event.toolName, event.args);
        break;
      }

      case "tool_execution_end": {
        this._runningTools.delete(event.toolCallId);
        this._showTool(event.toolCallId, event.toolName, event.args);
        this.emit("tool_result", {
          id: event.toolCallId,
          content: toolText(event.result),
          ...(event.isError ? { is_error: true } : {}),
        });
        break;
      }

      case "compaction_end":
        if (event.result) this._emitCompacted(event.result.summary);
        else if (event.errorMessage) console.warn(`[pi-agent] compaction failed: ${event.errorMessage}`);
        break;

      case "auto_retry_start":
        console.warn(`[pi-agent] retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`);
        break;

      case "auto_retry_end":
        if (!event.success && event.finalError) this._turnErrors.push(event.finalError);
        break;

      case "agent_start":
        this._onRunStart();
        break;

      case "agent_settled":
        this._onRunSettled();
        break;

      case "extension_error":
        console.error(`[pi-agent] extension ${event.extensionPath} failed on ${event.event}: ${event.error}`);
        this._turnErrors.push(`ShellTeam's Pi extension failed: ${event.error}`);
        break;

      default:
        break;  // turn_start/end, queue_update, ... carry nothing the chat shows
    }
  }

  _onMessageUpdate(ev) {
    switch (ev.type) {
      case "text_delta":
        if (ev.delta) {
          this._streamingText += ev.delta;
          this.emit("text_delta", { text: ev.delta });
        }
        break;
      case "text_end": {
        const text = typeof ev.content === "string" ? ev.content : this._streamingText;
        this._streamingText = "";
        if (text) this.emit("text_done", { text });
        break;
      }
      case "toolcall_end":
        if (ev.toolCall?.id) this._showTool(ev.toolCall.id, ev.toolCall.name, ev.toolCall.arguments);
        break;
      default:
        break;  // thinking is not shown in the chat; it keeps the watchdog fed
    }
  }

  _showTool(id, rawName, args) {
    if (!id || this._shownTools.has(id)) return;
    this._shownTools.add(id);
    this.emit("tool_start", { id, name: TOOL_NAME_MAP[rawName] ?? rawName ?? "tool" });
    this.emit("tool_input", { id, input: args || {} });
  }

  _emitCompacted(summary) {
    this._compactEmitted = true;
    this.emit("session_event", { event: "compacted", ...(summary ? { summary } : {}) });
  }

  // --- Turn lifecycle ---

  _beginTurn() {
    this._isGenerating = true;
    this._settled = false;
    this._awaiting = 0;
    this._expectRuns = 0;
    this._interrupted = false;
    this._turnErrors = [];
    this._streamingText = "";
    this._shownTools.clear();
    this._runningTools.clear();
    this._watchdogTriggered = false;
    this._resetWatchdog();
  }

  // Pi has nothing left to do: close the turn with the session's cost and the
  // context it now holds (get_session_stats), so the meter and the spend are
  // Pi's own numbers.
  _finishTurn() {
    if (!this._isGenerating) return;
    const errors = this._turnErrors;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), this._statsTimeoutMs));
    Promise.race([this._command({ type: "get_session_stats" }), timeout])
      .catch((err) => { console.warn(`[pi-agent] session stats unavailable: ${err.message}`); return null; })
      .then((stats) => {
        if (stats === null) console.warn("[pi-agent] no session stats for this turn: cost and context meter not updated");
        const tokens = stats?.contextUsage?.tokens;
        this._endTurn({
          ...(errors.length ? { is_error: true, errors } : {}),
          ...(typeof stats?.cost === "number" ? { cost: stats.cost } : {}),
          ...(typeof tokens === "number" ? { usage: { input_tokens: tokens } } : {}),
          ...(stats?.contextUsage?.contextWindow ? { context_window: stats.contextUsage.contextWindow } : {}),
        });
      });
  }

  _endTurn(result) {
    if (!this._isGenerating) return;
    this._clearWatchdog();
    this._isGenerating = false;
    this._streamingText = "";
    this.emit("turn_done", result);
  }

  _resetWatchdog() {
    this._clearWatchdog();
    if (!this._isActive) return;
    this._watchdog = setTimeout(() => {
      if (!this._isActive || !this._isGenerating) return;
      if (this._runningTools.size) { this._resetWatchdog(); return; }
      console.error(`[pi-agent] watchdog: no event for ${this._watchdogIdleMs / 1000}s, restarting Pi`);
      this._watchdogTriggered = true;
      if (this._process) this._killTree(this._process, "SIGTERM");
      else this._endTurn({ subtype: "watchdog_timeout" });
    }, this._watchdogIdleMs);
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }
}

/** A tool result ({ content: [{type:"text", text}, ...] }) as one string. */
function toolText(result) {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return typeof result === "string" ? result : JSON.stringify(result ?? "");
  return blocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

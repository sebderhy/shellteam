import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitContent, textWithImagePaths } from "./attachments.mjs";
import { CodingAgent } from "./coding-agent.mjs";

// Idle watchdog: max silence between events before treating the process as
// wedged. `run --format json` emits a reasoning block only once it is
// complete, so one full-budget thought is one long silence: GLM 5.3 thought
// for 8.5 min (32K tokens at ~63 tok/s) before its next event (SHE-118),
// past the 8 min this used to be. The output cap bounds that silence.
const WATCHDOG_IDLE_MS = 15 * 60 * 1000;  // 15 min

// `run --format json` reports a tool call only once it has finished, so a
// 20-minute command was invisible and its silence tripped the watchdog, which
// killed the turn mid-benchmark (SHE-119). OpenCode records the call as
// "running" in its database the moment it starts; the cockpit polls that.
const TOOL_POLL_MS = 3000;
// SQLITE_BUSY and SQLITE_LOCKED: another connection holds the lock right now.
const SQLITE_LOCK_CODES = new Set([5, 6]);
const RUNNING_TOOLS_SQL = `SELECT id, data FROM part
  WHERE session_id = ? AND time_created >= ?
    AND json_extract(data, '$.type') = 'tool'
    AND json_extract(data, '$.state.status') = 'running'`;

// OpenCode caps a response at min(model limit.output, 32000) tokens. A model
// that plans a whole task in its head can spend all of it thinking and stop
// (finish "length") before writing a word or calling a tool (SHE-118: GLM 5.3
// drafted a benchmark's every file in its reasoning). The turn is then nudged
// once to act on the plan instead of ending silently.
const THINKING_OVERFLOW_NUDGE = [
  "<cockpit-notice>",
  "Your last step used its entire output budget on thinking and ended before you wrote anything or called a tool, so nothing happened.",
  "Do not re-plan from scratch: act on your plan now, one small step at a time, with tool calls (write files, run commands), and keep the thinking between steps short.",
  "</cockpit-notice>",
].join("\n");

// OpenCode's internal tool names are lowercase; we normalize to the PascalCase
// conventions used by Claude/Codex adapters so the UI renders them consistently.
const TOOL_NAME_MAP = {
  bash: "Bash",
  edit: "Edit",
  read: "Read",
  write: "Write",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
  codesearch: "CodeSearch",
  websearch: "WebSearch",
  task: "Task",
  todowrite: "TodoWrite",
  skill: "Skill",
};

/**
 * OpenCodeAgent — wraps the `opencode run --format json` CLI and translates
 * its stdout JSONL events into protocol events.
 *
 * Spawns one process per user turn (like Codex). Resume via `--session <id>`.
 *
 * Known limitation: OpenCode's `--format json` only emits `text` events once
 * `part.time.end` is set (i.e. when the text block is complete). That means
 * we don't get token-by-token streaming — we send the whole block as a single
 * `text_delta` followed by `text_done`. UX shows "Working..." until the block
 * lands. To get real streaming, switch to `opencode serve` + SDK events.
 */
export class OpenCodeAgent extends CodingAgent {
  constructor(opts) {
    super(opts);
    this._process = null;
    this._sessionIdCaptured = opts.sessionId || null;
    this._isFirstTurn = !opts.sessionId;
    this._streamingText = "";
    this._turnResultEmitted = false;
    this._watchdog = null;
    this._watchdogTriggered = false;
    this._isResuming = false;
    this._startTime = null;
    this._msgCount = 0;
    this._recentMsgs = [];
    this._env = { ...opts.env };
    this._toolPoll = null;
    this._toolPollMs = TOOL_POLL_MS;
    this._watchdogIdleMs = WATCHDOG_IDLE_MS;
    this._shownTools = new Set();  // part ids already sent as tool_start
    this._dbLockLogged = false;    // the busy-database warning, once per turn
  }

  get streamingText() { return this._streamingText; }
  get isBroken() { return false; }
  get isDead()   { return false; }

  start() { this._isActive = true; }

  sendMessage(content) {
    this._send(textWithImagePaths(splitContent(content)));
  }

  _send(prompt) {
    if (this._queueIfBusy(prompt)) return;
    this._overflowNudged = false;  // one automatic nudge per user message
    this._spawnRun(prompt);
  }

  interrupt() {
    const dropped = this._queued.length > 0;
    // Drop any stdout that arrives while opencode winds down, so a late event
    // can't re-open the turn after Stop; kill the whole process group, not just
    // the parent, so its tool subprocesses die too (SHE-90 follow-up).
    this._queued = [];  // a queued follow-up would resurrect the cancelled turn
    this._interrupted = true;
    this._clearWatchdog();
    this._stopToolPoll();
    this._terminate(this._process, "SIGINT");
    if (this._isGenerating && !this._turnResultEmitted) {
      this._turnResultEmitted = true;
      this._isGenerating = false;
      this._streamingText = "";
      this.emit("turn_done", this._interruptedTurnDone(dropped));
    }
  }

  stop() {
    this._clearWatchdog();
    this._stopToolPoll();
    this._queued = [];
    this._interrupted = true;
    this._terminate(this._process, "SIGTERM");
    this._process = null;
    this._isActive = false;
    this._isGenerating = false;
    this._streamingText = "";
  }

  _spawnRun(prompt) {
    const args = ["run"];
    if (this._sessionIdCaptured) {
      args.push("--session", this._sessionIdCaptured);
    } else if (!this._isFirstTurn) {
      args.push("--continue");
    }
    args.push(
      "--format", "json",
      "--dangerously-skip-permissions",
      "--model", `fireworks/${this._model}`,
      prompt,
    );

    this._isResuming = !this._isFirstTurn && !!this._sessionIdCaptured;
    this._watchdogTriggered = false;
    this._interrupted = false;
    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
    console.log(`[opencode-agent] spawn: opencode ${args.slice(0, 6).join(" ")}... (${this._isResuming ? "resume" : "fresh"})`);

    this._turnHeard = false;
    this._process = spawn("opencode", args, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so interrupt()/stop() can signal opencode AND every
      // tool subprocess it spawns (kill(-pid)), not just the parent.
      detached: true,
    });
    const proc = this._process;

    // Without this handler a spawn failure (opencode not installed) is an
    // UNCAUGHT EventEmitter error that takes down the whole ai-chat server.
    this._process.on("error", (err) => {
      console.error(`[opencode-agent] Process error: ${err.message}`);
      this._process = null;
      this._failTurn(this._processErrorMessage("OpenCode", err, "npm install -g opencode-ai"));
    });

    this._isFirstTurn = false;
    this._isGenerating = true;
    this._turnResultEmitted = false;
    this._thinkingOverflow = false;  // the last step hit the cap having done nothing
    this._stepActed = false;
    this._startTime = Date.now();
    this._msgCount = 0;
    this._recentMsgs = [];
    this._shownTools.clear();
    this._dbLockLogged = false;
    this._startToolPoll();

    let buffer = "";
    this._process.stdout.on("data", (chunk) => {
      this._turnHeard = true;
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) this._processLine(line);
    });

    this._process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[opencode-agent] stderr: ${text}`);
    });

    proc.on("close", (code, signal) => {
      // Stale close: a newer turn already replaced this process, or stop()
      // nulled it. Stay out of the live turn's state.
      if (this._process !== proc) return;
      if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
      if (buffer.trim()) this._processLine(buffer);
      this._process = null;
      this._clearWatchdog();
      this._stopToolPoll();
      console.log(`[opencode-agent] exited code=${code} signal=${signal} (${Date.now() - this._startTime}ms, ${this._msgCount} msgs)`);

      if (!this._turnResultEmitted && code === 0 && this._thinkingOverflow) {
        if (this._recoverThinkingOverflow()) return;
      }
      if (!this._turnResultEmitted) {
        this._isGenerating = false;
        this._streamingText = "";
        const wasWatchdog = this._watchdogTriggered;
        this._watchdogTriggered = false;
        const effSignal = this._exitSignal(code, signal); // 143→SIGTERM etc. (SHE-69)
        const isError = code !== 0 && effSignal !== "SIGTERM";
        this.emit("turn_done", {
          is_error: isError,
          errors: isError ? [`Process exited code=${code} signal=${signal}`] : undefined,
          subtype: wasWatchdog ? "watchdog_timeout"
            : effSignal === "SIGINT" ? "interrupted"
            : effSignal === "SIGTERM" ? "stopped"
            : undefined,
        });
        this._turnResultEmitted = true;
      }
      this._drainQueue();
    });

    this._resetWatchdog();
  }

  // The turn's last step thought until the output cap and did nothing. Nudge
  // it once to act (the turn stays open); a second overflow ends it with an
  // error rather than looping. Returns true while the turn continues.
  _recoverThinkingOverflow() {
    const model = this._model;
    if (this._overflowNudged) {
      const msg = `${model} spent its whole output budget thinking again and stopped before acting. Ask for a smaller first step, or switch to another model.`;
      console.warn(`[opencode-agent] thinking overflow after the nudge — ending the turn`);
      this.emit("error", { message: msg });
      this._isGenerating = false;
      this._streamingText = "";
      this._turnResultEmitted = true;
      this.emit("turn_done", { is_error: true, errors: [msg] });
      return false;
    }
    this._overflowNudged = true;
    console.warn(`[opencode-agent] thinking overflow (finish=length, no output) — nudging the turn to act`);
    this.emit("error", { message: `${model} spent its whole output budget thinking and stopped before acting. Continuing automatically, asking it to act on its plan step by step…` });
    this._spawnRun(THINKING_OVERFLOW_NUDGE);
    return true;
  }

  _processLine(line) {
    // Stop was pressed: the turn is already reported interrupted. Drop trailing
    // output so it can't re-open the turn.
    if (this._interrupted) return;
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      console.warn(`[opencode-agent] unparseable: ${line.slice(0, 200)}`);
      return;
    }
    this._msgCount++;
    const summary = `#${this._msgCount} (${Date.now() - this._startTime}ms): type=${event.type}`;
    if (this._msgCount <= 5 || this._msgCount % 50 === 0) {
      console.log(`[opencode-agent] ${summary}`);
    }
    this._recentMsgs.push(summary);
    if (this._recentMsgs.length > 10) this._recentMsgs.shift();

    this._resetWatchdog();
    this._translate(event);
  }

  _opencodeDbPath() {
    const dataHome = this._env.XDG_DATA_HOME || path.join(this._env.HOME || homedir(), ".local", "share");
    return path.join(dataHome, "opencode", "opencode.db");
  }

  _startToolPoll() {
    this._stopToolPoll();
    this._toolPoll = setInterval(() => {
      // A throw in a timer would take down the whole cockpit server.
      try { this._pollRunningTools(); } catch (err) {
        console.error(`[opencode-agent] reading running tools from OpenCode's database failed, polling stopped: ${err.message}`);
        this._stopToolPoll();
      }
    }, this._toolPollMs);
  }

  _stopToolPoll() {
    if (this._toolPoll) { clearInterval(this._toolPoll); this._toolPoll = null; }
  }

  // Show tool calls that are still running and count them as activity, so a
  // long command is neither invisible nor mistaken for a wedged process.
  _pollRunningTools() {
    if (!this._sessionIdCaptured || this._interrupted) return;
    const dbPath = this._opencodeDbPath();
    if (!existsSync(dbPath)) {
      console.warn(`[opencode-agent] no OpenCode database at ${dbPath}: running tools stay hidden until they finish`);
      this._stopToolPoll();
      return;
    }
    let rows;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        rows = db.prepare(RUNNING_TOOLS_SQL).all(this._sessionIdCaptured, this._startTime);
      } finally {
        db.close();
      }
    } catch (err) {
      // OpenCode writes to this database all the time, so a read can hit its
      // lock. That is momentary: skip this tick. Stopping here hid the running
      // tool for the rest of the turn and let the watchdog kill it (SHE-119).
      if (!SQLITE_LOCK_CODES.has(err.errcode)) throw err;
      if (!this._dbLockLogged) {
        console.warn(`[opencode-agent] OpenCode's database is busy (${err.message}), retrying on the next poll`);
        this._dbLockLogged = true;
      }
      return;
    }
    if (rows.length === 0) return;
    this._resetWatchdog();
    for (const row of rows) {
      // The part id lives in its own column; the JSON blob does not repeat it.
      const part = { ...JSON.parse(row.data), id: row.id };
      if (this._shownTools.has(part.id)) continue;
      this._shownTools.add(part.id);
      this._stepActed = true;
      this._thinkingOverflow = false;
      this.emit("tool_start", { id: part.id, name: TOOL_NAME_MAP[part.tool] ?? part.tool });
      this.emit("tool_input", { id: part.id, input: part.state?.input || {} });
    }
  }

  _resetWatchdog() {
    this._clearWatchdog();
    if (!this._isActive) return;
    const timeout = this._watchdogIdleMs;
    this._watchdog = setTimeout(() => {
      if (!this._isActive) return;
      console.error(`[opencode-agent] Watchdog timeout — no message for ${timeout / 1000}s, msgs=${this._msgCount}`);
      for (const m of this._recentMsgs) console.error(`  ${m}`);
      this._watchdogTriggered = true;
      if (this._process) {
        this._killTree(this._process, "SIGTERM");
      } else {
        this._isGenerating = false;
        this._streamingText = "";
        this.emit("turn_done", { subtype: "watchdog_timeout" });
        this._turnResultEmitted = true;
      }
    }, timeout);
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }

  _translate(event) {
    // Capture session ID on the very first event of each turn (used for resume).
    if (event.sessionID && !this._sessionIdCaptured) {
      this._sessionIdCaptured = event.sessionID;
      this._sessionId = event.sessionID;
      this.emit("init", { sessionId: event.sessionID, apiKeySource: "env" });
    } else if (event.sessionID && !this._sessionId) {
      this._sessionId = event.sessionID;
    }

    const part = event.part;

    switch (event.type) {
      case "text": {
        const text = part?.text || "";
        if (text) {
          this._stepActed = true;
          this._thinkingOverflow = false;
          this._streamingText += text;
          this.emit("text_delta", { text });
          this.emit("text_done", { text });
          this._streamingText = "";
        }
        break;
      }

      case "reasoning":
        // OpenCode thinking blocks — not surfaced in the chat UI for now.
        break;

      case "tool_use": {
        if (!part || !part.id) break;
        this._stepActed = true;
        this._thinkingOverflow = false;
        const rawName = part.tool || "tool";
        const name = TOOL_NAME_MAP[rawName] ?? rawName;
        const state = part.state || {};
        if (!this._shownTools.has(part.id)) {  // else the poll already showed it running
          this._shownTools.add(part.id);
          this.emit("tool_start", { id: part.id, name });
          this.emit("tool_input", { id: part.id, input: state.input || {} });
        }

        if (state.status === "completed") {
          const output = state.output ?? "";
          this.emit("tool_result", {
            id: part.id,
            content: typeof output === "string" ? output : JSON.stringify(output),
          });
        } else if (state.status === "error") {
          const errMsg = state.error || "Tool error";
          this.emit("tool_result", { id: part.id, content: errMsg, is_error: true });
        }
        break;
      }

      case "step_start":
        this._stepActed = false;
        break;

      case "step_finish":
        if (part?.reason === "length") {
          console.warn(`[opencode-agent] step hit the output cap (finish=length, reasoning=${part.tokens?.reasoning ?? "?"}, output=${part.tokens?.output ?? "?"})`);
          this._thinkingOverflow = !this._stepActed;
        }
        break;

      case "error": {
        const err = event.error || {};
        const msg = err?.data?.message || err?.name || "OpenCode error";
        console.warn(`[opencode-agent] error: ${msg}`);
        this.emit("error", { message: msg });
        this._turnResultEmitted = true;
        this._isGenerating = false;
        this._streamingText = "";
        this.emit("turn_done", { is_error: true, errors: [msg] });
        break;
      }

      default:
        // Unknown event type — log once for visibility, then ignore.
        if (this._msgCount <= 5) {
          console.log(`[opencode-agent] unhandled event: ${event.type}`);
        }
        break;
    }
  }
}

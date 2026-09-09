import { spawn } from "node:child_process";
import { CodingAgent } from "./coding-agent.mjs";

// Idle watchdog: max silence between events before treating the process as
// wedged. A resumed turn is the same model work as a fresh one (no "resume is
// faster"), and reasoning models go silent between tool calls for minutes —
// one generous timeout for both. See codex-agent.mjs for the observed gaps.
const WATCHDOG_IDLE_MS = 8 * 60 * 1000;  // 8 min

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
  }

  get streamingText() { return this._streamingText; }
  get isBroken() { return false; }
  get isDead()   { return false; }

  start() { this._isActive = true; }

  sendMessage(content) {
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter(b => b.type === "text").map(b => b.text).join("\n")
        : String(content);
    this._spawnRun(text);
  }

  interrupt() {
    // Drop any stdout that arrives while opencode winds down, so a late event
    // can't re-open the turn after Stop; kill the whole process group, not just
    // the parent, so its tool subprocesses die too (SHE-90 follow-up).
    this._interrupted = true;
    this._clearWatchdog();
    this._terminate(this._process, "SIGINT");
    if (this._isGenerating && !this._turnResultEmitted) {
      this._turnResultEmitted = true;
      this._isGenerating = false;
      this._streamingText = "";
      this.emit("turn_done", { subtype: "interrupted" });
    }
  }

  stop() {
    this._clearWatchdog();
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
    this._startTime = Date.now();
    this._msgCount = 0;
    this._recentMsgs = [];

    let buffer = "";
    this._process.stdout.on("data", (chunk) => {
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
      console.log(`[opencode-agent] exited code=${code} signal=${signal} (${Date.now() - this._startTime}ms, ${this._msgCount} msgs)`);

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
    });

    this._resetWatchdog();
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

  _resetWatchdog() {
    this._clearWatchdog();
    if (!this._isActive) return;
    const timeout = WATCHDOG_IDLE_MS;
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
        const rawName = part.tool || "tool";
        const name = TOOL_NAME_MAP[rawName] ?? rawName;
        const state = part.state || {};
        const input = state.input || {};
        this.emit("tool_start", { id: part.id, name });
        this.emit("tool_input", { id: part.id, input });

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
      case "step_finish":
        // Internal step boundaries — no protocol equivalent.
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

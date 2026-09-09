import { spawn } from "node:child_process";
import { CodingAgent } from "./coding-agent.mjs";

// Idle watchdog: max silence between events before treating the process as
// wedged. A resumed turn is the same model work as a fresh one (no "resume is
// faster"), and reasoning models go silent between tool calls for minutes —
// one generous timeout for both. See codex-agent.mjs for the observed gaps.
const WATCHDOG_IDLE_MS = 8 * 60 * 1000;  // 8 min

/**
 * GeminiCliAgent — wraps the Gemini CLI (`gemini -p`) using its
 * stream-json output format (NDJSON events).
 *
 * Like CodexAgent, this is per-turn spawning: each user message spawns
 * a new `gemini -p` process. Multi-turn uses `--resume <session_id>`.
 *
 * Gemini stream-json events:
 *   init          { session_id, model }
 *   message       { role, content, delta? }      (delta=true for streaming)
 *   tool_use      { tool_name, tool_id, parameters }
 *   tool_result   { tool_id, status, output?, error? }
 *   error         { severity, message }
 *   result        { status, stats? }
 */
export class GeminiCliAgent extends CodingAgent {
  constructor(opts) {
    super(opts);
    this._process = null;
    this._geminiSessionId = opts.sessionId || null;
    this._isFirstTurn = !opts.sessionId;
    this._streamingText = "";
    this._turnResultEmitted = false;
    this._watchdog = null;
    this._watchdogTriggered = false;
    this._isResuming = false;
    this._startTime = null;
    this._msgCount = 0;
    this._recentMsgs = [];
    this._compactTurn = false;
  }

  get streamingText() { return this._streamingText; }
  get isBroken() { return false; }
  get isDead() { return false; }

  start() {
    this._isActive = true;
    // No process spawned until sendMessage() — Gemini is per-turn.
  }

  sendMessage(content) {
    let text;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === "text").map(b => b.text).join("\n");
    } else {
      text = String(content);
    }

    if (text.trim() === "/compact") {
      this._compactTurn = true;
      this._spawnExec("/compact");
      return;
    }

    this._compactTurn = false;
    this._spawnExec(text);
  }

  interrupt() {
    if (this._process) {
      console.log("[gemini-cli] Sending SIGINT");
      this._process.kill("SIGINT");
    }
    if (this._isGenerating) {
      this._isGenerating = false;
      this._streamingText = "";
      this._turnResultEmitted = true;
      this._clearWatchdog();
      this.emit("turn_done", { subtype: "interrupted" });
    }
  }

  stop() {
    console.log(`[gemini-cli] stop() — pid=${this._process?.pid || "none"}`);
    this._clearWatchdog();
    if (this._process) {
      this._process.kill("SIGTERM");
      this._process = null;
    }
    this._isActive = false;
    this._isGenerating = false;
    this._streamingText = "";
  }

  // --- Process management ---

  _spawnExec(prompt) {
    const args = ["-p", prompt];

    if (!this._isFirstTurn && this._geminiSessionId) {
      args.push("--resume", this._geminiSessionId);
    }

    args.push(
      "-o", "stream-json",
      "-y",                    // yolo mode — auto-approve all tool calls
      "-m", this._model,
    );

    this._isResuming = !this._isFirstTurn && !!this._geminiSessionId;
    this._watchdogTriggered = false;
    console.log(`[gemini-cli] spawn: gemini ${args.map(a => a.length > 60 ? a.slice(0, 60) + "..." : a).join(" ")} (${this._isResuming ? "resume" : "fresh"})`);
    this._startTime = Date.now();
    this._msgCount = 0;
    this._turnResultEmitted = false;
    this._isGenerating = true;
    this._streamingText = "";
    this._isFirstTurn = false;

    this._process = spawn("gemini", args, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    this._process.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (line.trim()) this._processLine(line);
      }
    });

    this._process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[gemini-cli] stderr: ${text}`);
    });

    this._process.on("error", (err) => {
      console.error(`[gemini-cli] Process error: ${err.message}`);
      this._process = null;
      this._failTurn(this._processErrorMessage("Gemini", err, "npm install -g @google/gemini-cli"));
    });

    this._process.on("close", (code, signal) => {
      // Flush remaining buffer
      if (buffer.trim()) this._processLine(buffer);
      const pid = this._process?.pid;
      this._process = null;
      console.log(`[gemini-cli] exited pid=${pid} code=${code} signal=${signal} (${Date.now() - this._startTime}ms, ${this._msgCount} msgs)`);

      this._clearWatchdog();

      // Synthetic turn_done if process exited without emitting one
      if (!this._turnResultEmitted && this._isActive) {
        this._isGenerating = false;
        this._streamingText = "";
        const wasWatchdog = this._watchdogTriggered;
        this._watchdogTriggered = false;
        const effSignal = this._exitSignal(code, signal); // 143→SIGTERM etc. (SHE-69)
        const isError = code !== 0 && effSignal !== "SIGTERM";
        this.emit("turn_done", {
          is_error: isError,
          errors: isError ? [`Gemini CLI exited code=${code} signal=${signal}`] : undefined,
          subtype: wasWatchdog ? "watchdog_timeout" : effSignal === "SIGINT" ? "interrupted" : effSignal === "SIGTERM" ? "stopped" : undefined,
        });
      }
    });

    this._resetWatchdog();
  }

  // --- Watchdog ---

  _resetWatchdog() {
    this._clearWatchdog();
    if (!this._isActive) return;
    const timeout = WATCHDOG_IDLE_MS;
    this._watchdog = setTimeout(() => {
      if (!this._isActive) return;
      console.error(`[gemini-cli] Watchdog timeout — no message for ${timeout / 1000}s (${this._isResuming ? "resume" : "fresh"}), msgs=${this._msgCount}`);
      if (this._recentMsgs.length) {
        console.error(`[gemini-cli] Last messages before timeout:`);
        for (const m of this._recentMsgs) console.error(`  ${m}`);
      }
      // Kill the process — close handler checks _watchdogTriggered to emit correct subtype
      this._watchdogTriggered = true;
      if (this._process) {
        this._process.kill("SIGTERM");
      } else {
        this._isGenerating = false;
        this._streamingText = "";
        this.emit("turn_done", { subtype: "watchdog_timeout" });
      }
    }, timeout);
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }

  // --- NDJSON parsing ---

  _processLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      console.warn(`[gemini-cli] Unparseable: ${line.slice(0, 200)}`);
      return;
    }
    this._msgCount++;
    const summary = `#${this._msgCount} (${Date.now() - this._startTime}ms): type=${msg.type}`;
    if (this._msgCount <= 5 || this._msgCount % 50 === 0) {
      console.log(`[gemini-cli] ${summary}`);
    }
    this._recentMsgs.push(summary);
    if (this._recentMsgs.length > 10) this._recentMsgs.shift();

    this._resetWatchdog();
    this._translate(msg);
  }

  // --- Event translation ---

  _translate(msg) {
    switch (msg.type) {
      case "init": {
        if (msg.session_id) {
          this._geminiSessionId = msg.session_id;
          this._sessionId = msg.session_id;
          console.log(`[gemini-cli] Session ID: ${this._geminiSessionId}`);
        }
        this.emit("init", {
          sessionId: msg.session_id,
          apiKeySource: "env",
        });
        break;
      }

      case "message": {
        if (msg.role === "user") break; // skip user echo
        if (this._compactTurn) break;   // suppress model output during compact

        if (msg.delta) {
          // Streaming text delta
          this._streamingText += msg.content;
          this.emit("text_delta", { text: msg.content });
        } else {
          // Complete message — emit as text_done
          if (this._streamingText) {
            this.emit("text_done", { text: this._streamingText });
            this._streamingText = "";
          } else if (msg.content) {
            this.emit("text_done", { text: msg.content });
          }
        }
        break;
      }

      case "tool_use": {
        this.emit("tool_start", { id: msg.tool_id, name: msg.tool_name });
        this.emit("tool_input", { id: msg.tool_id, input: msg.parameters || {} });
        break;
      }

      case "tool_result": {
        const isError = msg.status === "error";
        const content = isError
          ? (msg.error?.message || msg.output || "Tool error")
          : (msg.output || "Done");
        this.emit("tool_result", {
          id: msg.tool_id,
          content,
          is_error: isError,
        });
        break;
      }

      case "error": {
        const errMsg = msg.message || "Unknown error";
        console.warn(`[gemini-cli] ${msg.severity || "error"}: ${errMsg}`);
        if (msg.severity === "error") {
          this.emit("error", { message: errMsg });
        }
        // Warnings are just logged, not surfaced to user
        break;
      }

      case "result": {
        this._turnResultEmitted = true;
        this._isGenerating = false;
        this._clearWatchdog();

        if (this._compactTurn) {
          this._compactTurn = false;
          this._streamingText = "";
          this.emit("session_event", { event: "compacted" });
        }

        // Flush any remaining streaming text
        if (this._streamingText) {
          this.emit("text_done", { text: this._streamingText });
          this._streamingText = "";
        }

        const stats = msg.stats;
        const usage = stats ? {
          input_tokens: stats.input_tokens,
          output_tokens: stats.output_tokens,
          total_tokens: stats.total_tokens,
          cached_tokens: stats.cached,
        } : undefined;

        this.emit("turn_done", {
          usage,
          is_error: msg.status === "error",
          errors: msg.error ? [msg.error.message] : undefined,
        });
        break;
      }

      default:
        console.log(`[gemini-cli] unhandled event type: ${msg.type}`);
        break;
    }
  }

  // --- Compact ---
  // Handled natively by Gemini CLI: `/compact` is passed as prompt in -p mode,
  // the CLI recognizes it as a slash command and calls tryCompressChat(force=true).
}

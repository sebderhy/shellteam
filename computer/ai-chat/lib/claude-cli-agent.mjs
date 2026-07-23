import { spawn } from "node:child_process";
import { CodingAgent } from "./coding-agent.mjs";
import { claudeLayerArgs } from "./agent-layer.mjs";

const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;    // 10 minutes — kill idle CLI process
// Background subagents live INSIDE the CLI process; a leaked tracker entry
// (a subagent whose result line never arrived) must not pin the process
// forever — after this long with zero stdout activity we reap regardless.
const STALE_SUBAGENT_MS = 60 * 60 * 1000;  // 1 hour

/**
 * ClaudeCliAgent — wraps the real Claude Code CLI (`claude -p`) using the
 * bidirectional stream-json protocol (same protocol the VS Code extension uses).
 *
 * Process lifecycle:
 *   - Spawned on first user message (or start())
 *   - Stays alive across multiple turns (multi-turn via stdin)
 *   - Killed after IDLE_TIMEOUT_MS of inactivity
 *   - Resumed on next message via --resume <sessionId>
 *   - Killed on stop()
 */
export class ClaudeCliAgent extends CodingAgent {
  constructor(opts) {
    super(opts);
    this._process = null;
    this._streamingText = "";
    this._toolInputBuffers = new Map();  // tool_use_id -> accumulated JSON string
    this._activeToolNames = new Map();   // tool_use_id -> tool name
    this._blockIndexToToolId = new Map(); // content_block index -> tool_use_id
    this._nextBlockIndex = 0;
    this._watchdog = null;
    this._idleTimer = null;
    this._turnDoneEmitted = false;
    this._recentMsgs = [];
    this._msgCount = 0;
    this._subagents = new Map();
    this._startTime = null;
    this._lastEventAt = Date.now(); // any stdout line counts as activity (SHE-59)
    this._hadStreamEvents = false;
    // Usage of the LAST main-agent API call in the current turn — the true
    // context-window occupancy. The `result` message's `usage` instead SUMS
    // cache_read across every internal round-trip in the turn (a 60-tool turn
    // re-reads a 120k context 60× → millions of "tokens"), which made the
    // context meter read 100% and never fall after /compact (SHE-48). Each
    // message_start overwrites this, so it always reflects the newest call.
    this._lastMainUsage = null;
  }

  get streamingText() { return this._streamingText; }
  get isBroken() { return false; } // CLI doesn't get broken like SDK
  get isDead() { return !this._isActive && this._process === null && this._msgCount > 0; }

  start() {
    this._isActive = true;
    this._spawnCLI();
  }

  sendMessage(content) {
    // NB: do NOT reset _turnDoneEmitted here. Messages can be sent while a prior
    // turn is still generating (the UI allows it; Claude Code queues them). The
    // per-turn flag is cleared at turn END (on `result`) instead — resetting it
    // at send time let the prior turn's `result` flip it true, which then
    // suppressed the queued turn's own turn_done and left the UI stuck "working".
    this._resetWatchdog();
    this._clearIdleTimer();

    // Respawn if process died (resume with sessionId)
    if (!this._process) {
      this._spawnCLI();
    }

    // Write NDJSON user message to stdin (same format as SDK's MessageStream)
    const msg = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this._sessionId || "",
    };

    const line = JSON.stringify(msg) + "\n";
    console.log(`[claude-cli] Writing to stdin: ${line.slice(0, 120)}...`);
    this._process.stdin.write(line);
  }

  interrupt() {
    if (this._process) {
      console.log("[claude-cli] Sending SIGINT");
      this._process.kill("SIGINT");
    }
    if (this._isGenerating) {
      this._isGenerating = false;
      this._streamingText = "";
      this._turnDoneEmitted = true; // prevent close handler from emitting a duplicate
      this._clearWatchdog();
      this.emit("turn_done", { subtype: "interrupted" });
    }
  }

  stop() {
    console.log(`[claude-cli] stop() — pid=${this._process?.pid || "none"}`);
    this._clearWatchdog();
    this._clearIdleTimer();
    if (this._process) {
      this._process.stdin.end();
      this._process.kill("SIGTERM");
      this._process = null;
    }
    this._isActive = false;
    this._isGenerating = false;
    this._streamingText = "";
  }

  // --- Process management ---

  _spawnCLI() {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--model", this._model,
      // ShellTeam's additive layer (skills/hooks/MCP/persona) — see agent-layer.mjs.
      ...claudeLayerArgs(this._cwd),
    ];

    if (this._sessionId) {
      args.push("--resume", this._sessionId);
    }

    console.log(`[claude-cli] Spawning: claude ${args.join(" ")}`);
    this._startTime = Date.now();
    this._lastEventAt = Date.now();
    this._msgCount = 0;

    this._process = spawn("claude", args, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["pipe", "pipe", "pipe"],
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
      if (text) console.error(`[claude-cli] stderr: ${text}`);
    });

    this._process.on("error", (err) => {
      console.error(`[claude-cli] Process error: ${err.message}`);
      this._process = null;
      this._streamingText = "";
      this._failTurn(this._processErrorMessage("Claude Code", err, "npm install -g @anthropic-ai/claude-code"));
    });

    this._process.on("close", (code, signal) => {
      // Flush remaining buffer
      if (buffer.trim()) this._processLine(buffer);
      const pid = this._process?.pid;
      this._process = null;
      console.log(`[claude-cli] Process exited pid=${pid} code=${code} signal=${signal} (${Date.now() - this._startTime}ms, ${this._msgCount} msgs)`);

      // Only emit a synthetic turn_done if a turn was actually IN PROGRESS when
      // the process died (crash mid-turn). A completed turn already cleared
      // _isGenerating via `result`, so an idle-timeout kill must NOT emit a
      // spurious turn_done. (Gating on _isGenerating, not the per-turn flag,
      // which no longer persists across turns.)
      if (this._isActive && this._isGenerating) {
        this._isGenerating = false;
        this._streamingText = "";
        // The Claude CLI traps SIGTERM and exits 143 with signal=null, so
        // classify on the normalized signal or every deliberate kill reads as
        // a red error (SHE-69).
        const effSignal = this._exitSignal(code, signal);
        const isError = code !== 0 && effSignal !== "SIGTERM";
        this.emit("turn_done", {
          is_error: isError,
          errors: isError ? [`CLI exited code=${code} signal=${signal}`] : undefined,
          subtype: effSignal === "SIGINT" ? "interrupted" : effSignal === "SIGTERM" ? "stopped" : undefined,
        });
      }
    });

    this._resetWatchdog();
  }

  // --- Idle timeout ---

  _startIdleTimer() {
    this._clearIdleTimer();
    this._idleTimer = setTimeout(() => this._reapIfIdle(), IDLE_TIMEOUT_MS);
  }

  _reapIfIdle() {
    this._idleTimer = null;
    if (!this._process || this._isGenerating) return;
    // Background subagents (Task run_in_background) keep working inside this
    // process after the main turn's `result`. Killing it "idle" orphaned whole
    // fleets mid-flight — the SHE-59 teardown loop. Defer while subagents are
    // tracked or stdout is still flowing; the stale cap reaps a process whose
    // tracker leaked (no events at all for a full hour).
    const quietMs = Date.now() - this._lastEventAt;
    const subagentsAlive = this._subagents.size > 0 && quietMs < STALE_SUBAGENT_MS;
    if (subagentsAlive || quietMs < IDLE_TIMEOUT_MS) {
      console.log(`[claude-cli] Idle check: ${this._subagents.size} subagent(s) tracked, last event ${Math.round(quietMs / 1000)}s ago — deferring kill`);
      this._startIdleTimer();
      return;
    }
    console.log(`[claude-cli] Idle timeout (${IDLE_TIMEOUT_MS / 1000}s quiet, no subagents) — killing process`);
    this._process.stdin.end();
    this._process.kill("SIGTERM");
    // Don't set _isActive=false — we'll respawn on next sendMessage()
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  // --- Watchdog ---

  _resetWatchdog() {
    this._clearWatchdog();
    if (!this._isActive) return;
    this._watchdog = setTimeout(() => {
      if (!this._isActive) return;
      if (!this._isGenerating) {
        // No turn in flight: the timer was re-armed by trailing events
        // (background-subagent streams keep arriving after `result` resets
        // _turnDoneEmitted). Firing here "restarts" a healthy idle session and
        // burns the watchdog budget down to the give-up error (SHE-69).
        console.log(`[claude-cli] Watchdog fired while idle (msgs=${this._msgCount}) — disarming, not a wedge`);
        return;
      }
      console.error(`[claude-cli] Watchdog timeout — no message for ${WATCHDOG_TIMEOUT_MS / 1000}s, msgs=${this._msgCount}, isGenerating=${this._isGenerating}`);
      if (this._recentMsgs.length) {
        console.error(`[claude-cli] Last messages before timeout:`);
        for (const m of this._recentMsgs) console.error(`  ${m}`);
      }
      this._isActive = false;
      this._isGenerating = false;
      this._streamingText = "";
      this.emit("turn_done", { subtype: "watchdog_timeout" });
    }, WATCHDOG_TIMEOUT_MS);
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }

  // --- NDJSON parsing ---

  _processLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      console.warn(`[claude-cli] Unparseable: ${line.slice(0, 200)}`);
      return;
    }
    this._msgCount++;
    this._lastEventAt = Date.now();
    const summary = `#${this._msgCount} (${Date.now() - this._startTime}ms): type=${msg.type}, subtype=${msg.subtype || "-"}`;
    if (this._msgCount <= 5 || this._msgCount % 50 === 0) {
      console.log(`[claude-cli] ${summary}`);
    }
    this._recentMsgs.push(summary);
    if (this._recentMsgs.length > 10) this._recentMsgs.shift();

    if (!this._turnDoneEmitted) {
      this._resetWatchdog();
    }
    this._handleMessage(msg);
  }

  // --- Message handling (same logic as ClaudeAgent._handleSDKMessage) ---

  _handleMessage(msg) {
    const isSubagent = !!msg.parent_tool_use_id;

    // --- system/init ---
    if (msg.type === "system" && msg.subtype === "init") {
      if (msg.session_id) {
        this._sessionId = msg.session_id;
        console.log(`[claude-cli] Session ID: ${this._sessionId}`);
      }
      this._isGenerating = true;
      this.emit("init", {
        sessionId: msg.session_id,
        apiKeySource: msg.apiKeySource || null,
      });
      return;
    }

    // --- compact_boundary ---
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      this.emit("session_event", { event: "compacted" });
      return;
    }

    // --- stream_event ---
    if (msg.type === "stream_event" && msg.event) {
      this._hadStreamEvents = true;
      if (!this._turnDoneEmitted) {
        this._isGenerating = true;
      }

      if (isSubagent) {
        this._handleSubagentStreamEvent(msg);
        return;
      }

      this._handleStreamEvent(msg.event);
      return;
    }

    // --- assistant (complete message, main agent) ---
    if (msg.type === "assistant" && !isSubagent) {
      // Flush streaming text if we were accumulating it
      if (this._streamingText) {
        this.emit("text_done", { text: this._streamingText });
        this._streamingText = "";
      }

      // Fallback: if no stream_events were received, extract text/tools from the complete message
      const content = msg.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && block.text && !this._emittedBlockIds?.has(block.id)) {
          // Only emit if we haven't already streamed this text via content_block_delta
          if (!this._hadStreamEvents) {
            this.emit("text_done", { text: block.text });
          }
        } else if (block.type === "tool_use" && !this._toolInputBuffers.has(block.id) && !this._hadStreamEvents) {
          // Tool was in complete message but not streamed — emit start+input
          if (block.name !== "AskUserQuestion" && block.name !== "EnterPlanMode") {
            this.emit("tool_start", { id: block.id, name: block.name });
            this.emit("tool_input", { id: block.id, input: block.input || {} });
          }
          if (block.name === "AskUserQuestion") {
            this.emit("ask_user", { id: block.id, questions: block.input?.questions || [] });
          }
          if (block.name === "ExitPlanMode") {
            this.emit("plan_done", { plan: block.input });
          }
          if (block.name === "EnterPlanMode") {
            this.emit("plan_start", {});
          }
        }
      }

      const mainTurnEnded = !content.some(b => b.type === "tool_use") && msg.message?.stop_reason === "end_turn";
      if (mainTurnEnded && this._isGenerating) {
        console.log("[claude-cli] Main turn ended (end_turn)");
        this._isGenerating = false;
        this._turnDoneEmitted = true;
        this._clearWatchdog();
        this._streamingText = "";
        this._startIdleTimer();
        // The complete assistant message carries this call's own usage — the
        // authoritative end-of-turn window size (SHE-48). Prefer it over the
        // per-message-start snapshot, fall back to it if absent.
        this.emit("turn_done", { usage: msg.message?.usage || this._lastMainUsage });
        this._lastMainUsage = null;
      }
      this._hadStreamEvents = false; // reset for next message
      return;
    }

    // --- assistant (subagent) ---
    if (msg.type === "assistant" && isSubagent) {
      this._handleSubagentAssistant(msg);
      return;
    }

    // --- user (tool_result) ---
    if (msg.type === "user" && msg.message?.content && !isSubagent) {
      const content = Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content];
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          let resultContent = block.content;
          if (Array.isArray(resultContent)) {
            resultContent = resultContent.map(b => {
              if (b.type === "image" && b.source?.data) {
                return { type: "text", text: `[image: ${b.source.media_type || "image/png"}]` };
              }
              return b;
            });
          }
          this.emit("tool_result", {
            id: block.tool_use_id,
            content: resultContent,
            is_error: block.is_error || false,
          });
        }
      }
      return;
    }

    // --- result ---
    if (msg.type === "result") {
      this._isGenerating = false;
      this._streamingText = "";

      if (isSubagent) {
        this._handleSubagentResult(msg);
        return;
      }

      // `result` is the authoritative end of EACH turn. Clear the per-turn flag
      // HERE (not at send time) so a message queued mid-turn still completes.
      this._clearWatchdog();
      this._startIdleTimer();

      // If the early end_turn path (or interrupt) already emitted turn_done for
      // THIS turn, don't double-emit — just clear the flag for the next turn.
      if (this._turnDoneEmitted) {
        this._turnDoneEmitted = false;
        return;
      }

      this.emit("turn_done", {
        cost: msg.total_cost_usd,
        // NOT msg.usage — that sums cache_read across every round-trip in the
        // turn (millions of tokens). The last API call's own usage is the real
        // context-window occupancy the meter needs (SHE-48).
        usage: this._lastMainUsage || msg.usage,
        is_error: msg.is_error || false,
        errors: msg.errors,
      });
      this._lastMainUsage = null;
      return;
    }
  }

  // --- Stream event translation ---

  _handleStreamEvent(event) {
    switch (event.type) {
      case "message_start":
        this._streamingText = "";
        this._blockIndexToToolId.clear();
        this._nextBlockIndex = 0;
        // Per-call input usage = current context-window occupancy (SHE-48).
        if (event.message?.usage) this._lastMainUsage = event.message.usage;
        break;

      case "content_block_start": {
        const block = event.content_block;
        if (!block) break;
        if (block.type === "text") {
          this._streamingText = "";
        } else if (block.type === "tool_use") {
          this._toolInputBuffers.set(block.id, "");
          this._activeToolNames.set(block.id, block.name);
          this._blockIndexToToolId.set(this._nextBlockIndex, block.id);

          if (block.name === "AskUserQuestion") break;
          if (block.name === "EnterPlanMode") {
            this.emit("plan_start", {});
            break;
          }

          if (block.name === "Task" || block.name === "Agent") {
            this._subagents.set(block.id, { steps: 0 });
          }

          this.emit("tool_start", { id: block.id, name: block.name });
        }
        this._nextBlockIndex++;
        break;
      }

      case "content_block_delta": {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          this._streamingText += event.delta.text;
          this.emit("text_delta", { text: event.delta.text });
        } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
          const toolId = this._getActiveToolId(event.index);
          if (toolId) {
            const buf = (this._toolInputBuffers.get(toolId) || "") + event.delta.partial_json;
            this._toolInputBuffers.set(toolId, buf);
          }
        }
        break;
      }

      case "content_block_stop": {
        if (this._streamingText) {
          this.emit("text_done", { text: this._streamingText });
          this._streamingText = "";
        }

        const toolId = this._getActiveToolId(event.index);
        if (toolId && this._toolInputBuffers.has(toolId)) {
          this._finalizeToolInput(toolId);
        }
        break;
      }
    }
  }

  _getActiveToolId(eventIndex) {
    if (eventIndex !== undefined && this._blockIndexToToolId.has(eventIndex)) {
      return this._blockIndexToToolId.get(eventIndex);
    }
    const ids = [...this._toolInputBuffers.keys()];
    return ids[ids.length - 1] || null;
  }

  _finalizeToolInput(toolId) {
    const raw = this._toolInputBuffers.get(toolId) || "";
    const name = this._activeToolNames.get(toolId) || "";
    this._toolInputBuffers.delete(toolId);
    this._activeToolNames.delete(toolId);

    let input = {};
    try { input = JSON.parse(raw); } catch { input = { raw }; }

    if (name === "AskUserQuestion") {
      this.emit("ask_user", { id: toolId, questions: input.questions || [] });
      return;
    }

    if (name === "ExitPlanMode") {
      this.emit("plan_done", { plan: input });
      return;
    }

    this.emit("tool_input", { id: toolId, input });
  }

  // --- Subagent handling ---

  _handleSubagentStreamEvent(msg) {
    const parentId = msg.parent_tool_use_id;
    const tracked = this._subagents.get(parentId);
    if (!tracked) return;
    if (msg.event?.type === "message_start") {
      tracked.steps++;
      this.emit("subagent_progress", { parent_id: parentId, step: tracked.steps });
    }
  }

  _handleSubagentAssistant(msg) {
    const parentId = msg.parent_tool_use_id;
    const tracked = this._subagents.get(parentId);
    if (!tracked) return;
    tracked.steps++;
    this.emit("subagent_progress", { parent_id: parentId, step: tracked.steps });
  }

  _handleSubagentResult(msg) {
    const parentId = msg.parent_tool_use_id;
    const tracked = this._subagents.get(parentId);
    const steps = tracked?.steps || 0;
    this._subagents.delete(parentId);
    this.emit("subagent_done", { parent_id: parentId, steps });
  }
}

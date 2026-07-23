import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CodingAgent } from "./coding-agent.mjs";
import { codexHarnessEnv, codexLayerArgs } from "./agent-layer.mjs";
import { cliModelForId, configArgsForId, contextLimitForId } from "./model-catalog.mjs";

const STRIP_ENV_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

// Proactive auto-compaction: Codex compacts natively when accumulated context
// crosses `model_auto_compact_token_limit`, but only sets that limit near its
// own ceiling by default — so one heavy turn (big tool outputs) can blow past
// the window mid-turn and hit the unrecoverable "ran out of room" error before
// any compaction fires. We pin the limit to a fraction of the model's real
// window so compaction kicks in early, leaving headroom for the next turn.
// Lower limit = compact sooner (the manual /compact path forces the extreme,
// `=1`). See docs/decisions/20260710-codex-proactive-auto-compaction.md.
const AUTO_COMPACT_FRACTION = 0.8;

export function autoCompactLimitForModel(model) {
  return Math.floor(contextLimitForId(model) * AUTO_COMPACT_FRACTION);
}

// FALLBACK mapping of `turn.completed.usage` for the context meter — correct
// only for single-API-call turns. Verified on codex-cli 0.144.1: that usage
// object SUMS input_tokens across every API call of the turn (a 3-call turn
// reports ~3× the context size), so on long tool-heavy turns it inflates to
// tens of millions of "tokens" (SHE-68 — "42069k · 100%"). The authoritative
// per-call numbers live in the session rollout file (see
// parseRolloutTokenInfo); this is only used when that file can't be read.
export function codexUsage(usage) {
  if (!usage || typeof usage.input_tokens !== "number") return undefined;
  return { input_tokens: usage.input_tokens };
}

// Rollout lines recording a compaction. Everything logged BEFORE one describes
// a context that no longer exists.
const ROLLOUT_COMPACTION_RE = /"context_compact/;

// Extract the LAST *still-valid* `token_count` event from a Codex rollout-file
// tail. Codex appends one per API call: `info.last_token_usage` is that call's
// real context occupancy (input incl. cached + output) and
// `info.model_context_window` the OPERATIVE window — 258400 for gpt-5.6, not
// the marketed 400k. That gap is why a 320k auto-compact limit could never
// fire and Codex hit the hard "ran out of room" wall instead (SHE-66).
//
// A compaction resets occupancy, so counts recorded before one are discarded
// (SHE-48 regression): the API call that PERFORMS a compaction carries the
// entire pre-compaction context, so trusting it painted the meter with the
// peak — observed live as "271k · 100%" on a 258400-token window immediately
// after /compact, when the real occupancy was ~5k. Returns null when the tail
// holds a compaction but no count after it yet (the rollout is flushed
// asynchronously, so turn.completed can race ahead of the post-compaction
// count); callers must treat null as "unknown", never as zero.
export function parseRolloutTokenInfo(tailText) {
  let info = null;
  for (const line of tailText.split("\n")) {
    // Matched on the raw line, not the parsed payload: the tail's first line
    // may be cut mid-JSON, and missing a compaction marker would let a
    // pre-compaction count survive.
    if (ROLLOUT_COMPACTION_RE.test(line)) { info = null; continue; }
    if (!line.includes('"token_count"')) continue;
    try {
      const payload = JSON.parse(line)?.payload;
      if (payload?.type === "token_count" && payload.info) info = payload.info;
    } catch { /* first line of the tail may be cut mid-JSON — skip it */ }
  }
  return info;
}

// A prompt Codex ignores; used for forced-compaction turns (limit=1) where
// the only goal is triggering compaction, not new work.
const COMPACT_ACK_PROMPT = "briefly acknowledge";

// Matches Codex's context-overflow failure, e.g. "Codex ran out of room in
// the model's context window. Start a new thread or clear earlier history".
const CONTEXT_OVERFLOW_RE = /ran out of room|context window/i;

// Idle watchdog: max silence BETWEEN events before we treat the process as
// wedged (reset on every JSONL line, so it bounds inter-event gaps, not total
// turn length). gpt-5.5 reasons silently between tool calls — observed gaps up
// to ~3.5 min on a heavy resumed conversation, with the turn completing at
// ~5 min. There is NO "resume is faster" — a resumed turn is the same model
// work as a fresh one — so use one generous timeout for both. Too-short kills a
// thinking model, and the auto-resend then just re-triggers the same long turn.
const WATCHDOG_IDLE_MS = 8 * 60 * 1000;  // 8 min

// Grace between a graceful signal (SIGINT/SIGTERM) and the SIGKILL that
// guarantees death. Codex should honor SIGINT within a second; if it (or a
// wedged tool child) doesn't, escalate so Stop always actually stops.
const KILL_ESCALATE_MS = 2000;

/**
 * CodexAgent — wraps the Codex CLI (`codex exec --json`) and translates
 * its JSONL events into clean protocol events.
 *
 * Unlike ClaudeAgent (single long-lived SDK query), CodexAgent spawns a
 * new `codex exec` process per user turn. Resume uses thread IDs.
 */
export class CodexAgent extends CodingAgent {
  constructor(opts) {
    super(opts);
    this._process = null;
    this._threadId = opts.sessionId || null;
    this._isFirstTurn = !opts.sessionId;
    this._streamingText = "";
    this._currentAgentText = "";
    this._currentAgentId = null;
    this._turnResultEmitted = false;
    this._watchdog = null;
    this._watchdogTriggered = false;
    this._isResuming = false;
    this._startTime = null;
    this._msgCount = 0;
    this._recentMsgs = [];
    this._compactTurn = false;
    this._compactEmitted = false;
    this._recentStderr = "";
    this._rolloutFile = null;       // cached path of this thread's rollout JSONL
    this._contextWindow = null;     // model_context_window observed from the rollout
    this._lastPrompt = null;        // last real user prompt (for overflow retry)
    this._recovery = null;          // overflow recovery: {prompt, phase} | null
    this._recoveryUsed = false;     // one auto-recovery per user message

    // Strip Anthropic secrets from env
    this._env = { ...opts.env };
    for (const key of STRIP_ENV_VARS) delete this._env[key];
    // Cockpit-only HOME overlay: Codex sees the same native ShellTeam skills as
    // every other agent, while CODEX_HOME stays on the user's real auth/config.
    this._env = codexHarnessEnv(this._env);
  }

  get streamingText() { return this._streamingText; }
  get isBroken() { return false; }
  get isDead() { return false; }

  start() {
    this._isActive = true;
    // No process spawned until sendMessage() — Codex is per-turn.
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
      this._compactEmitted = false;
      this._spawnExec(COMPACT_ACK_PROMPT);
      return;
    }

    this._compactTurn = false;
    this._lastPrompt = text;
    this._recovery = null;
    this._recoveryUsed = false;
    this._spawnExec(text);
  }

  interrupt() {
    this._recovery = null;
    // Ignore any stdout that keeps arriving while codex winds down — without
    // this gate a late agent_message/tool event re-set isGenerating and the
    // turn visibly "continued" after Stop (SHE-90 follow-up).
    this._interrupted = true;
    this._clearWatchdog();
    this._terminate(this._process, "SIGINT", KILL_ESCALATE_MS);
    // Optimistic turn_done for a snappy Stop; mark it emitted so the eventual
    // process `close` doesn't fire a second, duplicate one.
    if (this._isGenerating && !this._turnResultEmitted) {
      this._turnResultEmitted = true;
      this._isGenerating = false;
      this._streamingText = "";
      this.emit("turn_done", { subtype: "interrupted" });
    }
  }

  stop() {
    this._clearWatchdog();
    this._recovery = null;
    this._interrupted = true;
    this._terminate(this._process, "SIGTERM", KILL_ESCALATE_MS);
    this._process = null;
    this._isActive = false;
    this._isGenerating = false;
    this._streamingText = "";
  }

  // --- Internal ---

  _spawnExec(prompt) {
    const args = ["exec"];

    if (!this._isFirstTurn && this._threadId) {
      args.push("resume", this._threadId);
    } else if (!this._isFirstTurn) {
      args.push("resume", "--last");
    }

    if (this._compactTurn) {
      // Manual /compact: force immediate compaction (limit of 1 → always over).
      args.push("-c", "model_auto_compact_token_limit=1");
    } else {
      // Normal turn: compact proactively at a fraction of the window, well
      // before the hard ceiling, so a heavy turn can't blow the context.
      // Prefer the window Codex itself reported for this thread (rollout
      // token_count events) — the catalog's marketed window can be HIGHER
      // than the operative one (gpt-5.6: 400k marketed, 258400 operative),
      // which put the limit past the wall so compaction never fired (SHE-66).
      const observed = this._observedContextWindow();
      const limit = observed
        ? Math.floor(observed * AUTO_COMPACT_FRACTION)
        : autoCompactLimitForModel(this._model);
      args.push("-c", `model_auto_compact_token_limit=${limit}`);
    }

    args.push(
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      ...codexLayerArgs(this._cwd), // ShellTeam's additive -c overrides (MCP, doc-fallback, provider)
      ...configArgsForId(this._model),
      "-m", cliModelForId(this._model),
      // The prompt goes over STDIN (`-` sentinel), never argv: a prompt starting
      // with `-` (e.g. a bullet list) is otherwise parsed as a flag — clap dies
      // with `unexpected argument '- ' found`, code=2 (SHE-67) — and argv also
      // caps prompt length at ARG_MAX.
      "-",
    );

    this._isResuming = !this._isFirstTurn && !!this._threadId;
    this._watchdogTriggered = false;
    this._interrupted = false;
    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
    console.log(`[codex-agent] spawn: codex ${args.join(" ").slice(0, 120)}... (${this._isResuming ? "resume" : "fresh"})`);

    this._process = spawn("codex", args, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so interrupt()/stop() can signal codex AND every
      // tool/MCP subprocess it spawns (kill(-pid)), not just the parent.
      detached: true,
    });
    const proc = this._process;

    // Without this handler a spawn failure (codex not installed) is an
    // UNCAUGHT EventEmitter error that takes down the whole ai-chat server.
    this._process.on("error", (err) => {
      console.error(`[codex-agent] Process error: ${err.message}`);
      this._process = null;
      this._failTurn(this._processErrorMessage("Codex", err, "npm install -g @openai/codex"));
    });

    // Deliver the prompt over stdin (see the `-` sentinel above). EPIPE here
    // means the process died before reading — the close handler reports that.
    this._process.stdin.on("error", (err) => {
      console.error(`[codex-agent] stdin write failed: ${err.message}`);
    });
    this._process.stdin.end(prompt);

    this._isFirstTurn = false;
    this._isGenerating = true;
    this._currentAgentText = "";
    this._currentAgentId = null;
    this._turnResultEmitted = false;
    this._startTime = Date.now();
    this._msgCount = 0;
    this._recentMsgs = [];
    this._recentStderr = "";

    let buffer = "";
    this._process.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) this._processLine(line);
    });

    this._process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[codex-agent] stderr: ${text}`);
        // Keep the tail so an abrupt non-zero exit (no turn.failed event) can
        // surface Codex's real reason instead of a bare "code=2" (SHE-67).
        this._recentStderr = (this._recentStderr + "\n" + text).slice(-2000);
      }
    });

    proc.on("close", (code, signal) => {
      // Stale close: a newer turn already replaced this process, or stop()
      // nulled it. Stay out of the live turn's state — no finishTurn, no reset.
      if (this._process !== proc) return;
      if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
      if (buffer.trim()) this._processLine(buffer);
      this._process = null;
      this._clearWatchdog();
      console.log(`[codex-agent] exited code=${code} signal=${signal} (${Date.now() - this._startTime}ms, ${this._msgCount} msgs)`);
      const effSignal = this._exitSignal(code, signal);

      // Context-overflow auto-recovery (SHE-66): one codex process per phase,
      // so the chain advances here, after each process is fully gone. A kill
      // (user stop, watchdog) aborts the recovery honestly.
      if (this._recovery) {
        if (effSignal) {
          console.warn(`[codex-agent] overflow recovery aborted by ${effSignal}`);
          this._recovery = null;
          this._finishTurn({ subtype: effSignal === "SIGINT" ? "interrupted" : "stopped" });
          return;
        }
        if (this._recovery.phase === "compact-pending") {
          this._startRecoveryCompact();
          return;
        }
        if (this._recovery.phase === "resend-pending") {
          const prompt = this._recovery.prompt;
          this._recovery = null;
          console.warn(`[codex-agent] compaction done — retrying the original message`);
          this._compactTurn = false;
          this._spawnExec(prompt);
          return;
        }
        // "compacting" and the process died without turn.completed → give up.
        console.error(`[codex-agent] recovery compaction failed (code=${code}) — giving up`);
        this._recovery = null;
        this._finishTurn({ is_error: true, errors: [this._exitErrorMessage(code, signal)] });
        return;
      }

      // Synthetic turn_done if process exited without emitting one
      if (!this._turnResultEmitted) {
        const wasWatchdog = this._watchdogTriggered;
        this._watchdogTriggered = false;
        const isError = code !== 0 && effSignal !== "SIGTERM";
        // An abrupt overflow exit (stderr reason, no turn.failed event) can
        // still be auto-recovered: force-compact, then retry — the process is
        // already gone, so start the compact phase immediately.
        if (isError && this._scheduleOverflowRecovery(this._exitErrorMessage(code, signal))) {
          this._startRecoveryCompact();
          return;
        }
        this._finishTurn({
          is_error: isError,
          errors: isError ? [this._exitErrorMessage(code, signal)] : undefined,
          subtype: wasWatchdog ? "watchdog_timeout" : effSignal === "SIGINT" ? "interrupted" : effSignal === "SIGTERM" ? "stopped" : undefined,
        });
      }
    });

    this._resetWatchdog();
  }

  _processLine(line) {
    // Stop was pressed: the turn is already reported interrupted. Drop any
    // output codex emits while it winds down so it can't re-open the turn.
    if (this._interrupted) return;
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      console.warn(`[codex-agent] unparseable: ${line.slice(0, 200)}`);
      return;
    }
    this._msgCount++;
    const summary = `#${this._msgCount} (${Date.now() - this._startTime}ms): type=${event.type}`;
    if (this._msgCount <= 5 || this._msgCount % 50 === 0) {
      console.log(`[codex-agent] ${summary}`);
    }
    this._recentMsgs.push(summary);
    if (this._recentMsgs.length > 10) this._recentMsgs.shift();

    this._resetWatchdog();
    this._translate(event);
  }

  // --- Watchdog ---

  _resetWatchdog() {
    this._clearWatchdog();
    if (!this._isActive) return;
    const timeout = WATCHDOG_IDLE_MS;
    this._watchdog = setTimeout(() => {
      if (!this._isActive) return;
      console.error(`[codex-agent] Watchdog timeout — no message for ${timeout / 1000}s (${this._isResuming ? "resume" : "fresh"}), msgs=${this._msgCount}`);
      if (this._recentMsgs.length) {
        console.error(`[codex-agent] Last messages before timeout:`);
        for (const m of this._recentMsgs) console.error(`  ${m}`);
      }
      this._watchdogTriggered = true;
      if (this._process) {
        this._killTree(this._process, "SIGTERM");
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

  // Codex can exit non-zero WITHOUT emitting a turn.failed/error JSON event
  // (e.g. it prints "ran out of room in the model's context window" to stderr
  // and dies) — leaving the user with a cryptic "process exited code=2"
  // (SHE-67). Prefer the stderr tail so the real reason reaches the UI.
  _exitErrorMessage(code, signal) {
    const reason = this._recentStderr.trim();
    if (reason) {
      const last = reason.split("\n").filter(Boolean).pop();
      return last || `Codex exited unexpectedly (code=${code} signal=${signal}).`;
    }
    return `Codex exited unexpectedly (code=${code} signal=${signal}). This usually means it hit the model's context window — start a new chat or /compact.`;
  }

  _finishTurn(result) {
    this._isGenerating = false;
    this._streamingText = "";
    this.emit("turn_done", result);
  }

  // --- Context-overflow auto-recovery (SHE-66) ---
  // Once a thread is over the operative window, EVERY resume fails with "ran
  // out of room" — but a forced-compaction resume (limit=1) still succeeds
  // (verified on the live box: manual /compact recovered exactly this state).
  // So instead of painting the error and leaving the session bricked, do what
  // the user would: force-compact, then retry their message. Once per message.

  _scheduleOverflowRecovery(message) {
    if (this._recoveryUsed || this._compactTurn || !this._lastPrompt) return false;
    if (!CONTEXT_OVERFLOW_RE.test(message || "")) return false;
    this._recoveryUsed = true;
    this._recovery = { prompt: this._lastPrompt, phase: "compact-pending" };
    console.warn(`[codex-agent] context overflow ("${(message || "").slice(0, 100)}") — auto-compact + retry scheduled`);
    this.emit("error", { message: "Codex hit its context-window limit — compacting the conversation and retrying your message automatically…" });
    return true;
  }

  _startRecoveryCompact() {
    this._recovery.phase = "compacting";
    this._compactTurn = true;
    this._compactEmitted = false;
    this._spawnExec(COMPACT_ACK_PROMPT);
  }

  // --- Rollout-file token accounting (SHE-66/SHE-68) ---

  _observedContextWindow() {
    if (!this._contextWindow) {
      const info = this._readTokenInfo();
      if (info?.model_context_window) this._contextWindow = info.model_context_window;
    }
    return this._contextWindow;
  }

  /** Locate this thread's rollout JSONL under $CODEX_HOME/sessions (cached). */
  _rolloutPath() {
    if (this._rolloutFile && existsSync(this._rolloutFile)) return this._rolloutFile;
    if (!this._threadId) return null;
    const root = join(this._env.CODEX_HOME || join(process.env.HOME || "", ".codex"), "sessions");
    const suffix = `-${this._threadId}.jsonl`;
    try {
      // sessions/YYYY/MM/DD/rollout-<stamp>-<threadId>.jsonl — newest-first walk
      for (const y of readdirSync(root).sort().reverse()) {
        for (const m of readdirSync(join(root, y)).sort().reverse()) {
          for (const d of readdirSync(join(root, y, m)).sort().reverse()) {
            for (const f of readdirSync(join(root, y, m, d))) {
              if (f.endsWith(suffix)) {
                this._rolloutFile = join(root, y, m, d, f);
                return this._rolloutFile;
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[codex-agent] rollout scan failed under ${root}: ${err.message}`);
    }
    return null;
  }

  /** Last token_count info from the rollout tail, or null (logged). */
  _readTokenInfo() {
    const file = this._rolloutPath();
    if (!file) return null;
    try {
      const fd = openSync(file, "r");
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, 128 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        return parseRolloutTokenInfo(buf.toString("utf8"));
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      console.warn(`[codex-agent] rollout read failed (${file}): ${err.message}`);
      return null;
    }
  }

  _translate(event) {
    const type = event.type;

    switch (type) {
      case "thread.started": {
        // A resume can hand back a NEW thread id (and a new rollout file). The
        // cached path is only valid for the thread it was resolved for —
        // keeping it would read token counts from an abandoned conversation.
        if (event.thread_id && event.thread_id !== this._threadId) this._rolloutFile = null;
        this._threadId = event.thread_id || null;
        this._sessionId = this._threadId;
        this.emit("init", {
          sessionId: this._threadId,
          apiKeySource: "env",
        });
        break;
      }

      case "turn.started":
        // Internal state only — isGenerating already set in _spawnExec
        break;

      case "item.started": {
        const item = event.item;
        if (!item) break;

        if (item.type === "agentMessage" || item.type === "agent_message") {
          this._currentAgentId = item.id;
          this._currentAgentText = item.text || "";
        } else if (item.type === "commandExecution" || item.type === "command_execution") {
          this.emit("tool_start", { id: item.id, name: "Bash" });
          this.emit("tool_input", { id: item.id, input: { command: item.command || "" } });
        } else if (item.type === "fileChange" || item.type === "file_change") {
          const desc = (item.changes || []).map(c => `${c.kind || "modify"} ${c.path}`).join(", ");
          this.emit("tool_start", { id: item.id, name: "Edit" });
          this.emit("tool_input", { id: item.id, input: { description: desc, changes: item.changes } });
        } else if (item.type === "mcpToolCall" || item.type === "mcp_tool_call") {
          const name = `mcp__${item.server}__${item.tool}`;
          this.emit("tool_start", { id: item.id, name });
          this.emit("tool_input", { id: item.id, input: item.arguments || {} });
        } else if (item.type === "reasoning") {
          // Skip reasoning for now (internal model thinking)
        }
        break;
      }

      // Text streaming deltas (handle all naming variants)
      case "item.agentMessage.delta":
      case "item/agentMessage/delta":
      case "item.agent_message.delta":
      case "item/agent_message/delta": {
        if (this._compactTurn) break;
        const delta = event.delta || "";
        this._currentAgentText += delta;
        this._streamingText += delta;
        this.emit("text_delta", { text: delta });
        break;
      }

      // Command output streaming (no protocol equivalent, skip)
      case "item.commandExecution.outputDelta":
      case "item/commandExecution/outputDelta":
      case "item.command_execution.output_delta":
      case "item/command_execution/output_delta":
        break;

      case "item.completed": {
        const item = event.item;
        if (!item) break;

        if (item.type === "agentMessage" || item.type === "agent_message") {
          if (!this._compactTurn) {
            const text = item.text || this._currentAgentText || "";
            if (text) {
              this.emit("text_done", { text });
              this._streamingText = "";
            }
          }
          this._currentAgentText = "";
          this._currentAgentId = null;
        } else if (item.type === "commandExecution" || item.type === "command_execution") {
          const output = item.aggregated_output || item.aggregatedOutput || "";
          const exitCode = item.exit_code ?? item.exitCode;
          const isError = item.status === "failed" || (exitCode != null && exitCode !== 0);
          this.emit("tool_result", {
            id: item.id,
            content: output || (isError ? `Exit code: ${exitCode}` : "(no output)"),
            is_error: isError,
          });
        } else if (item.type === "fileChange" || item.type === "file_change") {
          const diffs = (item.changes || []).map(c => c.diff || "").join("\n");
          this.emit("tool_result", {
            id: item.id,
            content: diffs || "Changes applied",
          });
        } else if (item.type === "mcpToolCall" || item.type === "mcp_tool_call") {
          const result = item.result ? JSON.stringify(item.result) : item.error || "Done";
          this.emit("tool_result", {
            id: item.id,
            content: result,
            is_error: item.status === "failed",
          });
        } else if (item.type === "contextCompaction" || item.type === "context_compaction") {
          this._compactEmitted = true;
          this.emit("session_event", { event: "compacted" });
        } else if (item.type === "error") {
          console.warn(`[codex-agent] error item: ${item.message}`);
        }
        break;
      }

      case "turn.completed": {
        if (this._compactTurn && !this._compactEmitted) {
          this.emit("session_event", { event: "compacted" });
        }
        const wasCompact = this._compactTurn;
        this._compactTurn = false;
        this._turnResultEmitted = true;
        if (wasCompact && this._recovery?.phase === "compacting") {
          // Recovery compaction succeeded — the close handler resends the
          // original message. Keep the turn "generating" for the UI.
          this._recovery.phase = "resend-pending";
          break;
        }
        // Real occupancy + operative window come from the rollout file —
        // `event.usage` sums across the turn's API calls (SHE-68, see
        // codexUsage). Fall back to it (correct for single-call turns) only
        // when the rollout can't be read, loudly.
        const info = this._readTokenInfo();
        if (info?.model_context_window) this._contextWindow = info.model_context_window;
        let usage;
        if (info?.last_token_usage) {
          usage = { input_tokens: info.last_token_usage.total_tokens };
        } else if (wasCompact) {
          // A compaction just discarded the context and the rollout hasn't
          // flushed the post-compaction count yet. `event.usage` here is the
          // summarization call's own usage — the whole PRE-compaction context —
          // so reporting it would show the peak as the new occupancy (SHE-48).
          // Send no usage: the client cleared the meter on `compacted` and it
          // repopulates from the next real turn.
          usage = undefined;
          console.warn(`[codex-agent] compaction for ${this._threadId} completed before its post-compaction token_count was flushed — leaving the context meter cleared rather than reporting the pre-compaction peak`);
        } else {
          usage = codexUsage(event.usage);
          console.warn(`[codex-agent] no token_count in rollout for ${this._threadId} — falling back to turn.completed.usage (overcounts on multi-call turns)`);
        }
        this._finishTurn({ usage, context_window: this._contextWindow || undefined });
        break;
      }

      case "turn.failed": {
        const errorMsg = event.error?.message || "Turn failed";
        console.error(`[codex-agent] turn failed: ${errorMsg}`);
        if (this._recovery?.phase === "compacting") {
          // Even the forced compaction failed — surface the original wall.
          console.error(`[codex-agent] recovery compaction turn failed — giving up`);
          this._recovery = null;
          this._turnResultEmitted = true;
          this._compactTurn = false;
          this._finishTurn({ is_error: true, errors: [errorMsg] });
          break;
        }
        if (this._scheduleOverflowRecovery(errorMsg)) {
          // Suppress the error turn_done; the close handler chains compaction.
          this._turnResultEmitted = true;
          break;
        }
        this._turnResultEmitted = true;
        this._finishTurn({ is_error: true, errors: [errorMsg] });
        break;
      }

      case "error": {
        const errMsg = event.message || "Unknown error";
        console.warn(`[codex-agent] error: ${errMsg}`);
        this.emit("error", { message: errMsg });
        break;
      }

      case "thread/tokenUsage/updated":
      case "thread.tokenUsage.updated":
        break;

      case "turn.plan.updated":
      case "turn/plan/updated": {
        const plan = event.params?.plan || event.plan;
        if (plan) {
          const planText = plan.map(p => `${p.status === "completed" ? "[x]" : "[ ]"} ${p.step}`).join("\n");
          const explanation = event.params?.explanation || event.explanation;
          if (explanation) {
            const fullText = `\n**Plan:** ${explanation}\n${planText}\n`;
            this.emit("text_delta", { text: fullText });
            this.emit("text_done", { text: fullText });
          }
        }
        break;
      }

      default:
        if (type && !type.startsWith("thread.")) {
          console.log(`[codex-agent] unhandled event: ${type}`);
        }
        break;
    }
  }

}

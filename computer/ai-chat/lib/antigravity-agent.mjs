import { spawn } from "node:child_process";
import { CodingAgent } from "./coding-agent.mjs";
import { antigravityLayerArgs } from "./agent-layer.mjs";
import { cliModelForId } from "./model-catalog.mjs";

// A single agy turn can run for minutes (reasoning + tool use) emitting nothing
// until the final JSON blob, so bound the whole turn generously. agy's own
// --print-timeout is the inner ceiling; this outer one is the backstop.
const TURN_TIMEOUT_MS = 8 * 60 * 1000; // 8 min, matching the other adapters' watchdog

/**
 * AntigravityAgent — wraps Google's Antigravity CLI (`agy`) in non-streaming
 * print mode: `agy -p "<prompt>" --output-format json`.
 *
 * Unlike Claude/Codex/OpenCode, agy exposes NO event stream — each turn returns
 * a single final JSON envelope, so there are no text_delta / live tool events:
 * the whole answer lands at once as one text_done. Like Codex this is per-turn
 * spawning; multi-turn resumes via `--conversation <conversation_id>` (agy
 * persists history server-side and only reveals the id in the result).
 *
 * Envelope (verified against agy 1.0.16):
 *   {"conversation_id","status":"SUCCESS|ERROR","response","error?",
 *    "duration_seconds","num_turns",
 *    "usage":{input_tokens,output_tokens,thinking_tokens,total_tokens}}
 */
export class AntigravityAgent extends CodingAgent {
  constructor(opts) {
    super(opts);
    // agy authenticates via its own Google OAuth token. A GEMINI_API_KEY /
    // GOOGLE_API_KEY in the environment (often ambient on the box) hijacks that —
    // agy switches to the API-key backend and returns degraded no-op turns (empty
    // response, zero usage). Strip them so agy always uses the signed-in token.
    this._env = stripGoogleApiKeys(this._env);
    this._process = null;
    this._conversationId = opts.sessionId || null;
    this._isFirstTurn = !opts.sessionId;
    this._stdout = "";
    this._stderr = "";
    this._turnDone = false;
    this._timedOut = false;
    this._timeout = null;
    this._startTime = null;
  }

  // Non-streaming: nothing is buffered mid-turn, and there is no persistent
  // process to wedge — so no streaming text and never broken/dead.
  get streamingText() { return ""; }
  get isBroken() { return false; }
  get isDead() { return false; }

  start() {
    this._isActive = true;
    // Per-turn spawn — nothing runs until sendMessage().
  }

  sendMessage(content) {
    this._spawnTurn(normalizeContent(content));
  }

  interrupt() {
    if (this._process) {
      console.log("[antigravity] interrupt — SIGTERM");
      this._process.kill("SIGTERM");
    }
    if (this._isGenerating && !this._turnDone) {
      this._isGenerating = false;
      this._turnDone = true;
      this._clearTimeout();
      this.emit("turn_done", { subtype: "interrupted" });
    }
  }

  stop() {
    console.log(`[antigravity] stop() — pid=${this._process?.pid || "none"}`);
    this._clearTimeout();
    if (this._process) { this._process.kill("SIGTERM"); this._process = null; }
    this._isActive = false;
    this._isGenerating = false;
  }

  // --- Process management ---

  _spawnTurn(prompt) {
    const cliModel = cliModelForId(this._model);
    const resuming = !this._isFirstTurn && !!this._conversationId;
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--print-timeout", "7m",
      // Session-scoped ShellTeam plugin: same prompt, skills, and MCP servers
      // as the other cockpit agents, without installing anything in ~/.gemini.
      ...antigravityLayerArgs(this._cwd),
    ];
    if (cliModel) args.push("--model", cliModel);
    if (resuming) args.push("--conversation", this._conversationId);

    this._isFirstTurn = false;
    this._turnDone = false;
    this._timedOut = false;
    this._isGenerating = true;
    this._stdout = "";
    this._stderr = "";
    this._startTime = Date.now();

    console.log(`[antigravity] spawn: agy -p … --output-format json${resuming ? ` --conversation ${this._conversationId}` : " (fresh)"} --model "${cliModel}"`);

    // agy emits nothing until the final blob, so announce the turn start now or
    // the cockpit looks idle. On a fresh turn we don't have a conversation id yet
    // (it arrives in the result) — a second init below pins it once we do.
    this.emit("init", { sessionId: this._conversationId || undefined, apiKeySource: "oauth" });

    this._process = spawn("agy", args, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._process.stdout.on("data", (d) => { this._stdout += d.toString(); });
    this._process.stderr.on("data", (d) => {
      const t = d.toString();
      this._stderr += t;
      const line = t.trim();
      if (line) console.error(`[antigravity] stderr: ${line.slice(0, 200)}`);
    });

    this._process.on("error", (err) => {
      console.error(`[antigravity] process error: ${err.message}`);
      this._process = null;
      this._clearTimeout();
      this._finishError(this._processErrorMessage("Antigravity", err, null));
    });

    this._process.on("close", (code, signal) => this._onClose(code, signal));

    this._timeout = setTimeout(() => {
      console.error(`[antigravity] turn timeout after ${TURN_TIMEOUT_MS / 1000}s — killing`);
      this._timedOut = true;
      if (this._process) this._process.kill("SIGTERM");
    }, TURN_TIMEOUT_MS);
  }

  _onClose(code, signal) {
    const pid = this._process?.pid;
    this._process = null;
    this._clearTimeout();
    console.log(`[antigravity] exited pid=${pid} code=${code} signal=${signal} (${Date.now() - this._startTime}ms)`);

    // Stopped/replaced, or interrupt() already reported the turn.
    if (this._turnDone || !this._isActive) return;
    this._turnDone = true;
    this._isGenerating = false;

    if (this._timedOut) {
      this._timedOut = false;
      this.emit("turn_done", { is_error: true, subtype: "watchdog_timeout" });
      return;
    }
    if (signal === "SIGTERM") {
      this.emit("turn_done", { subtype: "stopped" });
      return;
    }

    const env = this._parseEnvelope();
    if (!env) {
      const msg = this._stderr.trim().split("\n").pop() || `agy exited ${code} with no JSON output`;
      this.emit("error", { message: msg });
      this.emit("turn_done", { is_error: true, errors: [msg] });
      return;
    }

    // The resumable conversation id only appears in the result — capture it and
    // re-emit init so the session manager pins the family + persists history.
    if (env.conversation_id && env.conversation_id !== this._conversationId) {
      this._conversationId = env.conversation_id;
      this._sessionId = env.conversation_id;
      this.emit("init", { sessionId: this._conversationId, apiKeySource: "oauth" });
    }

    const isError = !!env.status && env.status !== "SUCCESS";
    if (env.response) {
      this.emit("text_done", { text: String(env.response).replace(/\n+$/, "") });
    } else if (isError && env.error) {
      this.emit("error", { message: env.error });
    }

    this.emit("turn_done", {
      usage: env.usage ? {
        input_tokens: env.usage.input_tokens,
        output_tokens: env.usage.output_tokens,
        total_tokens: env.usage.total_tokens,
        thinking_tokens: env.usage.thinking_tokens,
      } : undefined,
      is_error: isError,
      errors: isError ? [env.error || `agy status ${env.status}`] : undefined,
    });
  }

  _finishError(message) {
    if (this._turnDone || !this._isActive) return;
    this._turnDone = true;
    this._isGenerating = false;
    this.emit("error", { message });
    this.emit("turn_done", { is_error: true, errors: [message] });
  }

  // agy prints one JSON object; tolerate any leading log noise before it.
  _parseEnvelope() {
    const s = this._stdout.trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch { /* fall through to slice */ }
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch { /* unparseable */ }
    }
    console.warn(`[antigravity] unparseable envelope: ${s.slice(0, 300)}`);
    return null;
  }

  _clearTimeout() {
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
  }
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return String(content);
}

function stripGoogleApiKeys(env) {
  const clean = { ...(env || {}) };
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]) delete clean[k];
  return clean;
}

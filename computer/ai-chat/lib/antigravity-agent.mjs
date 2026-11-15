import { spawn } from "node:child_process";
import { splitContent, textWithImagePaths } from "./attachments.mjs";
import { CodingAgent } from "./coding-agent.mjs";
import { antigravityLayerArgs } from "./agent-layer.mjs";
import { cliModelForId } from "./model-catalog.mjs";

// agy's own --print-timeout is the inner ceiling; this outer one is the backstop.
const TURN_TIMEOUT_MS = 8 * 60 * 1000; // 8 min, matching the other adapters' watchdog

// agy tool names → the cockpit's tool vocabulary, with the input keys the
// chat's previews read. Anything else shows under agy's own name.
const TOOLS = {
  run_command: ["Bash", (p) => ({ command: p.CommandLine ?? "" })],
  read_file: ["Read", (p) => ({ file_path: p.Path ?? p.AbsolutePath ?? "" })],
  view_file: ["Read", (p) => ({ file_path: p.AbsolutePath ?? p.Path ?? "" })],
  edit_file: ["Edit", (p) => ({ file_path: p.Path ?? p.TargetFile ?? "" })],
  replace_file_content: ["Edit", (p) => ({ file_path: p.TargetFile ?? p.Path ?? "" })],
  multi_replace_file_content: ["Edit", (p) => ({ file_path: p.TargetFile ?? p.Path ?? "" })],
  write_file: ["Write", (p) => ({ file_path: p.Path ?? p.TargetFile ?? "" })],
  write_to_file: ["Write", (p) => ({ file_path: p.TargetFile ?? p.Path ?? "" })],
};

function toolOf(info) {
  const name = info?.name || "tool";
  const params = info?.parameters || {};
  if (name === "call_mcp_tool") {
    return { name: `mcp__${params.ServerName}__${params.ToolName}`, input: params.Arguments || {} };
  }
  const known = TOOLS[name];
  return known ? { name: known[0], input: known[1](params) } : { name, input: params };
}

const LOCATION = /user location is not supported/i;

/** An agy error as the owner reads it. Google refuses Gemini by the location
 * it sees for the server (its network and the account's country), not by the
 * plan: say that in plain words, keeping Google's own text. */
export function agyErrorInWords(error) {
  const text = String(error || "Antigravity failed with no message.").trim();
  if (LOCATION.test(text)) {
    return "Google refused Gemini for this server's location, so Antigravity cannot answer from here "
      + "with your Google plan. Google decides this from the network the server is on and your "
      + `account's country. Google said: "${text}"`;
  }
  return `Antigravity: ${text}`;
}

/**
 * AntigravityAgent wraps Google's Antigravity CLI (`agy` >= 1.5) in streaming
 * print mode: `agy -p "<prompt>" --output-format stream-json`, one process per
 * turn (like Codex), resumed with `--conversation <id>`.
 *
 * The stream (recorded from agy 1.5.9, test/fixtures/agy/):
 *   {"event":"init","conversation_id",init:{model,cwd,tools,permission_mode}}
 *   {"event":"step_update","step_update":{step_index,state:ACTIVE|DONE,step_type,...}}
 *      agent_response: text_delta pieces; DONE carries this step's usage
 *      tool: tool_name + tool_info{name,parameters,output}; ACTIVE then DONE
 *      user_input, system_message, error_message: nothing to show
 *   {"event":"result","result":{status:SUCCESS|ERROR,response,error,usage,finished_reason}}
 * A failed turn also exits 3 with an `AGY_ERROR: {...}` line on stderr.
 */
export class AntigravityAgent extends CodingAgent {
  constructor(opts) {
    super(opts);
    // agy authenticates via its own Google sign-in. A GEMINI_API_KEY /
    // GOOGLE_API_KEY in the environment (often ambient on the box) switches it
    // to the API-key backend instead of the owner's plan. Strip them.
    this._env = stripGoogleApiKeys(this._env);
    this._process = null;
    this._conversationId = opts.sessionId || null;
    this._isFirstTurn = !opts.sessionId;
    this._resetTurn();
    this._timedOut = false;
    this._timeout = null;
    this._startTime = null;
  }

  _resetTurn() {
    this._buffer = "";
    this._stderr = "";
    this._turnDone = false;
    this._streamingText = "";
    this._tools = new Set();     // step indexes whose tool_start went out
    this._lastUsage = null;      // the last model call's usage: the context size
    this._result = null;
    this._requested = null;
  }

  get streamingText() { return this._streamingText; }
  get isBroken() { return false; }
  get isDead() { return false; }

  start() {
    this._isActive = true;
    // Per-turn spawn: nothing runs until sendMessage().
  }

  sendMessage(content) {
    this._send(normalizeContent(content));
  }

  _send(prompt) {
    if (this._queueIfBusy(prompt)) return;
    this._spawnTurn(prompt);
  }

  interrupt() {
    const dropped = this._queued.length > 0;
    this._queued = [];  // a queued follow-up would resurrect the cancelled turn
    if (this._process) {
      console.log("[antigravity] interrupt — SIGTERM");
      this._process.kill("SIGTERM");
    }
    if (this._isGenerating && !this._turnDone) {
      this._isGenerating = false;
      this._turnDone = true;
      this._clearTimeout();
      this.emit("turn_done", this._interruptedTurnDone(dropped));
    }
  }

  stop() {
    console.log(`[antigravity] stop() — pid=${this._process?.pid || "none"}`);
    this._clearTimeout();
    this._queued = [];
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
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout", "7m",
      // Session-scoped ShellTeam plugin: same prompt, skills, and MCP servers
      // as the other cockpit agents, without installing anything in ~/.gemini.
      ...antigravityLayerArgs(this._cwd),
    ];
    if (cliModel) args.push("--model", cliModel);
    if (resuming) args.push("--conversation", this._conversationId);

    this._isFirstTurn = false;
    this._resetTurn();
    this._requested = resuming ? this._conversationId : null;
    this._timedOut = false;
    this._isGenerating = true;
    this._startTime = Date.now();

    console.log(`[antigravity] spawn: agy -p … --output-format stream-json${resuming ? ` --conversation ${this._conversationId}` : " (fresh)"} --model "${cliModel}"`);

    this._process = spawn("agy", args, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._process.stdout.on("data", (d) => {
      this._buffer += d.toString();
      let nl;
      while ((nl = this._buffer.indexOf("\n")) >= 0) {
        const line = this._buffer.slice(0, nl).trim();
        this._buffer = this._buffer.slice(nl + 1);
        if (line) this._onLine(line);
      }
    });
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

    this._process.on("close", (code, signal) => {
      if (this._buffer.trim()) this._onLine(this._buffer.trim());
      this._buffer = "";
      this._onClose(code, signal);
      this._drainQueue();
    });

    this._timeout = setTimeout(() => {
      console.error(`[antigravity] turn timeout after ${TURN_TIMEOUT_MS / 1000}s — killing`);
      this._timedOut = true;
      if (this._process) this._process.kill("SIGTERM");
    }, TURN_TIMEOUT_MS);
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      console.warn(`[antigravity] not a stream event: ${line.slice(0, 300)}`);
      return;
    }
    if (this._turnDone) return;
    if (msg.event === "init") return this._onInit(msg.conversation_id);
    if (msg.event === "step_update") return this._onStep(msg.step_update || {});
    if (msg.event === "result") this._result = msg.result || {};
  }

  _onInit(conversationId) {
    if (!conversationId) return;
    if (this._requested && conversationId !== this._requested) {
      // agy answers an unknown id with a fresh conversation and a warning on
      // stderr only: the agent has lost the earlier context, so say it.
      console.warn(`[antigravity] conversation ${this._requested} not found — agy started ${conversationId}`);
      this.emit("error", { message: "Antigravity: the earlier conversation was not found on Google's side, "
        + "so this reply starts a new one without the earlier context." });
    }
    this._conversationId = conversationId;
    this._sessionId = conversationId;
    this.emit("init", { sessionId: conversationId, apiKeySource: "oauth" });
  }

  _onStep(step) {
    const id = `agy-${this._conversationId}-${step.step_index}`;
    if (step.step_type === "agent_response") {
      if (step.text_delta) {
        this._streamingText += step.text_delta;
        if (step.state !== "DONE" || this._streamingText.trim()) this.emit("text_delta", { text: step.text_delta });
      }
      if (step.state === "DONE") {
        if (step.usage) this._lastUsage = step.usage;
        const text = this._streamingText.replace(/\n+$/, "");
        if (text.trim()) this.emit("text_done", { text });
        this._streamingText = "";
      }
      return;
    }
    if (step.step_type === "tool") {
      if (!this._tools.has(id)) {
        this._tools.add(id);
        const tool = toolOf(step.tool_info || { name: step.tool_name });
        this.emit("tool_start", { id, name: tool.name });
        this.emit("tool_input", { id, input: tool.input });
      }
      if (step.state === "DONE") {
        const output = step.tool_info?.output;
        this.emit("tool_result", { id, content: output ? String(output) : "Done" });
      }
    }
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

    const result = this._result;
    if (!result || result.status !== "SUCCESS") {
      const raw = result?.error || agyStderrError(this._stderr)
        || this._stderr.trim().split("\n").pop() || `agy exited ${code} with no result`;
      const message = agyErrorInWords(raw);
      this.emit("error", { message });
      this.emit("turn_done", { is_error: true, errors: [message] });
      return;
    }
    const last = this._lastUsage || {};
    this.emit("turn_done", {
      usage: {
        input_tokens: last.input_tokens ?? result.usage?.input_tokens,
        cache_read_input_tokens: last.cache_read_tokens ?? 0,
        output_tokens: result.usage?.output_tokens,
        thinking_tokens: result.usage?.thinking_tokens,
      },
      is_error: false,
    });
  }

  _finishError(message) {
    if (this._turnDone || !this._isActive) return;
    this._turnDone = true;
    this._isGenerating = false;
    this.emit("error", { message });
    this.emit("turn_done", { is_error: true, errors: [message] });
  }

  _clearTimeout() {
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
  }
}

/** The short error of agy's `AGY_ERROR: {...}` stderr line, if any. */
function agyStderrError(stderr) {
  const line = stderr.split("\n").find((l) => l.startsWith("AGY_ERROR:"));
  if (!line) return null;
  try { return JSON.parse(line.slice("AGY_ERROR:".length)).short_error || null; } catch { return null; }
}

function normalizeContent(content) {
  return textWithImagePaths(splitContent(content));
}

function stripGoogleApiKeys(env) {
  const clean = { ...(env || {}) };
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]) delete clean[k];
  return clean;
}

import { loadModel, getCliEnv } from "./session.mjs";
import { agentLaunchEnv, terminalSpawn } from "./agents/registry.mjs";
import { HOME } from "./constants.mjs";

let pty = null;
try {
  pty = (await import("node-pty")).default;
} catch {
  // node-pty not installed — terminal mode unavailable
}

let ptyProcess = null;
let currentSessionId = null;
const terminalSockets = new Set();

export function isAvailable() {
  return !!pty;
}

export function addSocket(ws) {
  terminalSockets.add(ws);
  ws.on("close", () => terminalSockets.delete(ws));
}

export function getSocketCount() {
  return terminalSockets.size;
}

/**
 * Spawn the CLI in interactive (TUI) mode.
 *
 * @param {Function} killChatCLI - callback to kill the chat adapter
 * @param {Object} [opts] - optional overrides
 * @param {string} [opts.sessionId] - resume a specific session (console mode)
 * @param {string} [opts.model] - model override
 * @param {string} [opts.cwd] - working directory override
 */
export function spawn_(killChatCLI, opts = {}) {
  if (!pty) return false;
  if (ptyProcess) return true; // already running

  // Kill chat CLI for mutual exclusion
  killChatCLI();

  const model = opts.model || loadModel();
  const cwd = opts.cwd || HOME;
  const env = agentLaunchEnv(model, getCliEnv(cwd));
  env.TERM = "xterm-256color";
  const { cmd, args } = terminalSpawn(model, { sessionId: opts.sessionId, cwd });

  currentSessionId = opts.sessionId || null;

  ptyProcess = pty.spawn(cmd, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env,
  });

  ptyProcess.onData((data) => {
    const msg = JSON.stringify({ type: "terminal_data", data });
    for (const ws of terminalSockets) {
      if (ws.readyState === 1) ws.send(msg);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[ai-chat] Terminal PTY exited code=${exitCode}`);
    ptyProcess = null;
    currentSessionId = null;
    const msg = JSON.stringify({ type: "terminal_exit", code: exitCode });
    for (const ws of terminalSockets) {
      if (ws.readyState === 1) ws.send(msg);
    }
  });

  console.log(`[ai-chat] Terminal PTY spawned (session=${opts.sessionId || "new"}, model=${model})`);
  return true;
}

// Keep backward compat: export spawn_ as spawn
export { spawn_ as spawn };

export function handleMessage(ws, msg) {
  if (!ptyProcess) return;
  if (msg.type === "terminal_data" && typeof msg.data === "string") {
    ptyProcess.write(msg.data);
  } else if (msg.type === "terminal_resize" && msg.cols && msg.rows) {
    ptyProcess.resize(msg.cols, msg.rows);
  }
}

export function kill() {
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcess = null;
    currentSessionId = null;
  }
}

export function isRunning() {
  return !!ptyProcess;
}

export function getCurrentSessionId() {
  return currentSessionId;
}

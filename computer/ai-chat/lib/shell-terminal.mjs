// A plain login-shell terminal over WebSocket — one bash pty PER CONNECTION,
// killed when the socket closes. This is the human's console: it coexists
// with the chat agents (no mutual exclusion), unlike terminal-bridge.mjs
// (Console Mode), whose single pty runs the agent CLI TUI and must displace
// the chat adapter that owns the same session.
//
// Security: this endpoint grants nothing the chat agents don't already have —
// they run unrestricted shell commands in this same process's environment.
// Reachability is gated upstream exactly like every other cockpit route
// (owner token / guest cookie at the FastAPI proxy).
import { HOME, WORKSPACE_LOCK } from "./constants.mjs";

let pty = null;
try {
  pty = (await import("node-pty")).default;
} catch {
  // node-pty not installed — shell terminal unavailable
}

export function shellAvailable() {
  return !!pty;
}

/** Wire one WebSocket to its own fresh shell pty (same wire protocol as
 * Console Mode: terminal_data / terminal_resize / terminal_exit). */
export function attachShellSocket(ws) {
  if (!pty) {
    ws.send(JSON.stringify({
      type: "terminal_error",
      error: "Terminal not available (node-pty not installed)",
    }));
    ws.close();
    return null;
  }

  const shell = process.env.SHELL || "/bin/bash";
  const proc = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    // Start where the guest works: the pinned workspace (their project) when
    // set, else HOME — mirrors where the chat agents spawn.
    cwd: WORKSPACE_LOCK || HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  console.log(`[ai-chat] Shell terminal spawned (pid=${proc.pid}, shell=${shell})`);

  proc.onData((data) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "terminal_data", data }));
  });
  proc.onExit(({ exitCode }) => {
    console.log(`[ai-chat] Shell terminal exited (pid=${proc.pid}, code=${exitCode})`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "terminal_exit", code: exitCode }));
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    if (msg.type === "terminal_data" && typeof msg.data === "string") {
      proc.write(msg.data);
    } else if (msg.type === "terminal_resize" && msg.cols > 0 && msg.rows > 0) {
      proc.resize(msg.cols, msg.rows);
    }
  });
  ws.on("close", () => proc.kill());
  return proc;
}

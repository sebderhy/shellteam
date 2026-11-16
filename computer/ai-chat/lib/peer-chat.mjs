/**
 * peer-chat.mjs — which chat is behind a local connection (SHE-170).
 *
 * The cockpit starts each chat's agent with SHELLTEAM_CHAT=<slot id> in its
 * environment. Whatever that agent launches (its browser tool, a shell
 * command) is a descendant of it. So for a connection from this machine, the
 * process that owns the connection's source port is found, and its ancestors
 * are walked until one carries SHELLTEAM_CHAT. Nothing is asked of the agent,
 * and a process cannot pass for another chat's.
 *
 * Linux only (/proc and `ss`), like the rest of the box.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** pid of the local process whose socket has this source port, or null. */
export function pidOfLocalPort(port, run = execFileSync) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let out;
  try {
    out = run("ss", ["-Htnp", `sport = :${port}`], { encoding: "utf8", timeout: 3000 });
  } catch (e) {
    console.error(`[peer-chat] ss failed for port ${port}: ${e.message}`);
    return null;
  }
  const m = /pid=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

const defaultProc = {
  environ: (pid) => readFileSync(`/proc/${pid}/environ`, "utf8"),
  // Field 4 of /proc/<pid>/stat, after the "(comm)" which may contain spaces.
  parent: (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().split(" ")[1]),
};

/** The chat (slot id, as a string) a pid belongs to, or null. */
export function chatOfPid(pid, proc = defaultProc) {
  for (let hops = 0; pid > 1 && hops < 40; hops++) {
    let env;
    try { env = proc.environ(pid); } catch { return null; }   // gone, or not ours to read
    const m = /(?:^|\0)SHELLTEAM_CHAT=(\d{1,9})(?:\0|$)/.exec(env);
    if (m) return m[1];
    try { pid = proc.parent(pid); } catch { return null; }
  }
  return null;
}

export const chatOfLocalPort = (port) => {
  const pid = pidOfLocalPort(port);
  return pid ? chatOfPid(pid) : null;
};

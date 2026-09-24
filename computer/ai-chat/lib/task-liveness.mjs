// Liveness of a Claude Code background Bash task, judged by its process, not
// by silence (SHE-93). The harness runs `run_in_background` commands in a
// shell whose stdout/stderr are the task's output file; the shell (and every
// child inheriting those fds) keeps the file open for WRITING until the
// command exits. So "someone holds the output file open for writing" is true
// exactly while the task runs, and false the moment it finishes — however
// long it stays quiet in between. The CLI itself does not hold the file.
import { readdirSync, readlinkSync, readFileSync } from "node:fs";

const O_ACCMODE = 0o3;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;

function fdIsWritable(pid, fd) {
  try {
    const info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
    const flags = parseInt(info.match(/^flags:\s*(\d+)/m)?.[1] || "0", 8);
    const mode = flags & O_ACCMODE;
    return mode === O_WRONLY || mode === O_RDWR;
  } catch {
    return false;
  }
}

/**
 * True when at least one process on this box has `path` open for writing.
 * Only processes of the same user are inspectable, which is exactly the set
 * the cockpit spawns. Linux-only (/proc), like the rest of ShellTeam.
 */
export function hasWriter(path) {
  let pids;
  try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); }
  catch { return false; }
  for (const pid of pids) {
    let fds;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (target === path && fdIsWritable(pid, fd)) return true;
    }
  }
  return false;
}

/**
 * report-writes.mjs — which chat produced which report, recorded when it happens (SHE-177).
 *
 * The Reports tab groups reports by project. Its first evidence is a Write
 * tool call in a Claude transcript, which Codex, OpenCode and Antigravity
 * never leave: they write through a shell command, a build script, a patch.
 * The cockpit sees every agent's turn, so it records the write itself.
 *
 * The evidence is two facts together, checked when a turn ends:
 *   1. the turn named the report (in the agent's reply or in a tool call), and
 *   2. the file under ~/reports changed while that turn was running.
 * A chat that only links or lists an older report fails (2), so mentions still
 * do not attribute. api/services/report_catalog.py reads the record.
 */

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME, REPORT_WRITES_FILE } from "./constants.mjs";

// Same document types as REPORT_EXTS in api/services/report_catalog.py.
const REPORT_PATH = /reports\/((?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html|md|pdf|mp3|mp4|wav))(?![A-Za-z0-9])/g;

/** What the agent itself said and did in the turn that just ended. Tool
 *  OUTPUT is left out on purpose: a directory listing names every report. */
function agentTextOfLastTurn(history) {
  const parts = [];
  // The turn's own turn_done is already the last entry; the one before it ends
  // the previous turn. A message the owner sent mid-turn does not end a turn.
  for (let i = history.length - 2; i >= 0; i--) {
    const m = history[i];
    if (m.type === "turn_done") break;
    if (m.type === "text_done" && m.text) parts.push(m.text);
    else if (m.type === "tool_input" && m.input !== undefined) parts.push(typeof m.input === "string" ? m.input : JSON.stringify(m.input));
  }
  return parts.join("\n");
}

/** Reports named by the last turn whose file changed since `turnStartedAt`. */
export function reportsWrittenInTurn({ history, turnStartedAt, reportsDir = join(HOME, "reports") }) {
  if (!turnStartedAt) return [];
  const named = new Set([...agentTextOfLastTurn(history).matchAll(REPORT_PATH)].map((m) => m[1]));
  return [...named].filter((rel) => {
    const st = statSync(join(reportsDir, rel), { throwIfNoEntry: false });
    return st?.isFile() && st.mtimeMs >= turnStartedAt;
  });
}

/** Append one line per report this turn wrote. Returns what was recorded. */
export function recordTurnReports({ history, turnStartedAt, cwd, sessionId, reportsDir, file = REPORT_WRITES_FILE }) {
  const written = reportsWrittenInTurn({ history, turnStartedAt, reportsDir });
  if (!written.length) return written;
  mkdirSync(dirname(file), { recursive: true });
  const ts = Date.now();
  appendFileSync(file, written.map((rel) => JSON.stringify({ report: rel.split("/").pop(), cwd, session: sessionId || "", ts }) + "\n").join(""));
  console.log(`[report-writes] ${cwd}: recorded ${written.join(", ")}`);
  return written;
}

/**
 * transcript-keep.mjs — an open tab never loses its conversation (SHE-173).
 *
 * Claude Code deletes a transcript that has not been written to for
 * `cleanupPeriodDays` (30 by default), every time any `claude` starts. A tab
 * the owner comes back to after a month then had no transcript: it showed
 * empty and silently started a fresh conversation.
 *
 * The cockpit owns its tabs, so it keeps a second hard link to the transcript
 * of every open tab under its own state folder. Claude appends to the same
 * file, so the link is always current and costs no disk. When Claude deletes
 * its name for the file, ours remains, and the transcript is linked back
 * before the tab is read or resumed. Closing a tab releases the link.
 */
import { copyFileSync, linkSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CLAUDE_TRANSCRIPT_KEEP_DIR as KEEP_DIR } from "./constants.mjs";
import { CLAUDE_PROJECTS_DIR, findJsonlUnder } from "./history.mjs";

/** Hard link, or a dated copy when the two folders sit on different disks. */
function linkOrCopy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    copyFileSync(from, to);
    const { atime, mtime } = statSync(from);
    utimesSync(to, atime, mtime);
  }
}

function sameFile(a, b) {
  const sa = statSync(a), sb = statSync(b);
  return sa.ino === sb.ino && sa.dev === sb.dev
    || (sa.dev !== sb.dev && sa.size === sb.size && sa.mtimeMs === sb.mtimeMs);
}

/**
 * Keep (or bring back) one tab's Claude transcript. A no-op for ids that are
 * not Claude sessions. Returns "restored" when a deleted transcript was put
 * back, so callers can log it.
 */
export function keepClaudeTranscript(sessionId) {
  const live = findJsonlUnder(CLAUDE_PROJECTS_DIR, sessionId);
  const kept = findJsonlUnder(KEEP_DIR, sessionId);
  if (!live) {
    if (!kept) return null;
    const target = join(CLAUDE_PROJECTS_DIR, relative(KEEP_DIR, kept));
    linkOrCopy(kept, target);
    console.warn(`[transcript-keep] Claude Code had deleted the transcript of session ${sessionId}; restored it to ${target}`);
    return "restored";
  }
  const want = join(KEEP_DIR, relative(CLAUDE_PROJECTS_DIR, live));
  if (kept === want && sameFile(kept, live)) return null;
  if (kept) unlinkSync(kept);
  linkOrCopy(live, want);
  return "kept";
}

function keptFiles(dir = KEEP_DIR) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries.flatMap((e) => e.isDirectory() ? keptFiles(join(dir, e.name))
    : e.name.endsWith(".jsonl") ? [join(dir, e.name)] : []);
}

/**
 * Keep the transcripts of exactly these sessions (the open tabs) and release
 * every other link, so a closed tab falls back to Claude Code's own retention.
 */
export function syncKeptTranscripts(sessionIds) {
  const open = new Set(sessionIds.filter(Boolean));
  for (const id of open) keepClaudeTranscript(id);
  for (const file of keptFiles()) {
    const id = file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
    if (open.has(id)) continue;
    unlinkSync(file);
    console.log(`[transcript-keep] released ${id} (its tab is closed)`);
  }
}

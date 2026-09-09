/**
 * history.mjs — Session listing, JSONL parsing, and file helpers.
 *
 * In-memory history management has moved to SessionManager.
 * This module only handles:
 *   - Listing past sessions (Claude + Codex JSONL files)
 *   - Reading session files for replay (converting to protocol format)
 *   - Finding and truncating session files (for rewind)
 *   - File helpers (safe paths, file listing, @file expansion)
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { spawn } from "node:child_process";
import { HOME, CODEX_HISTORY_DIR } from "./constants.mjs";
import { agentIdFor } from "./agents/registry.mjs";
import { uuid4 } from "./portable/csf.mjs";

// Cockpit lineage markers (handoff / fork session_events) are ShellTeam metadata,
// not part of a CLI's own transcript. For Codex/Gemini/OpenCode they live in the
// cockpit protocol JSONL that replay reads directly. Claude owns its native
// .jsonl, so we persist markers INTO it as an isMeta user line carrying this
// sentinel + the JSON payload: Claude tolerates/ignores isMeta lines on resume,
// and readSessionForReplay re-surfaces them as structured session_events — so the
// "visible on replay" invariant holds for Claude targets too, not just the rest.
export const SESSION_MARKER_PREFIX = "[shellteam:session_event] ";

// --- Session CWD extraction ---

export function cwdFromSessionPath(sessionPath) {
  const projectDirName = basename(dirname(sessionPath));
  const homeEncoded = HOME.replaceAll("/", "-");

  if (projectDirName === homeEncoded) return HOME;
  if (!projectDirName.startsWith(homeEncoded + "-")) return HOME;

  const suffix = projectDirName.slice(homeEncoded.length); // e.g. "-projects-myapp"

  // Try naive decode: all hyphens are path separators
  const naivePath = HOME + suffix.replaceAll("-", "/");
  try {
    if (statSync(naivePath).isDirectory()) return naivePath;
  } catch {}

  // Backtracking: at each hyphen, try "/" or "-" to handle hyphenated dir names
  // e.g. "-projects-mcp-app-template" → /projects/mcp-app-template
  const parts = suffix.slice(1).split("-");
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

  // basePath = confirmed parent dir, segment = current dir name being built
  const solve = (idx, basePath, segment) => {
    if (idx === parts.length) {
      const full = basePath + "/" + segment;
      return isDir(full) ? full : null;
    }
    // Try "/" here: commit segment as a directory, start new segment with parts[idx]
    const dirPath = basePath + "/" + segment;
    if (isDir(dirPath)) {
      const result = solve(idx + 1, dirPath, parts[idx]);
      if (result) return result;
    }
    // Try "-" here: extend current segment name (hyphenated dir name)
    return solve(idx + 1, basePath, segment + "-" + parts[idx]);
  };
  const result = parts.length > 0 ? solve(1, HOME, parts[0]) : null;
  if (result) return result;

  return HOME;
}

// --- Find session file ---

export function findSessionFile(sessionId) {
  // Check Codex history first (fast, flat directory)
  const codexPath = join(CODEX_HISTORY_DIR, sessionId + ".jsonl");
  if (existsSync(codexPath)) return codexPath;

  // Search Claude Code projects (recursive)
  const projectsDir = join(HOME, ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  const target = sessionId + ".jsonl";
  const search = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = search(join(dir, entry.name));
        if (found) return found;
      } else if (entry.name === target) {
        return join(dir, entry.name);
      }
    }
    return null;
  };
  return search(projectsDir);
}

/**
 * Resolve which agent family owns a session ID, so we never resume a session
 * with the wrong CLI (e.g. `claude --resume <codex-thread-id>`, which fails with
 * "No conversation found"). Returns "codex" | "claude" | "opencode" | null.
 * null means "unknown" — caller should not treat that as a mismatch.
 */
export function familyOfSession(sessionId) {
  if (!sessionId) return null;
  // OpenCode session IDs are distinctively prefixed and not stored as JSONL files.
  if (sessionId.startsWith("ses_")) return "opencode";
  const file = findSessionFile(sessionId);
  if (!file) return null;
  if (!file.startsWith(CODEX_HISTORY_DIR)) return "claude";
  // CODEX_HISTORY_DIR holds ALL cockpit-owned histories (Codex, Gemini, …), so
  // the directory alone doesn't identify the family — the session_meta line's
  // model does. Old files predating session_meta models default to codex.
  const meta = readCodexSessionMeta(file);
  return meta.model ? agentIdFor(meta.model) : "codex";
}

/**
 * The authoritative working directory of a Codex session, taken from its
 * session_meta line. Unlike Claude (cwd is encoded in the file path),
 * Codex stores cwd in metadata — so this is the single source of truth for
 * which workspace a Codex conversation belongs to. Returns null if unknown.
 */
export function codexSessionCwd(sessionId) {
  if (!sessionId) return null;
  const file = join(CODEX_HISTORY_DIR, sessionId + ".jsonl");
  if (!existsSync(file)) return null;
  return readCodexSessionMeta(file).cwd;
}

// --- Truncate session file (for rewind) ---

export function truncateSessionFile(filePath, count = 1) {
  let raw;
  try { raw = readFileSync(filePath, "utf8"); } catch { return null; }
  const lines = raw.split("\n").filter(l => l.trim());

  const userIndices = [];
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (obj.type === "user" && obj.message?.role === "user" && !obj.isMeta) {
      const content = obj.message.content;
      if (Array.isArray(content) && content.every(b => b.type === "tool_result")) continue;
      userIndices.push(i);
    }
  }

  if (userIndices.length === 0 || count < 1) return null;
  const cutTurnIdx = Math.max(0, userIndices.length - count);
  const cutLineIdx = userIndices[cutTurnIdx];

  let cutIdx = cutLineIdx;
  if (cutIdx > 0) {
    let prev;
    try { prev = JSON.parse(lines[cutIdx - 1]); } catch { prev = null; }
    if (prev?.type === "queue-operation") cutIdx--;
  }

  const kept = lines.slice(0, cutIdx);
  writeFileSync(filePath, kept.length > 0 ? kept.join("\n") + "\n" : "");

  let userText = "";
  try {
    const userObj = JSON.parse(lines[cutLineIdx]);
    const content = userObj.message.content;
    if (typeof content === "string") userText = content;
    else if (Array.isArray(content)) {
      userText = content.filter(b => b.type === "text").map(b => b.text).join(" ");
    }
  } catch { /* ignore */ }

  return userText;
}

// --- Session listing ---

const SKIP_DIRS = new Set(["subagents", "tool-results", "memory"]);

const LIST_LIMIT = 50;
// A content/path search reads whole transcript bodies, so it costs more than the
// shallow listing — bound the result set but let it reach far past LIST_LIMIT so
// an old session in a rarely-used folder (e.g. ~/avsv) is still findable (SHE-82).
const SEARCH_LIMIT = 200;

// Enumerate every session file on disk (Claude + Codex) as lightweight
// descriptors — no per-file parsing yet. Shared by listSessions (which reads
// shallow meta for the newest LIST_LIMIT) and searchSessions (which scans ALL
// of them). Keeping enumeration in one place stops the two paths drifting.
function collectSessionFiles() {
  const files = [];

  // --- Claude Code sessions ---
  const projectsDir = join(HOME, ".claude", "projects");
  if (existsSync(projectsDir)) {
    const scanDir = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          scanDir(join(dir, entry.name));
        } else if (entry.name.endsWith(".jsonl")) {
          const fullPath = join(dir, entry.name);
          const sid = entry.name.replace(".jsonl", "");
          if (sid.startsWith("agent-")) continue;
          let st;
          try { st = statSync(fullPath); } catch { continue; }
          files.push({ provider: "claude", sid, fullPath, mtime: st.mtimeMs });
        }
      }
    };
    scanDir(projectsDir);
  }

  // --- Codex sessions ---
  if (existsSync(CODEX_HISTORY_DIR)) {
    let entries;
    try { entries = readdirSync(CODEX_HISTORY_DIR, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) continue;
      const fullPath = join(CODEX_HISTORY_DIR, entry.name);
      const sid = entry.name.replace(".jsonl", "");
      let st;
      try { st = statSync(fullPath); } catch { continue; }
      files.push({ provider: "codex", sid, fullPath, mtime: st.mtimeMs });
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// Read the shallow metadata (first message, model, cwd, turn count) for one
// enumerated session file and shape it into the listing record the cockpit uses.
function sessionMetaFor(file) {
  if (file.provider === "codex") {
    const meta = readCodexSessionMeta(file.fullPath);
    const cwd = meta.cwd || HOME;
    return {
      sessionId: file.sid,
      firstMessage: meta.firstMessage,
      model: meta.model,
      turnCount: meta.turnCount,
      mtime: file.mtime,
      path: file.fullPath,
      cwd,
      project: projectLabel(cwd),
      provider: "codex",
    };
  }
  const meta = readSessionMeta(file.fullPath);
  const cwd = cwdFromSessionPath(file.fullPath);
  return {
    sessionId: file.sid,
    firstMessage: meta.firstMessage,
    model: meta.model,
    turnCount: meta.turnCount,
    mtime: file.mtime,
    path: file.fullPath,
    cwd,
    project: projectLabel(cwd),
    provider: "claude",
  };
}

export function listSessions() {
  return collectSessionFiles().slice(0, LIST_LIMIT).map(sessionMetaFor);
}

// grep's own ARG_MAX guard: chunk the file list so a very large corpus can't
// blow the child's argv. One batch covers any realistic single-user history.
const GREP_BATCH = 1000;

// Match the query against the full transcript BODIES in a `grep` subprocess, so
// the heavy scan runs OFF the Node event loop. The cockpit shares one loop
// across every client; the previous synchronous readFileSync + toLowerCase over
// the whole corpus froze it for ~5 s on a mature history (round-7 P1). grep
// streams each file (never loading a 100 MB transcript into V8), matches
// case-insensitively (-i) as a literal (-F), treats JSONL as text (-a), and
// with -l prints only the matching paths. An AbortSignal kills the child so a
// superseded keystroke's scan is cancelled rather than left running.
async function grepBodies(paths, q, signal) {
  const hits = new Set();
  for (let i = 0; i < paths.length; i += GREP_BATCH) {
    if (signal?.aborted) break;
    for (const p of await grepBatch(paths.slice(i, i + GREP_BATCH), q, signal)) hits.add(p);
  }
  return hits;
}

function grepBatch(paths, q, signal) {
  return new Promise((resolvePromise) => {
    if (!paths.length) { resolvePromise([]); return; }
    let child;
    try {
      child = spawn("grep", ["-l", "-i", "-a", "-F", "-e", q, "--", ...paths],
        { stdio: ["ignore", "pipe", "ignore"], signal });
    } catch (err) {
      console.warn(`[history] session content search unavailable (grep spawn failed: ${err.message})`);
      resolvePromise([]);
      return;
    }
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (err) => {
      // AbortError = a superseded search we deliberately killed — expected, quiet.
      if (err?.name !== "AbortError") {
        console.warn(`[history] session content search failed (grep: ${err.message})`);
      }
      resolvePromise([]);
    });
    // grep exits 1 on "no match" and 2 on error; we don't distinguish — either
    // way stdout carries exactly the matched paths, so we just parse what we got.
    child.on("close", () => resolvePromise(out ? out.split("\n").filter(Boolean) : []));
  });
}

// Search EVERY session on disk — not just the newest LIST_LIMIT the browser
// holds — so a term buried deep in an old conversation, or the folder a session
// ran in (e.g. ~/avsv), is findable. Returns the same record shape as
// listSessions. Async + cancellable: body scanning happens off-loop in grep
// (see grepBodies); folder matching is a zero-I/O check on the path.
export async function searchSessions(query, { signal, limit = SEARCH_LIMIT } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const files = collectSessionFiles(); // newest-first descriptors, no body read

  // Folder match, no read: a Claude session encodes its cwd in the project-dir
  // name (the abs path with slashes → dashes, e.g. `-home-user-avsv`), so the
  // folder it ran in is findable straight from the path. Codex cwd (in
  // session_meta) and every message body are covered by the grep pass below.
  const pathHits = new Set(
    files.filter((f) => dirname(f.fullPath).toLowerCase().includes(q)).map((f) => f.fullPath),
  );

  const bodyHits = await grepBodies(files.map((f) => f.fullPath), q, signal);
  if (signal?.aborted) return []; // superseded — the newer search answers instead

  return files
    .filter((f) => pathHits.has(f.fullPath) || bodyHits.has(f.fullPath))
    .slice(0, limit)
    .map(sessionMetaFor);
}

function readCodexSessionMeta(filePath) {
  const result = { firstMessage: "(no messages)", model: null, cwd: null, turnCount: 0 };
  let fd;
  try { fd = openSync(filePath, "r"); } catch { return result; }
  const buf = Buffer.alloc(8192);
  let bytesRead;
  try { bytesRead = readSync(fd, buf, 0, 8192, 0); } catch { closeSync(fd); return result; }
  closeSync(fd);
  const text = buf.toString("utf8", 0, bytesRead);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "session_meta") {
      if (obj.model) result.model = obj.model;
      if (obj.cwd) result.cwd = obj.cwd;
      continue;
    }
    if (obj.type === "user_message" && obj.content) {
      result.turnCount++;
      if (result.firstMessage === "(no messages)") {
        result.firstMessage = String(obj.content).slice(0, 120) || "(empty)";
      }
    }
    if (obj.type === "turn_done") result.turnCount++;
  }
  return result;
}

function projectLabel(cwd) {
  if (cwd === HOME) return "~";
  if (cwd.startsWith(HOME + "/")) return "~/" + cwd.slice(HOME.length + 1);
  return cwd;
}

function readSessionMeta(filePath) {
  const result = { firstMessage: "(no messages)", model: null, turnCount: 0 };
  let fd;
  try { fd = openSync(filePath, "r"); } catch { return result; }
  const buf = Buffer.alloc(32768);
  let bytesRead;
  try { bytesRead = readSync(fd, buf, 0, 32768, 0); } catch { closeSync(fd); return result; }
  closeSync(fd);
  const text = buf.toString("utf8", 0, bytesRead);
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "file-history-snapshot" || obj.type === "queue-operation") continue;
    if (obj.isMeta || obj.isCompactSummary) continue;
    if (obj.type === "user" && obj.message?.role === "user") {
      const content = obj.message.content;
      if (Array.isArray(content) && content.every(b => b.type === "tool_result")) continue;
      let msgText = "";
      if (typeof content === "string") msgText = content;
      else if (Array.isArray(content)) {
        msgText = content.filter(b => b.type === "text").map(b => b.text).join(" ");
      }
      if (isInternalUserContent(msgText)) continue; // injected envelope, not a real turn
      // A post-compact session file opens with the compaction summary as its
      // first "user" line — garbage as a preview/title (SHE-43/SHE-73); skip
      // to the first message a human actually typed.
      if (msgText.startsWith("[Conversation compacted")) continue;
      result.turnCount++;
      if (result.firstMessage === "(no messages)" && msgText) {
        result.firstMessage = msgText.slice(0, 120) || "(empty)";
      }
    }
    if (!result.model && obj.type === "assistant" && obj.message?.model) {
      result.model = obj.message.model;
    }
  }
  if (bytesRead >= 32768) result.turnCount = null;
  return result;
}

// --- Read session for replay ---
// Converts Claude Code JSONL into protocol-format messages for the frontend.

function stripImagesFromToolResults(msg) {
  if (!msg?.message?.content || !Array.isArray(msg.message.content)) return msg;
  const clone = JSON.parse(JSON.stringify(msg));
  for (const block of clone.message.content) {
    if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
    block.content = block.content.map(b => {
      if (b.type === "image" && b.source?.data) {
        return { type: "text", text: `[image: ${b.source.media_type || "image/png"}]` };
      }
      return b;
    });
  }
  return clone;
}

/**
 * Persist a cockpit lineage marker (a { type:"session_event", ... } object) into
 * a Claude native session file, chained onto its last line so `claude --resume`
 * stays happy. No-op (returns false) for non-Claude / missing files — those keep
 * their markers in the protocol JSONL. Mirrors what addToHistory writes elsewhere.
 */
export function appendClaudeSessionMarker(sessionId, marker) {
  const file = findSessionFile(sessionId);
  if (!file || file.startsWith(CODEX_HISTORY_DIR)) return false;
  let lastUuid = null, sid = sessionId, cwd = "";
  let lines;
  try { lines = readFileSync(file, "utf8").split("\n").filter(l => l.trim()); } catch { return false; }
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.uuid) lastUuid = o.uuid;
    if (o.cwd) cwd = o.cwd;
    if (o.sessionId) sid = o.sessionId;
  }
  const line = JSON.stringify({
    parentUuid: lastUuid, isSidechain: false, sessionId: sid, cwd,
    version: "portable-sessions", gitBranch: "", userType: "external",
    type: "user", isMeta: true,
    message: { role: "user", content: SESSION_MARKER_PREFIX + JSON.stringify(marker) },
    uuid: uuid4(), timestamp: new Date().toISOString(),
  });
  appendFileSync(file, line + "\n");
  return true;
}

// Injected envelopes that flow through the user-message path but were not
// typed by the human: async task notifications, slash-command stdout echoes,
// harness reminders. They must never render as the user's own bubble (SHE-65)
// — the frontend shows entries marked internal as a muted system block.
// Single classifier so live sends, persistence, and every replay branch agree.
const INTERNAL_ENVELOPE_RE = /^\s*<(task-notification|local-command-stdout|command-|system-reminder)/;
export function isInternalUserContent(content) {
  return typeof content === "string" && INTERNAL_ENVELOPE_RE.test(content);
}

// Replay cap: a marathon session can decode into tens of thousands of protocol
// messages — hydrating them all janks the UI (especially mobile). Keep the
// opening (the original ask, which also seeds tab titles) and the recent tail,
// with a visible marker for what was elided. The full transcript stays on disk.
const REPLAY_HEAD = 20;
const REPLAY_TAIL = 480;
function capReplay(messages) {
  const max = REPLAY_HEAD + REPLAY_TAIL;
  if (messages.length <= max + 1) return messages;
  const dropped = messages.length - max;
  console.log(`[history] replay capped: ${messages.length} messages -> head ${REPLAY_HEAD} + tail ${REPLAY_TAIL} (${dropped} elided)`);
  return [
    ...messages.slice(0, REPLAY_HEAD),
    { type: "session_event", event: "truncated", count: dropped },
    ...messages.slice(messages.length - REPLAY_TAIL),
  ];
}

export function readSessionForReplay(filePath) {
  let raw;
  try { raw = readFileSync(filePath, "utf8"); } catch { return []; }

  // Codex history files are already in protocol format — parse, and re-derive
  // the internal flag for entries persisted before it existed (SHE-65).
  if (filePath.startsWith(CODEX_HISTORY_DIR)) {
    return capReplay(raw.split("\n")
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .map(m => (m.type === "user_message" && !m.internal && isInternalUserContent(m.content))
        ? { ...m, internal: true } : m));
  }

  const lines = raw.split("\n");
  const messages = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    // A compact summary line marks a compaction point. Only the LLM's window
    // was trimmed there — the human's transcript is intact on disk — so replay
    // keeps the whole conversation and drops a marker at each compaction
    // instead of hiding everything before the last one (SHE-73).
    if (obj.isCompactSummary) {
      messages.push({ type: "session_event", event: "compacted" });
      continue;
    }
    if (obj.type === "file-history-snapshot" || obj.type === "progress" ||
        obj.type === "queue-operation" || obj.type === "system") continue;

    if (obj.type === "user" && obj.message?.role === "user") {
      const content = obj.message.content;
      // A cockpit lineage marker embedded as an isMeta note — re-surface it as
      // the structured session_event the frontend renders (handoff/fork marker).
      if (typeof content === "string" && content.startsWith(SESSION_MARKER_PREFIX)) {
        try { messages.push(JSON.parse(content.slice(SESSION_MARKER_PREFIX.length))); }
        catch (e) { console.warn(`[history] malformed session marker in ${filePath}: ${e.message}`); }
        continue;
      }
      if (obj.isMeta) continue;
      let msgText = "";
      if (typeof content === "string") msgText = content;
      else if (Array.isArray(content)) {
        msgText = content.filter(b => b.type === "text").map(b => b.text).join(" ");
      }
      if (msgText.startsWith("<command-")) continue;

      // Tool results → emit as tool_result protocol messages
      if (Array.isArray(content) && content.some(b => b.type === "tool_result")) {
        const stripped = stripImagesFromToolResults(obj);
        for (const block of stripped.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            messages.push({
              type: "tool_result",
              id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error || false,
            });
          }
        }
      } else {
        // Regular user message; injected envelopes (task notifications etc.)
        // carry internal:true so they render as system notes, not user bubbles.
        messages.push({
          type: "user_message",
          content: msgText,
          timestamp: obj.timestamp || Date.now(),
          ...(isInternalUserContent(msgText) ? { internal: true } : {}),
        });
      }
    } else if (obj.type === "assistant" && obj.message?.content) {
      // Convert assistant content blocks to protocol messages
      for (const block of obj.message.content) {
        if (block.type === "text" && block.text) {
          messages.push({ type: "text_done", text: block.text });
        } else if (block.type === "tool_use") {
          // Special tool handling for replay
          if (block.name === "AskUserQuestion") {
            messages.push({ type: "ask_user", id: block.id, questions: block.input?.questions || [] });
          } else if (block.name === "EnterPlanMode") {
            messages.push({ type: "plan_start" });
          } else if (block.name === "ExitPlanMode") {
            messages.push({ type: "plan_done", plan: block.input });
          } else {
            messages.push({ type: "tool_start", id: block.id, name: block.name });
            messages.push({ type: "tool_input", id: block.id, input: block.input || {} });
          }
        }
      }
    } else if (obj.type === "result") {
      messages.push({
        type: "turn_done",
        cost: obj.total_cost_usd,
        is_error: obj.is_error || false,
        errors: obj.errors,
      });
    }
  }
  return capReplay(messages);
}

// --- File helpers ---

export function listFiles(baseDir) {
  const root = baseDir || HOME;
  const EXCLUDE = new Set([".git", "node_modules", ".cache", "__pycache__", ".claude",
    ".local", ".config", ".npm", ".nvm", ".codex", ".steel"]);
  const MAX_DEPTH = 5;
  const MAX_FILES = 500;
  const results = [];

  // Breadth-first so shallow entries (and sibling directories) are listed before
  // the deep contents of any one subtree. A depth-first walk would exhaust the
  // result/UI cap on the first subdirectory's descendants, hiding its siblings.
  const queue = [{ dir: root, rel: "", depth: 0 }];
  while (queue.length && results.length < MAX_FILES) {
    const { dir, rel, depth } = queue.shift();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (entry.name.startsWith(".") || EXCLUDE.has(entry.name)) continue;
      const relPath = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        results.push(relPath + "/");
        queue.push({ dir: join(dir, entry.name), rel: relPath, depth: depth + 1 });
      } else {
        results.push(relPath);
      }
    }
  }
  return results;
}

export function expandFileReferences(text) {
  const FILE_RE = /(?:^|\s)@([\w][\w.\/-]*)/gm;
  const expansions = [];
  let match;
  while ((match = FILE_RE.exec(text)) !== null) {
    const relPath = match[1];
    const abs = safePath(relPath);
    if (!abs) continue;
    if (!existsSync(abs)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > 100 * 1024) continue;
    let content;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    expansions.push({ path: relPath, content });
  }
  if (expansions.length === 0) return text;
  let expanded = text;
  for (const { path, content } of expansions) {
    expanded += `\n\n<file path="${path}">\n${content}\n</file>`;
  }
  return expanded;
}

export function safePath(p) {
  if (!p || typeof p !== "string" || p.includes("\0")) return null;
  const resolved = resolve(HOME, p.startsWith("/") ? p.slice(1) : p);
  if (!resolved.startsWith(HOME + "/") && resolved !== HOME) return null;
  return resolved;
}

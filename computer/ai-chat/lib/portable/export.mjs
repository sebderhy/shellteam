/**
 * Exporters: CSF → a native session file the target CLI resumes as its own.
 *
 * Every exporter (invariants 4/5/8):
 *  - runs pairCheck() first (synthesize interrupted results for dangling calls),
 *  - drops reasoning parts (never crosses a family, never forged),
 *  - writes a NEW native session id (the source is never mutated),
 *  - returns { nativeSessionId, file, synthesized, toolCalls }.
 *
 * The native shapes here are the exact ones proven resumable on this box on
 * 2026-07-02 (Claude 2.1.197, Codex 0.142.4, Gemini 0.49.0, OpenCode 1.17.12) —
 * no checksums or crypto validation exist in any of them.
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { HOME } from "../constants.mjs";
import {
  uuid4,
  uuid7,
  opencodeId,
  encodeCwd,
  pairCheck,
  capToolResults,
  sanitizeCodexToolName,
} from "./csf.mjs";

const execFileP = promisify(execFile);

const EXPORTERS = { claude: exportToClaude, codex: exportToCodex, opencode: exportToOpenCode };

/** Dispatch to the right exporter by target family. */
export async function exportSession(family, csf, opts = {}) {
  const fn = EXPORTERS[family];
  if (!fn) throw new Error(`No exporter for agent family "${family}"`);
  return fn(csf, opts);
}

// --- shared prep ---

/**
 * pairCheck + drop reasoning + cap oversized tool outputs. Returns
 * { events, synthesized, toolCalls }. The tool-output cap keeps a single
 * pathological result (a minified bundle, a repo-wide grep) from pushing the
 * synthesized session past the target window and bricking the switch — the
 * source CLI only ever held a truncated view of it anyway (SHE-56/SHE-57).
 */
function prepare(csf) {
  const dereasoned = csf.events.map((ev) => {
    if (ev.type !== "message" || ev.role !== "assistant") return ev;
    return { ...ev, parts: (ev.parts || []).filter((p) => p.type !== "reasoning") };
  });
  const { events: capped, capped: nCapped, charsDropped } = capToolResults(dereasoned);
  if (nCapped) {
    console.log(`[portable] capped ${nCapped} oversized tool result(s), dropped ${charsDropped.toLocaleString("en-US")} chars to fit the target context window`);
  }
  return pairCheck(capped);
}

const nowIso = () => new Date().toISOString();

/** 2026-06-21T11-28-11 — the Codex rollout filename timestamp form. */
function rolloutStamp(d = new Date()) {
  return d.toISOString().replace(/\.\d+Z$/, "").replaceAll(":", "-");
}

// --- Claude → ~/.claude/projects/<enc cwd>/<uuid4>.jsonl ---

function exportToClaude(csf, { cliVersion = "portable-sessions", model = "claude-opus-4-8", root = HOME } = {}) {
  const { events, synthesized, toolCalls } = prepare(csf);
  const sid = uuid4();
  const cwd = csf.session.cwd;
  const dir = join(root, ".claude", "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);

  const lines = [];
  let parentUuid = null;
  const base = () => ({
    parentUuid,
    isSidechain: false,
    sessionId: sid,
    cwd,
    version: cliVersion,
    gitBranch: "",
    userType: "external",
  });
  const push = (obj) => {
    const uuid = uuid4();
    lines.push(JSON.stringify({ ...base(), ...obj, uuid, timestamp: nowIso() }));
    parentUuid = uuid;
  };

  for (const ev of events) {
    if (ev.type === "compaction") {
      push({ type: "user", message: { role: "user", content: `[Conversation compacted earlier; summary:] ${ev.summary || ""}` } });
    } else if (ev.type === "tool_result") {
      push({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: ev.callId, content: ev.output, is_error: ev.isError }],
        },
      });
    } else if (ev.role === "user") {
      push({ type: "user", message: { role: "user", content: userText(ev) } });
    } else {
      const content = [];
      for (const p of ev.parts || []) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
        else if (p.type === "tool_call") content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input || {} });
      }
      if (!content.length) continue;
      // Keep the per-message model only when it's already a Claude id (same-family
      // fork preserves history); otherwise stamp the target model we're becoming.
      const msgModel = ev.model?.startsWith("claude") ? ev.model : model;
      push({ type: "assistant", message: { model: msgModel, type: "message", role: "assistant", content } });
    }
  }

  writeFileSync(file, lines.join("\n") + "\n");
  return { nativeSessionId: sid, file, synthesized, toolCalls };
}

// --- Codex → ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid7>.jsonl ---

function exportToCodex(csf, { cliVersion = "0.142.4", root = HOME } = {}) {
  const { events, synthesized, toolCalls } = prepare(csf);
  const now = new Date();
  const sid = uuid7(now.getTime());
  const cwd = csf.session.cwd;
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const dir = join(root, ".codex", "sessions", yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${rolloutStamp(now)}-${sid}.jsonl`);

  const lines = [];
  const item = (payload) => lines.push(JSON.stringify({ timestamp: nowIso(), type: "response_item", payload }));

  lines.push(JSON.stringify({
    timestamp: nowIso(),
    type: "session_meta",
    payload: { id: sid, timestamp: nowIso(), cwd, originator: "shellteam_portable", cli_version: cliVersion, source: "exec" },
  }));

  for (const ev of events) {
    if (ev.type === "compaction") {
      item({ type: "message", role: "user", content: [{ type: "input_text", text: `[Conversation compacted earlier; summary:] ${ev.summary || ""}` }] });
    } else if (ev.type === "tool_result") {
      item({ type: "function_call_output", call_id: ev.callId, output: ev.output });
    } else if (ev.role === "user") {
      item({ type: "message", role: "user", content: [{ type: "input_text", text: userText(ev) }] });
    } else {
      for (const p of ev.parts || []) {
        if (p.type === "text" && p.text) item({ type: "message", role: "assistant", content: [{ type: "output_text", text: p.text }] });
        else if (p.type === "tool_call") item({ type: "function_call", name: sanitizeCodexToolName(p.name), arguments: JSON.stringify(p.input || {}), call_id: p.id });
      }
    }
  }

  writeFileSync(file, lines.join("\n") + "\n");
  return { nativeSessionId: sid, file, synthesized, toolCalls };
}

// --- OpenCode → export-shaped JSON, then `opencode import` ---

async function exportToOpenCode(csf, { model = "glm-5p2" } = {}) {
  const { events, synthesized, toolCalls } = prepare(csf);
  const cwd = csf.session.cwd;
  let seq = 0;
  const sesId = opencodeId("ses", seq++);
  const now = Date.now();

  const messages = [];
  let parentId = null; // OpenCode requires each message to chain to the prior one
  const add = (role, text) => {
    const msg = ocMessage(role, sesId, seq++, model, [{ text }], parentId);
    parentId = msg.info.id;
    messages.push(msg);
  };
  for (const ev of events) {
    if (ev.type === "tool_result" || ev.type === "compaction") {
      // Fold tool results / compaction into a plain user text message — the
      // export→import path is lossy on tool state; text carries the claim.
      add("user", ev.type === "compaction"
        ? `[Conversation compacted earlier; summary:] ${ev.summary || ""}`
        : `[tool result] ${ev.output}`);
    } else if (ev.role === "user") {
      add("user", userText(ev));
    } else {
      const text = geminiAssistantText(ev); // same text-flattening rules
      if (text) add("assistant", text);
    }
  }

  const doc = {
    info: {
      id: sesId, slug: "portable-handoff", projectID: "global", directory: cwd, path: "",
      title: csf.session.title, agent: "build",
      model: { id: model, providerID: "fireworks", variant: "default" },
      version: "1.17.12", time: { created: now, updated: now },
    },
    messages,
  };

  const tmpfile = join(tmpdir(), `portable-oc-${sesId}.json`);
  writeFileSync(tmpfile, JSON.stringify(doc));
  try {
    const { stdout, stderr } = await execFileP("opencode", ["import", tmpfile], { cwd });
    // opencode import may mint its own session id; prefer any ses_ it reports.
    const reported = `${stdout}\n${stderr}`.match(/ses_[A-Za-z0-9]+/);
    const nativeSessionId = reported ? reported[0] : sesId;
    return { nativeSessionId, file: tmpfile, synthesized, toolCalls };
  } finally {
    // `opencode import` copies the doc into its own store — the temp is spent.
    rmSync(tmpfile, { force: true });
  }
}

function ocMessage(role, sesId, seq, model, parts, parentId = null) {
  const msgId = opencodeId("msg", seq);
  const info = role === "user"
    ? { id: msgId, sessionID: sesId, role: "user", time: { created: Date.now() }, agent: "build", model: { providerID: "fireworks", modelID: model } }
    : { id: msgId, sessionID: sesId, role: "assistant", mode: "build", agent: "build", path: { cwd: "", root: "" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: model, providerID: "fireworks", time: { created: Date.now(), completed: Date.now() }, finish: "stop" };
  if (parentId) info.parentID = parentId;
  return {
    info,
    parts: parts.map((p) => ({ id: opencodeId("prt", seq), sessionID: sesId, messageID: msgId, type: "text", text: p.text })),
  };
}

// --- shared text helpers ---

function userText(ev) {
  return (ev.parts || []).map((p) => p.text || "").join("\n");
}

/** Assistant text with tool calls flattened to a readable note (Gemini/OpenCode). */
function geminiAssistantText(ev) {
  const bits = [];
  for (const p of ev.parts || []) {
    if (p.type === "text" && p.text) bits.push(p.text);
    else if (p.type === "tool_call") bits.push(`[called ${p.name}(${JSON.stringify(p.input || {})})]`);
  }
  return bits.join("\n");
}

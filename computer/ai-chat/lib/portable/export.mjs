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
 * 2026-07-02 (Claude 2.1.197, Codex 0.142.4, Gemini 0.49.0) and 2026-11-16 (Pi
 * 1.5.2): no checksums or crypto validation exist in any of them.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { HOME } from "../constants.mjs";
import { piDefaultModel, piModel } from "../model-catalog.mjs";
import { newPiSessionId } from "../pi-agent.mjs";
import {
  uuid4,
  uuid7,
  encodeCwd,
  pairCheck,
  capToolResults,
  sanitizeCodexToolName,
} from "./csf.mjs";

const EXPORTERS = { claude: exportToClaude, codex: exportToCodex, pi: exportToPi };

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

function exportToClaude(csf, { cliVersion = "portable-sessions", model = "claude-opus-5-5", root = HOME } = {}) {
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

// --- Pi → ~/.pi/agent/sessions/--<cwd>--/<stamp>_<id>.jsonl ---
//
// The session format is Pi's docs/session-format.md (version 3): a header
// line, then entries chained by id/parentId. No system message is written: Pi
// declares its prompt and tools on the next request, as for a session that
// predates system messages. The cockpit then opens it with --session-id.

// Pi's built-in tools, by the names the other agents use, so the history shows
// the tools this model actually has. Any other name (MCP tools) is kept.
const PI_TOOL_NAMES = { Bash: "bash", Read: "read", Edit: "edit", Write: "write" };

/** Pi's session folder for a cwd: leading separator dropped, then / \ : become -. */
export function piSessionDir(cwd, root = HOME) {
  const slug = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return join(root, ".pi", "agent", "sessions", `--${slug}--`);
}

function exportToPi(csf, { model = piDefaultModel(), root = HOME } = {}) {
  const { events, synthesized, toolCalls } = prepare(csf);
  const upstream = piModel(model)?.upstream;
  if (!upstream) throw new Error(`Model "${model}" is not one of Pi's models in config/models.json`);
  const sid = newPiSessionId();
  const now = new Date();
  const dir = piSessionDir(csf.session.cwd, root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}_${sid}.jsonl`);

  const lines = [JSON.stringify({ type: "session", version: 3, id: sid, timestamp: now.toISOString(), cwd: csf.session.cwd })];
  let parentId = null;
  const entry = (fields) => {
    const id = randomBytes(4).toString("hex");
    lines.push(JSON.stringify({ id, parentId, timestamp: now.toISOString(), ...fields }));
    parentId = id;
  };
  const message = (msg) => entry({ type: "message", message: { ...msg, timestamp: now.getTime() } });
  entry({ type: "model_change", provider: "shellteam", modelId: upstream });

  const names = new Map();  // call id -> the tool name written, for its result
  for (const ev of events) {
    if (ev.type === "compaction") {
      message({ role: "user", content: [{ type: "text", text: `[Conversation compacted earlier; summary:] ${ev.summary || ""}` }] });
    } else if (ev.type === "tool_result") {
      message({
        role: "toolResult", toolCallId: ev.callId, toolName: names.get(ev.callId) || "tool",
        content: [{ type: "text", text: ev.output }], isError: !!ev.isError,
      });
    } else if (ev.role === "user") {
      message({ role: "user", content: [{ type: "text", text: userText(ev) }] });
    } else {
      const content = [];
      for (const p of ev.parts || []) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
        else if (p.type === "tool_call") {
          const name = PI_TOOL_NAMES[p.name] || p.name;
          names.set(p.id, name);
          content.push({ type: "toolCall", id: p.id, name, arguments: p.input || {} });
        }
      }
      if (!content.length) continue;
      message({
        role: "assistant", content, api: "openai-completions", provider: "shellteam", model: upstream,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
      });
    }
  }

  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return { nativeSessionId: sid, file, synthesized, toolCalls };
}

// --- shared text helpers ---

function userText(ev) {
  return (ev.parts || []).map((p) => p.text || "").join("\n");
}


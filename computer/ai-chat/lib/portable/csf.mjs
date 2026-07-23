/**
 * Canonical Session Format (CSF v1) — the interchange representation for
 * portable sessions (roadmap B1). One CSF document per handoff: it is produced
 * by an importer, consumed by an exporter, and persisted as a lineage/audit
 * artifact under ~/.shellteam/sessions/. It is NOT a live history store.
 *
 * Design invariants (see docs/plans/active/20260702-portable-sessions.md §2):
 *  - Ordered, flat event list. Four event types only: message, tool_result,
 *    compaction — nothing else in v1.
 *  - Reasoning is captured as plain text where available, but exporters drop it
 *    (invariant 5): it is unforgeable across API boundaries and never crosses a
 *    family. It lives in CSF only for the audit artifact + future same-family use.
 *  - Every tool_call must be answered by a tool_result before export (invariant
 *    4); pairCheck() synthesizes an interrupted result for dangling calls.
 */

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { HOME } from "../constants.mjs";

export const CSF_VERSION = 1;

/** ShellTeam's own directory for handoff artifacts — zero footprint questions. */
export const CSF_DIR = join(HOME, ".shellteam", "sessions");

// --- ID generation ---

/** uuid4 — Claude session ids and Gemini session ids. */
export function uuid4() {
  return randomUUID();
}

/**
 * uuid7 — Codex rollout ids (time-ordered). 48-bit big-endian ms timestamp in
 * the first 6 bytes, version 7, RFC-4122 variant. Matches the shape Codex
 * writes (e.g. 019ee9f0-28f0-7532-...). `ts` is injectable for deterministic
 * tests.
 */
export function uuid7(ts = Date.now()) {
  const b = randomBytes(16);
  let t = ts;
  for (let i = 5; i >= 0; i--) {
    b[i] = t & 0xff;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * OpenCode-style monotonic ids: `<prefix>_<26 base62 chars>`, ascending in
 * message order so the import preserves ordering. `seq` guarantees the sort.
 */
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function opencodeId(prefix, seq) {
  const s = String(seq).padStart(6, "0");
  const rand = [...randomBytes(10)].map((x) => B62[x % 62]).join("");
  return `${prefix}_${s}${rand}`.slice(0, prefix.length + 1 + 26);
}

// --- cwd encoding (Claude project dir + Gemini project hash) ---

/** Claude encodes cwd into the project dir name: /tmp/she14-test → -tmp-she14-test */
export function encodeCwd(cwd) {
  return cwd.replaceAll("/", "-");
}

/** Gemini's projectHash header field is sha256 of the absolute cwd. */
export function projectHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex");
}

// --- Tool-call pairing (invariant 4) ---

/**
 * Ensure every tool_call has a matching tool_result. Any assistant tool_call
 * with no answering tool_result event gets a synthesized error result inserted
 * right after its message (OpenCode's own trick — an unanswered call 400s every
 * API on resume). Returns a NEW events array; the input is never mutated
 * (invariant 8). Also reports counts for logging.
 */
export function pairCheck(events) {
  const answered = new Set();
  for (const ev of events) {
    if (ev.type === "tool_result" && ev.callId) answered.add(ev.callId);
  }

  const out = [];
  let synthesized = 0;
  let toolCalls = 0;
  for (const ev of events) {
    out.push(ev);
    if (ev.type !== "message" || ev.role !== "assistant") continue;
    for (const part of ev.parts || []) {
      if (part.type !== "tool_call" || !part.id) continue;
      toolCalls++;
      if (!answered.has(part.id)) {
        out.push({
          type: "tool_result",
          callId: part.id,
          output: "[interrupted — no result recorded]",
          isError: true,
        });
        answered.add(part.id);
        synthesized++;
      }
    }
  }
  return { events: out, synthesized, toolCalls };
}

// --- Tool-result size cap (context-window safety) ---

/**
 * Max characters of a single tool_result carried into an exported session.
 * ~40k chars ≈ 10k tokens. The source CLI only ever had a truncated/managed
 * view of a huge output in its own context window (Claude Code caps Bash output
 * at ~30k chars; Codex truncates too), but the cockpit persists the FULL output
 * in its protocol history. Replaying every full output verbatim on a handoff can
 * push the synthesized session past even a 1M-token window — a single pathological
 * result (a minified bundle, a repo-wide grep, a `find ~`) can be 250k+ tokens.
 * That bricked real switches: once over the target window, every turn AND /compact
 * fail with "Prompt is too long" (SHE-56, SHE-57). Capping mirrors what the live
 * CLI would itself have held.
 */
export const TOOL_OUTPUT_CAP_CHARS = 40_000;
const CAP_HEAD_CHARS = 30_000;
const CAP_TAIL_CHARS = 6_000;

/**
 * Truncate an over-long tool output, keeping the head (where the useful signal
 * usually is) and the tail, with a visible marker in between. Under the cap the
 * string is returned unchanged. Never throws; input is a string (CSF output).
 */
export function capToolOutput(output, cap = TOOL_OUTPUT_CAP_CHARS) {
  if (typeof output !== "string" || output.length <= cap) return output;
  const head = output.slice(0, CAP_HEAD_CHARS);
  const tail = output.slice(-CAP_TAIL_CHARS);
  const omitted = output.length - head.length - tail.length;
  return `${head}\n\n[… ${omitted.toLocaleString("en-US")} characters truncated when this conversation was carried over to a new agent — the original agent only ever held a truncated view of this output …]\n\n${tail}`;
}

/**
 * Return a NEW events array with every oversized tool_result output capped
 * (invariant 8: never mutate the input; the CSF audit artifact keeps the full
 * content, only the resumable session is capped). Reports how many were capped
 * and how many characters were dropped, for logging.
 */
export function capToolResults(events, cap = TOOL_OUTPUT_CAP_CHARS) {
  let capped = 0;
  let charsDropped = 0;
  const out = events.map((ev) => {
    if (ev.type !== "tool_result" || typeof ev.output !== "string" || ev.output.length <= cap) return ev;
    const before = ev.output.length;
    const output = capToolOutput(ev.output, cap);
    capped++;
    charsDropped += before - output.length;
    return { ...ev, output };
  });
  return { events: out, capped, charsDropped };
}

// --- Codex tool-name sanitization (SHE-76) ---

/**
 * Codex/OpenAI reject any function-call `name` that doesn't match
 * `^[a-zA-Z0-9_-]+$` (and cap names at 64 chars) — a carried-over session whose
 * history holds a tool whose name has a `.`, `:`, or space (some MCP/skill tool
 * names do) 400s the ENTIRE request on the first replay into Codex:
 *   Invalid 'input[N].name': string does not match pattern '^[a-zA-Z0-9_-]+$'.
 * Map every out-of-set character to `_`, cap to 64, and never emit an empty
 * string. This is history-only and cosmetic: Codex pairs a `function_call` to
 * its `function_call_output` by `call_id`, not by name, and the replayed name is
 * a record of a PAST call, not a live tool the model must re-invoke.
 */
export function sanitizeCodexToolName(name) {
  const cleaned = String(name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "tool";
}

// --- protocol → CSF ---

/**
 * Convert the cockpit's uniform protocol-message stream (as produced by
 * history.mjs:readSessionForReplay for EVERY family — Claude native and the
 * cockpit-owned protocol JSONL alike) into an ordered CSF event list.
 *
 * This is the single importer: the cockpit already normalizes all four native
 * formats into protocol messages, so CSF is built once from that stream rather
 * than parsing four native schemas. See the decision doc.
 *
 * `defaultModel` labels assistant messages (protocol replay drops per-message
 * model attribution); pass the session's model.
 */
export function protocolToCsf(messages, { defaultModel = null } = {}) {
  const events = [];
  let current = null; // in-progress assistant message
  const toolParts = new Map(); // tool id -> part ref, to attach input on tool_input

  const flush = () => {
    if (current && current.parts.length) events.push(current);
    current = null;
  };
  const ensureAssistant = () => {
    if (!current) current = { type: "message", role: "assistant", model: defaultModel, parts: [] };
    return current;
  };

  for (const msg of messages) {
    switch (msg.type) {
      case "user_message": {
        flush();
        events.push({
          type: "message",
          role: "user",
          parts: [{ type: "text", text: String(msg.content ?? "") }],
          ts: msg.timestamp || undefined,
        });
        break;
      }
      case "text_done": {
        if (msg.text) ensureAssistant().parts.push({ type: "text", text: msg.text });
        break;
      }
      case "tool_start": {
        const part = { type: "tool_call", id: msg.id, name: msg.name || "tool", input: {} };
        ensureAssistant().parts.push(part);
        if (msg.id) toolParts.set(msg.id, part);
        break;
      }
      case "tool_input": {
        const part = toolParts.get(msg.id);
        if (part) part.input = msg.input || {};
        break;
      }
      case "tool_result": {
        flush();
        events.push({
          type: "tool_result",
          callId: msg.id,
          output: stringifyToolOutput(msg.content),
          isError: !!msg.is_error,
        });
        break;
      }
      case "plan_done": {
        // Plan text is meaningful conversation content; carry it as assistant text.
        const planText = msg.plan?.plan || msg.plan?.text;
        if (planText) ensureAssistant().parts.push({ type: "text", text: String(planText) });
        break;
      }
      case "session_event": {
        if (msg.event === "compacted") {
          flush();
          events.push({ type: "compaction", summary: msg.summary || "" });
        }
        break;
      }
      case "turn_done":
        flush();
        break;
      default:
        break; // init, ask_user, subagent_*, etc. carry no replayable content
    }
  }
  flush();
  return events;
}

/** Tool-result content (string | array of blocks) → a single string. */
export function stringifyToolOutput(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "text") return b.text || "";
        if (b?.type === "image") return `[image: ${b.source?.media_type || "image/png"}]`;
        return typeof b === "object" ? JSON.stringify(b) : String(b);
      })
      .join("\n");
  }
  if (typeof content === "object") return JSON.stringify(content);
  return String(content);
}

/** The first user message text, truncated — used as the CSF/session title. */
export function deriveTitle(events) {
  for (const ev of events) {
    if (ev.type === "message" && ev.role === "user") {
      const text = (ev.parts || []).map((p) => p.text || "").join(" ").trim();
      if (text) return text.length > 80 ? text.slice(0, 80) + "…" : text;
    }
  }
  return "Portable session";
}

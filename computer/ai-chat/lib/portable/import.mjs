/**
 * Importer: native/cockpit session → CSF.
 *
 * There is ONE importer path. The cockpit's history.mjs:readSessionForReplay
 * already normalizes every family into a uniform protocol-message stream:
 *  - Claude: parses the native ~/.claude/projects JSONL.
 *  - Codex/Gemini/OpenCode: parse the cockpit-owned protocol JSONL in
 *    CODEX_HISTORY_DIR (written by SessionManager as those turns happen).
 * So CSF is built once, from that stream, rather than parsing four native
 * schemas — DRY and reusing proven code. See the decision doc for why this
 * beats N native importers.
 */

import { existsSync } from "node:fs";
import { findSessionFile, readSessionForReplay } from "../history.mjs";
import { protocolToCsf, deriveTitle, CSF_VERSION, uuid4 } from "./csf.mjs";

/**
 * Import a source session (identified by its native/cockpit session id) into a
 * CSF document.
 *
 * @param {object} opts
 * @param {string} opts.sessionId  the source session id
 * @param {string} opts.family     the source agent family (claude|codex|gemini|opencode)
 * @param {string} opts.model      the source model (labels assistant messages)
 * @param {string} opts.cwd        the slot workspace
 * @param {string} [opts.cliVersion]
 * @returns {{csf:object, stats:{events:number, messages:number, toolCalls:number}}}
 * @throws if the source session file cannot be located (no silent fallback).
 */
export function importSession({ sessionId, family, model, cwd, cliVersion = null }) {
  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile || !existsSync(sessionFile)) {
    throw new Error(
      `Cannot locate the source session file for ${family} session ${sessionId} — nothing to translate.`,
    );
  }

  const messages = readSessionForReplay(sessionFile);
  const events = protocolToCsf(messages, { defaultModel: model });

  const now = Date.now();
  const csf = {
    csf: CSF_VERSION,
    session: {
      id: `csf_${uuid4()}`,
      cwd,
      title: deriveTitle(events),
      createdAt: now,
      source: { family, model, nativeSessionId: sessionId, cliVersion },
      lineage: [{ family, nativeSessionId: sessionId, switchedAt: now }],
    },
    events,
  };

  const stats = {
    events: events.length,
    messages: events.filter((e) => e.type === "message").length,
    toolCalls: events.reduce(
      (n, e) =>
        n + (e.type === "message" ? (e.parts || []).filter((p) => p.type === "tool_call").length : 0),
      0,
    ),
  };
  return { csf, stats, sourceFile: sessionFile };
}

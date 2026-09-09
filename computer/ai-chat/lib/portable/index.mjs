/**
 * Portable sessions — the public entry point (roadmap B1).
 *
 * handoffSession() translates a live conversation from one agent family into a
 * fresh native session file the target family resumes as its own: import →
 * normalize to CSF → export → persist the CSF as a lineage/audit artifact.
 *
 * Pure Node, no dependency on the agent layer / MCP / any module (invariant 3:
 * portable sessions is a CORE feature). Logs generously; never swallows errors.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importSession } from "./import.mjs";
import { exportSession } from "./export.mjs";
import { CSF_DIR } from "./csf.mjs";

const execFileP = promisify(execFile);

/**
 * Best-effort CLI version probe (recorded in the artifact for upgrade triage).
 * Async + non-blocking: `handoffSession` runs on the single ai-chat event loop,
 * so a synchronous probe would freeze every slot's streaming for the probe's
 * duration (up to the 5s timeout if a CLI hangs). null is an accepted fallback.
 */
async function probeVersion(cmd) {
  try {
    const { stdout } = await execFileP(cmd, ["--version"], { encoding: "utf8", timeout: 5000 });
    return stdout.trim().split("\n")[0];
  } catch (e) {
    console.warn(`[portable] version probe for '${cmd}' failed (best-effort, recording null): ${e.message}`);
    return null;
  }
}

const CMD_FOR = { claude: "claude", codex: "codex", antigravity: "agy", opencode: "opencode" };

/**
 * @param {object} opts
 * @param {string} opts.fromFamily
 * @param {string} opts.fromSessionId
 * @param {string} opts.fromModel
 * @param {string} opts.toFamily
 * @param {string} opts.toModel
 * @param {string} opts.cwd
 * @returns {Promise<{nativeSessionId:string, csfId:string, stats:object}>}
 */
export async function handoffSession({ fromFamily, fromSessionId, fromModel, toFamily, toModel, cwd }) {
  const t0 = Date.now();
  // Probe both CLIs concurrently, off the critical path — never serialize two
  // blocking version checks on the shared event loop (freezes all slots).
  const [sourceVersion, targetVersion] = await Promise.all([
    probeVersion(CMD_FOR[fromFamily]),
    probeVersion(CMD_FOR[toFamily]),
  ]);

  const { csf, stats } = importSession({
    sessionId: fromSessionId,
    family: fromFamily,
    model: fromModel,
    cwd,
    cliVersion: sourceVersion,
  });

  // Every exporter gets the target model, so synthesized assistant messages are
  // tagged with the family the session is becoming — not the source model id
  // (a cross-family artifact: a Gemini id inside a Claude JSONL).
  const exportOpts = { model: toModel };
  if (toFamily === "claude") exportOpts.cliVersion = targetVersion || "portable-sessions";
  if (toFamily === "codex") exportOpts.cliVersion = (targetVersion && targetVersion.match(/\d+\.\d+\.\d+/)?.[0]) || "0.142.4";

  const result = await exportSession(toFamily, csf, exportOpts);

  // Record the handoff in the CSF lineage + persist the artifact (ShellTeam dir).
  csf.session.lineage.push({ family: toFamily, nativeSessionId: result.nativeSessionId, switchedAt: Date.now() });
  csf.session.target = { family: toFamily, model: toModel, nativeSessionId: result.nativeSessionId, cliVersion: targetVersion };
  mkdirSync(CSF_DIR, { recursive: true });
  const csfPath = join(CSF_DIR, `${csf.session.id}.json`);
  writeFileSync(csfPath, JSON.stringify(csf, null, 2));

  const ms = Date.now() - t0;
  console.log(
    `[portable] ${fromFamily}(${fromSessionId}) → ${toFamily}(${result.nativeSessionId}) — ` +
      `${stats.events} events, ${result.toolCalls} tool calls, ${result.synthesized} synthesized results, ${ms}ms ` +
      `[csf=${csf.session.id}, ${sourceVersion || "?"} → ${targetVersion || "?"}]`,
  );

  return { nativeSessionId: result.nativeSessionId, csfId: csf.session.id, csfPath, stats: { ...stats, synthesized: result.synthesized, ms } };
}

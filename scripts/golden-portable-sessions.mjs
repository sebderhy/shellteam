#!/usr/bin/env node
/**
 * Golden matrix — the release-bar prover for portable sessions (roadmap B1).
 *
 * For each of the 12 ordered family pairs: plant a codeword in a SOURCE session
 * (written exactly as the cockpit persists it — Claude native JSONL, or the
 * cockpit-owned protocol JSONL for Codex/Gemini/OpenCode, i.e. the same input
 * history.mjs:readSessionForReplay consumes), run the real handoffSession(), then
 * resume with the TARGET CLI and assert the codeword is recalled.
 *
 * This is the "verified on a stranger's box" gate: run it before merge, before
 * launch on the fresh box, and after any CLI upgrade. Real keys required.
 *
 * Usage:
 *   node scripts/golden-portable-sessions.mjs                 # all 12 pairs
 *   node scripts/golden-portable-sessions.mjs claude codex    # only pairs among these families
 *   PAIRS=claude>codex,codex>claude node scripts/…            # explicit pairs
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HOME, CODEX_HISTORY_DIR } from "../computer/ai-chat/lib/constants.mjs";
import { encodeCwd, uuid4 } from "../computer/ai-chat/lib/portable/csf.mjs";
import { handoffSession } from "../computer/ai-chat/lib/portable/index.mjs";

const execFileP = promisify(execFile);

const FAMILIES = ["claude", "codex", "gemini", "opencode"];
const MODEL = {
  claude: "claude-haiku-4-5-20251001",
  codex: "gpt-5.6-sol",
  gemini: "gemini-3-flash-preview",
  opencode: "glm-5p2",
};

const WS = "/tmp/portable-golden-ws";

// --- source writers: produce a session file the importer will read ---

function seedClaudeSource(codeword) {
  const sid = uuid4();
  const dir = join(HOME, ".claude", "projects", encodeCwd(WS));
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const u = uuid4(), a = uuid4(), t = uuid4(), a2 = uuid4();
  // A tool whose name has chars Codex/OpenAI reject (`.`) — proves the Claude→Codex
  // handoff sanitizes historical function_call names (SHE-76). Without the fix the
  // real `codex exec resume` below 400s before the model ever answers.
  const callId = "toolu_golden1";
  const base = { isSidechain: false, sessionId: sid, cwd: WS, version: "golden", gitBranch: "", userType: "external" };
  const lines = [
    JSON.stringify({ ...base, parentUuid: null, type: "user", uuid: u, timestamp: now, message: { role: "user", content: `Remember the codeword: ${codeword}. Reply with just OK.` } }),
    JSON.stringify({ ...base, parentUuid: u, type: "assistant", uuid: a, timestamp: now, message: { model: MODEL.claude, type: "message", role: "assistant", content: [{ type: "tool_use", id: callId, name: "mcp__acme.co__fetch.thing", input: { q: "noop" } }] } }),
    JSON.stringify({ ...base, parentUuid: a, type: "user", uuid: t, timestamp: now, message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "noted", is_error: false }] } }),
    JSON.stringify({ ...base, parentUuid: t, type: "assistant", uuid: a2, timestamp: now, message: { model: MODEL.claude, type: "message", role: "assistant", content: [{ type: "text", text: "OK" }] } }),
  ];
  writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
  return sid;
}

// Codex/Gemini/OpenCode cockpit sessions live as protocol JSONL in CODEX_HISTORY_DIR.
function seedProtocolSource(family, codeword) {
  const sid = family === "opencode" ? `ses_golden${Date.now()}` : uuid4();
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", model: MODEL[family], cwd: WS, timestamp: Date.now() }),
    JSON.stringify({ type: "user_message", content: `Remember the codeword: ${codeword}. Reply with just OK.`, timestamp: Date.now() }),
    JSON.stringify({ type: "text_done", text: "OK" }),
    JSON.stringify({ type: "turn_done", cost: 0 }),
  ];
  writeFileSync(join(CODEX_HISTORY_DIR, `${sid}.jsonl`), lines.join("\n") + "\n");
  return sid;
}

function seedSource(family, codeword) {
  return family === "claude" ? seedClaudeSource(codeword) : seedProtocolSource(family, codeword);
}

// --- target resumers: resume the handed-off session, return the model's answer ---

const QUESTION = "What codeword did I ask you to remember? Reply with only the word.";

async function resume(family, sessionId) {
  // OpenCode runs on the shared Fireworks endpoint (glm-5p2), which is
  // materially slower per turn than the local-auth CLIs — give it real
  // headroom so the matrix measures translation correctness, not endpoint
  // latency. (The translation itself is fast; the model turn is the wait.)
  const timeout = family === "opencode" ? 420000 : 180000;
  const opts = { cwd: WS, timeout, maxBuffer: 64 * 1024 * 1024 };
  if (family === "claude") {
    const { stdout } = await execFileP("claude", ["--dangerously-skip-permissions", "--model", MODEL.claude, "--resume", sessionId, "-p", QUESTION], opts);
    return stdout;
  }
  if (family === "codex") {
    const { stdout } = await execFileP("codex", ["exec", "resume", sessionId, "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", QUESTION], opts);
    return stdout;
  }
  if (family === "gemini") {
    const { stdout } = await execFileP("gemini", ["-y", "-m", MODEL.gemini, "--resume", sessionId, "-p", QUESTION], { ...opts, env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } });
    return stdout;
  }
  if (family === "opencode") {
    const { stdout } = await execFileP("opencode", ["run", "--session", sessionId, "--format", "json", "--dangerously-skip-permissions", "--model", `fireworks/${MODEL.opencode}`, QUESTION], opts);
    return stdout;
  }
  throw new Error(`no resumer for ${family}`);
}

// --- driver ---

function selectedPairs() {
  if (process.env.PAIRS) {
    return process.env.PAIRS.split(",").map((p) => p.split(">").map((s) => s.trim()));
  }
  const fams = process.argv.slice(2).length ? process.argv.slice(2) : FAMILIES;
  const pairs = [];
  for (const from of fams) for (const to of fams) if (from !== to) pairs.push([from, to]);
  return pairs;
}

async function main() {
  mkdirSync(WS, { recursive: true });
  const pairs = selectedPairs();
  const results = [];
  let n = 0;
  for (const [from, to] of pairs) {
    const codeword = `CODE${(++n).toString().padStart(2, "0")}${from.toUpperCase().slice(0, 3)}${to.toUpperCase().slice(0, 3)}`;
    process.stdout.write(`\n[${n}/${pairs.length}] ${from} → ${to}  (codeword ${codeword})\n`);
    try {
      const fromSessionId = seedSource(from, codeword);
      const { nativeSessionId } = await handoffSession({
        fromFamily: from, fromSessionId, fromModel: MODEL[from],
        toFamily: to, toModel: MODEL[to], cwd: WS,
      });
      const answer = await resume(to, nativeSessionId);
      const pass = answer.includes(codeword);
      results.push({ from, to, pass });
      console.log(`   ${pass ? "✅ PASS" : "❌ FAIL"} — target ${to} ${pass ? "recalled" : "did NOT recall"} the codeword`);
      if (!pass) console.log("   answer tail:", answer.slice(-200).replace(/\n/g, " "));
    } catch (e) {
      const detail = (e.stderr || e.stdout || e.message || "").toString().trim().slice(-300);
      results.push({ from, to, pass: false, error: detail || e.message });
      console.log(`   ❌ ERROR — ${detail || e.message}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================ ${passed}/${results.length} pairs passed ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.from} → ${r.to}${r.error ? "  (" + r.error + ")" : ""}`);
  try { rmSync(WS, { recursive: true, force: true }); } catch {}
  process.exit(passed === results.length ? 0 : 1);
}

main();

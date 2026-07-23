/**
 * Single source of truth for per-agent metadata.
 *
 * Each entry describes one coding agent family: how to detect it from a
 * model string, which adapter class wraps its CLI for chat mode, which
 * command + args to spawn for terminal (TUI) mode, and which capabilities
 * the platform should enable for it.
 *
 * To add a new agent: append one row. To remove one: delete the row.
 * Order matters only for the default — the first entry is the fallback.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import {
  antigravityLayerArgs,
  claudeLayerArgs,
  codexHarnessEnv,
  codexLayerArgs,
} from "../agent-layer.mjs";
import { agentIdForModel, cliModelForId, configArgsForId } from "../model-catalog.mjs";

// Per-agent *runtime* metadata: adapter class, terminal spawn, capabilities. The
// model->agent routing (which models each family owns) lives in the catalog
// (config/models.json), not here — see model-catalog.mjs's agentIdForModel.
export const AGENTS = [
  {
    id: "claude",
    label: "Claude",
    adapter: { import: () => import("../claude-cli-agent.mjs"), klass: "ClaudeCliAgent" },
    terminal: {
      cmd: "claude",
      // ShellTeam-managed TUI gets the same additive layer as the cockpit chat.
      args: (model, { sessionId, cwd } = {}) => [
        "--dangerously-skip-permissions",
        "--model", model,
        ...claudeLayerArgs(cwd),
        ...(sessionId ? ["--resume", sessionId] : []),
      ],
    },
    supports: { rewind: true, resume: true, cliOwnsHistory: true },
  },
  {
    id: "codex",
    label: "Codex",
    adapter: { import: () => import("../codex-agent.mjs"), klass: "CodexAgent" },
    terminal: {
      cmd: "codex",
      args: (model, { cwd } = {}) => [
        "--dangerously-bypass-approvals-and-sandbox",
        ...codexLayerArgs(cwd),
        ...configArgsForId(model),
        "-m", cliModelForId(model),
      ],
    },
    supports: { rewind: false, resume: true, cliOwnsHistory: false },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    // Google's `agy` CLI (replaces the decommissioned Gemini CLI). Non-streaming
    // JSON envelope per turn; resumes via --conversation. `agy --model` wants the
    // display name, so map the catalog id through cliModelForId.
    adapter: { import: () => import("../antigravity-agent.mjs"), klass: "AntigravityAgent" },
    terminal: {
      cmd: "agy",
      args: (model, { sessionId, cwd } = {}) => [
        "--dangerously-skip-permissions",
        "--model", cliModelForId(model),
        ...antigravityLayerArgs(cwd),
        ...(sessionId ? ["--conversation", sessionId] : []),
      ],
    },
    supports: { rewind: false, resume: true, cliOwnsHistory: false },
  },
  {
    id: "opencode",
    label: "OpenCode",
    // Fireworks-hosted models served via the managed OpenCode proxy.
    adapter: { import: () => import("../opencode-agent.mjs"), klass: "OpenCodeAgent" },
    terminal: {
      cmd: "opencode",
      args: (model, { sessionId } = {}) => [
        ...(sessionId ? ["--session", sessionId] : []),
        "--model", `fireworks/${model}`,
      ],
    },
    supports: { rewind: false, resume: true, cliOwnsHistory: false },
  },
];

const DEFAULT = AGENTS[0];
const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

export function pickAgent(model) {
  if (!model) return DEFAULT;
  return BY_ID.get(agentIdForModel(model)) ?? DEFAULT;
}

export function agentIdFor(model) {
  return pickAgent(model).id;
}

export function supports(model, capability) {
  return pickAgent(model).supports[capability] ?? false;
}

export async function loadAdapterClass(model) {
  const def = pickAgent(model);
  const mod = await def.adapter.import();
  return mod[def.adapter.klass];
}

export function terminalSpawn(model, opts = {}) {
  const def = pickAgent(model);
  return { cmd: def.terminal.cmd, args: def.terminal.args(model, opts) };
}

/** Apply any per-family launch environment without changing the user's shell. */
export function agentLaunchEnv(model, env) {
  return pickAgent(model).id === "codex" ? codexHarnessEnv(env) : env;
}

function commandOnPath(cmd) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // not in this PATH entry — keep looking
    }
  }
  return false;
}

/**
 * Which agent families this box can actually launch: the family's CLI binary
 * must exist on PATH. The status payload carries this so the UI never offers
 * an agent that can't run — the employee container ships only claude + codex,
 * and advertising all four gave guests a dead "Connecting…" tab. Probed per
 * call (a handful of stats) so installing a CLI shows up without a restart.
 */
export function installedAgents() {
  return Object.fromEntries(AGENTS.map((a) => [a.id, commandOnPath(a.terminal.cmd)]));
}

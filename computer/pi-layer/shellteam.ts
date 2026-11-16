// ShellTeam's Pi launch-layer extension (static; copied verbatim to
// ~/.shellteam/agent-layer/pi/shellteam.ts by api/services/agent_layer.py).
//
// It reads the layer JSON the control plane builds (`pi/layer.json`, or the
// path in SHELLTEAM_PI_LAYER, which the cockpit points at a per-project copy)
// and registers:
//   - the "shellteam" provider: the Fireworks models of config/models.json,
//     reached through the control plane's /internal/ai/fireworks relay. The
//     key and headers are `$VAR` references Pi resolves from the environment,
//     so no secret is ever written in the file.
//   - one MCP server per `mcpServers` entry (empty in pure core).
// Prompt and skills are NOT here: the cockpit passes --append-system-prompt
// and --skill when the manifest enables them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type LayerModel = {
  id: string;
  name: string;
  alias: string;
  contextWindow: number;
  maxTokens: number;
  reasoningEffort?: string;
  cost?: { input: number; output: number };
};

type McpServer =
  | { url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

type Layer = {
  provider: {
    baseUrl: string;
    api: string;
    apiKeyEnv: string;
    headersEnv?: Record<string, string>;
    models: LayerModel[];
  };
  mcpServers: Record<string, McpServer>;
};

function layerPath(): string {
  return process.env.SHELLTEAM_PI_LAYER || join(dirname(fileURLToPath(import.meta.url)), "layer.json");
}

function readLayer(path: string): Layer {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`ShellTeam Pi layer: cannot read ${path} (${(err as Error).message})`);
  }
  let layer: Layer;
  try {
    layer = JSON.parse(text);
  } catch (err) {
    throw new Error(`ShellTeam Pi layer: ${path} is not valid JSON (${(err as Error).message})`);
  }
  const p = layer?.provider;
  if (!p || !p.baseUrl || !p.api || !p.apiKeyEnv || !Array.isArray(p.models)) {
    throw new Error(`ShellTeam Pi layer: ${path} has no complete "provider" (baseUrl, api, apiKeyEnv, models)`);
  }
  if (!layer.mcpServers || typeof layer.mcpServers !== "object") {
    throw new Error(`ShellTeam Pi layer: ${path} has no "mcpServers" object`);
  }
  return layer;
}

export default function (pi: ExtensionAPI) {
  const layer = readLayer(layerPath());
  const { provider } = layer;

  const headers: Record<string, string> = {};
  for (const [name, envName] of Object.entries(provider.headersEnv ?? {})) {
    headers[name] = "$" + envName;
  }

  pi.registerProvider("shellteam", {
    name: "ShellTeam",
    baseUrl: provider.baseUrl,
    api: provider.api as any,
    apiKey: "$" + provider.apiKeyEnv,
    headers,
    models: provider.models.map((m) => ({
      type: "chat" as const,
      id: m.id,
      name: m.name,
      reasoning: true,
      thinkingLevelMap: { high: "high", xhigh: "max", max: "max" },
      input: ["text" as const],
      cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: { thinkingFormat: "openai" as const, supportsReasoningEffort: true },
    })) as any,
  });

  for (const [name, cfg] of Object.entries(layer.mcpServers)) {
    if ("url" in cfg) {
      pi.registerMcpServer(name, { url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) });
    } else if ("command" in cfg) {
      pi.registerMcpServer(name, {
        command: cfg.command,
        ...(cfg.args ? { args: cfg.args } : {}),
        ...(cfg.env ? { env: cfg.env } : {}),
      });
    } else {
      throw new Error(`ShellTeam Pi layer: MCP server "${name}" has neither "url" nor "command"`);
    }
  }
}

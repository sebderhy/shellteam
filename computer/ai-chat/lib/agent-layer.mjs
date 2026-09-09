import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HOME, OPENAI_API_KEY_FILE } from "./constants.mjs";

// ShellTeam's additive launch-layer, built by the control plane under the owner's
// home (see api/services/agent_layer.py). The cockpit and the ShellTeam-managed
// terminal load it at spawn time so a cockpit agent == the user's config PLUS
// ShellTeam's skills/hooks/MCP/persona — while an agent the user runs by hand in
// their own shell stays untouched. Nothing here writes to the user's dotfiles.
//
// PURITY GATE: the builder writes a `layer.json` manifest recording the enabled
// MODULES and which artifacts exist. With no modules (the core default) the
// manifest says "nothing" and every function here returns []/null — a cockpit
// agent then spawns bit-identical to a hand-run CLI (contract-tested in
// test/purity-contract.test.mjs). A manifest that promises an artifact which is
// missing on disk is a build bug and warns loudly — never silently degrades.
const LAYER_DIR = join(HOME, ".shellteam", "agent-layer");
const LAYER_MANIFEST = join(LAYER_DIR, "layer.json");
const CLAUDE_PLUGIN_DIR = join(LAYER_DIR, "claude");
const CLAUDE_MCP_CONFIG = join(LAYER_DIR, "claude-mcp.json");
const CLAUDE_SYSTEM_PROMPT = join(LAYER_DIR, "system-prompt.md");
const CODEX_OVERRIDES = join(LAYER_DIR, "codex", "overrides.json");
const CODEX_SESSION_HOME = join(LAYER_DIR, "codex-home");
const ANTIGRAVITY_WORKSPACE = join(LAYER_DIR, "antigravity-workspace");
const ANTIGRAVITY_PLUGIN = join(ANTIGRAVITY_WORKSPACE, ".agents", "plugins", "shellteam");
const ANTIGRAVITY_MCP_CONFIG = join(ANTIGRAVITY_PLUGIN, "mcp_config.json");
const OPENCODE_CONFIG = join(LAYER_DIR, "opencode.json");
const RUNTIME_DIR = join(LAYER_DIR, "runtime");

function uniq(xs) {
  return [...new Set(xs.filter(Boolean))];
}

function projectInfoForCwd(cwd) {
  const root = cwd && (cwd === HOME || cwd.startsWith(`${HOME}/`))
    ? cwd.slice(HOME.length).replace(/^\/+/, "").split("/")[0]
    : "";
  const slug = root.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return {
    root: root ? join(HOME, root) : HOME,
    slug,
  };
}

function readEnvValue(path, name) {
  if (!existsSync(path)) return null;
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`);
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    return v || null;
  }
  return null;
}

function linearModuleEnabled(manifest) {
  return Array.isArray(manifest?.modules) && manifest.modules.includes("linear");
}

function linearKeyForCwd(cwd) {
  const { root, slug } = projectInfoForCwd(cwd || HOME);
  for (const name of uniq([
    slug ? `${slug}_LINEAR_API_KEY` : "",
    slug ? `LINEAR_API_KEY_${slug}` : "",
  ])) {
    if (process.env[name]) return process.env[name];
  }
  for (const path of uniq([
    cwd ? join(cwd, ".env") : "",
    join(root, ".env"),
    join(root, "code", ".env"),
  ])) {
    const key = readEnvValue(path, "LINEAR_API_KEY");
    if (key) return key;
  }
  return process.env.LINEAR_API_KEY || null;
}

function linearServerForCwd(cwd) {
  const key = linearKeyForCwd(cwd);
  if (!key) return null;
  return {
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: `Bearer ${key}` },
  };
}

function runtimeClaudeMcpPath(manifest, baseEnabled, cwd) {
  if (!linearModuleEnabled(manifest)) return baseEnabled ? CLAUDE_MCP_CONFIG : null;

  const linear = linearServerForCwd(cwd);
  if (!linear) return baseEnabled ? CLAUDE_MCP_CONFIG : null;

  const cfg = baseEnabled
    ? JSON.parse(readFileSync(CLAUDE_MCP_CONFIG, "utf8"))
    : { mcpServers: {} };
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.linear = linear;

  mkdirSync(RUNTIME_DIR, { recursive: true });
  const slug = (projectInfoForCwd(cwd || HOME).slug || "default").toLowerCase();
  const path = join(RUNTIME_DIR, `claude-mcp-${slug}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

function dynamicCodexLinearOverrides(manifest, cwd) {
  if (!linearModuleEnabled(manifest)) return [];
  const linear = linearServerForCwd(cwd);
  if (!linear) return [];
  return [
    `mcp_servers.linear.url=${JSON.stringify(linear.url)}`,
    `mcp_servers.linear.http_headers={ "Authorization" = ${JSON.stringify(linear.headers.Authorization)} }`,
  ];
}

function isLinearCodexOverride(o) {
  return typeof o === "string" && o.startsWith("mcp_servers.linear.");
}

// --- knowledge composition (dreaming module) -----------------------------------------
//
// The "AI employee" mechanic: an agent spawned in a folder gets that folder's
// knowledge node (+ the user layer), never a sibling's. The nightly dream sweep
// (api/services/dreaming.py) fills the tree; this composes it at spawn time.
// Node resolution mirrors api/services/knowledge_tree.node_for_cwd — keep in sync.

const KNOWLEDGE_DIR = join(HOME, ".shellteam", "knowledge");
const USER_LAYER_FILES = ["identity.md", "preferences.md", "feedback.md"];
const ROOT_LAYER_FILES = ["projects.md", "contacts.md"];
const MAX_KNOWLEDGE_FILE_CHARS = 8000;

function knowledgeModuleEnabled(manifest) {
  // dreaming = the owner box (the nightly sweep fills the tree). employee = a
  // sandbox whose HOME the host seeds with ONLY that folder's knowledge node
  // on every ensure (employees.py:_sync_project_knowledge) — composition is a
  // no-op until files exist, so enabling it here grants nothing by itself.
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  return modules.includes("dreaming") || modules.includes("employee");
}

function knowledgeNodeForCwd(cwd) {
  // Strip trailing slashes first: "HOME/" would otherwise slip past the HOME
  // check and resolve to an undefined node (crashing composition).
  const c = (cwd || HOME).replace(/\/+$/, "") || "/";
  if (c === HOME || !c.startsWith(`${HOME}/`)) return "";
  const parts = c.slice(HOME.length + 1).split("/").filter(Boolean);
  if (!parts.length) return "";
  if (parts.some((p) => p.startsWith("."))) return null; // dot-dirs: excluded scope
  for (let depth = parts.length; depth >= 1; depth--) {
    const cand = parts.slice(0, depth).join("/");
    if (existsSync(join(KNOWLEDGE_DIR, "tree", cand, "index.md"))) return cand;
  }
  return parts[0];
}

function readKnowledgeFile(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  if (!text) return null;
  return text.length > MAX_KNOWLEDGE_FILE_CHARS
    ? text.slice(0, MAX_KNOWLEDGE_FILE_CHARS) + "\n\n*(truncated for spawn injection)*"
    : text;
}

/**
 * The knowledge markdown an agent spawned in `cwd` should carry, or null when
 * there is none (fresh box) / the scope is excluded. User layer everywhere;
 * cross-project map only at root/manager scope; a project cwd gets its node's
 * ancestor chain root-down — never siblings.
 */
function composeKnowledge(node) {
  const sections = [];
  for (const f of USER_LAYER_FILES) {
    const text = readKnowledgeFile(join(KNOWLEDGE_DIR, f));
    if (text) sections.push(`## About the owner — ${f}\n\n${text}`);
  }
  if (node === "") {
    for (const f of ROOT_LAYER_FILES) {
      const text = readKnowledgeFile(join(KNOWLEDGE_DIR, f));
      if (text) sections.push(`## Cross-project map — ${f}\n\n${text}`);
    }
  } else {
    const parts = node.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const rel = parts.slice(0, depth).join("/");
      const text = readKnowledgeFile(join(KNOWLEDGE_DIR, "tree", rel, "index.md"));
      if (text) sections.push(`## Project knowledge — ~/${rel}\n\n${text}`);
    }
  }
  if (!sections.length) return null;
  return [
    "# What this computer knows (consolidated nightly by ShellTeam dreaming)",
    "",
    "The owner reads and edits this in the dashboard's Knowledge tab. Treat it",
    "as trusted background context, but verify current state before acting on",
    "anything time-sensitive. Details live under ~/.shellteam/knowledge/.",
    "",
    ...sections,
  ].join("\n");
}

function knowledgeSlug(node) {
  if (!node) return "root";
  const base = node.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";
  // Distinct nodes can collide after slugging (~/My-App vs ~/my-app): a short
  // node hash keeps every node's runtime file its own, so a concurrent spawn
  // in a colliding sibling can never hand this agent that sibling's knowledge.
  return `${base}-${createHash("sha1").update(node).digest("hex").slice(0, 6)}`;
}

/**
 * The composed knowledge for `cwd` as {knowledge, slug}, or null when the
 * module is off / the scope is excluded / there is nothing to inject. The one
 * place node resolution runs per spawn.
 */
function composedKnowledgeFor(manifest, cwd) {
  if (!knowledgeModuleEnabled(manifest)) return null;
  const node = knowledgeNodeForCwd(cwd);
  if (node === null) return null;
  const knowledge = composeKnowledge(node);
  if (!knowledge) return null;
  return { knowledge, slug: knowledgeSlug(node) };
}

function writeRuntimeFile(name, content) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const path = join(RUNTIME_DIR, name);
  writeFileSync(path, content);
  return path;
}

/**
 * The single shared prompt artifact for a workspace. Without the dreaming module
 * (or with no knowledge for this cwd) it is exactly the canonical prompt file.
 * With knowledge, a per-node runtime file composes prompt + knowledge once, then
 * every adapter reads those exact bytes through its native transport.
 */
function runtimeHarnessPromptPath(manifest, promptEnabled, cwd) {
  const composed = composedKnowledgeFor(manifest, cwd);
  if (!composed) return promptEnabled ? CLAUDE_SYSTEM_PROMPT : null;
  const prompt = promptEnabled ? readFileSync(CLAUDE_SYSTEM_PROMPT, "utf8").trimEnd() : "";
  return writeRuntimeFile(
    `harness-prompt-${composed.slug}.md`,
    prompt ? `${prompt}\n\n${composed.knowledge}\n` : `${composed.knowledge}\n`,
  );
}

/**
 * Read the purity-gate manifest. Returns:
 *  - the parsed manifest when present,
 *  - null for a legacy layer (artifacts exist but no manifest yet — a box that
 *    hasn't rebuilt since the purity gate shipped): honor the artifacts,
 *  - {artifacts: {}} when neither exists (fresh core box: nothing to load).
 */
function readManifest() {
  if (existsSync(LAYER_MANIFEST)) {
    try {
      return JSON.parse(readFileSync(LAYER_MANIFEST, "utf8"));
    } catch (err) {
      console.error(`[agent-layer] Unreadable manifest ${LAYER_MANIFEST} (${err.message}) — ` +
        `treating the layer as legacy (artifact presence decides). Re-run start_computer to rebuild.`);
      return null;
    }
  }
  if (existsSync(CLAUDE_PLUGIN_DIR) || existsSync(CLAUDE_MCP_CONFIG) ||
      existsSync(CLAUDE_SYSTEM_PROMPT) || existsSync(CODEX_OVERRIDES)) {
    console.warn(`[agent-layer] Layer artifacts exist but ${LAYER_MANIFEST} is missing — ` +
      `pre-purity-gate layer detected; loading it as before. Trigger start_computer ` +
      `(or re-run install.sh) to rebuild with a manifest.`);
    return null; // legacy: artifact presence decides
  }
  // No manifest AND no artifacts: the layer was never built (a pure-core build
  // still writes layer.json). Not fatal — agents run with the user's own config
  // — but say so, because a full-mode box in this state is missing its layer.
  console.warn(`[agent-layer] No layer at ${LAYER_DIR} (never built?) — agents run ` +
    `with the user's own config only. Trigger start_computer or re-run install.sh.`);
  return { artifacts: {} };
}

/**
 * The modules enabled on this box, per the layer manifest. [] in pure core
 * (or when the layer was never built / is legacy). The cockpit uses this to
 * keep first-run copy honest — never promise a module that isn't installed.
 */
export function enabledModules() {
  return readManifest()?.modules ?? [];
}

/**
 * True when the manifest (or legacy artifact-presence) says this artifact should
 * load. Warns loudly on a manifest/disk mismatch.
 */
function artifactEnabled(manifest, key, path, what) {
  if (manifest === null) return existsSync(path); // legacy layer
  if (!manifest.artifacts?.[key]) return false;   // gated off (core / module absent)
  if (!existsSync(path)) {
    console.error(`[agent-layer] Manifest promises ${key} but ${path} is missing — ` +
      `${what} NOT loaded. Trigger start_computer or re-run install.sh to rebuild the layer.`);
    return false;
  }
  return true;
}

function harnessPromptFor(manifest, cwd) {
  const enabled = artifactEnabled(
    manifest, "claude_system_prompt", CLAUDE_SYSTEM_PROMPT, "ShellTeam shared prompt",
  );
  return runtimeHarnessPromptPath(manifest, enabled, cwd);
}

function openCodeMcpServer(server) {
  if (server.url) {
    return {
      type: "remote",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  if (server.command) {
    return {
      type: "local",
      command: [server.command, ...(server.args || [])],
      ...(server.env ? { environment: server.env } : {}),
    };
  }
  return null;
}

function antigravityMcpServer(server) {
  if (server.url) {
    return {
      serverUrl: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  if (server.command) {
    return {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return null;
}

function runtimeAntigravityWorkspace(manifest, cwd, promptPath) {
  const linear = linearModuleEnabled(manifest) ? linearServerForCwd(cwd) : null;
  const dynamicPrompt = promptPath && promptPath !== CLAUDE_SYSTEM_PROMPT;
  if (!linear && !dynamicPrompt) return ANTIGRAVITY_WORKSPACE;

  const slug = (projectInfoForCwd(cwd || HOME).slug || "default").toLowerCase();
  const workspace = join(RUNTIME_DIR, `antigravity-${slug}`);
  cpSync(ANTIGRAVITY_WORKSPACE, workspace, { recursive: true, force: true });
  const plugin = join(workspace, ".agents", "plugins", "shellteam");

  if (promptPath) {
    const rules = join(plugin, "rules");
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "shellteam.md"), readFileSync(promptPath, "utf8"));
  }
  if (linear) {
    const mcpPath = join(plugin, "mcp_config.json");
    const cfg = existsSync(mcpPath)
      ? JSON.parse(readFileSync(mcpPath, "utf8"))
      : { mcpServers: {} };
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.linear = antigravityMcpServer(linear);
    writeFileSync(mcpPath, JSON.stringify(cfg, null, 2));
  }
  return workspace;
}

/**
 * The canonical, cwd-aware shared prompt path. Exposed for parity probes and
 * adapter tests; all four CLI transports consume the same file contents.
 */
export function harnessPromptPath(cwd = HOME) {
  const manifest = readManifest();
  return harnessPromptFor(manifest, cwd);
}

/**
 * Flags that load ShellTeam's Claude layer: the session-only plugin (skills +
 * hooks, via --plugin-dir), the MCP servers (via --mcp-config — Claude Code does
 * NOT surface a plugin's MCP tools to the agent, so they must ride here), and the
 * persona (via --append-system-prompt-file). --mcp-config is additive (no
 * --strict-mcp-config), so the user's own MCP servers are preserved.
 * Returns [] in pure-core mode (no modules) — the purity contract.
 */
export function claudeLayerArgs(cwd = HOME) {
  const manifest = readManifest();
  const args = [];
  if (artifactEnabled(manifest, "claude_plugin", CLAUDE_PLUGIN_DIR, "skills/hooks")) {
    args.push("--plugin-dir", CLAUDE_PLUGIN_DIR);
  }
  const mcpEnabled = artifactEnabled(manifest, "claude_mcp", CLAUDE_MCP_CONFIG, "ShellTeam MCP tools");
  const mcpPath = runtimeClaudeMcpPath(manifest, mcpEnabled, cwd);
  if (mcpPath) {
    args.push("--mcp-config", mcpPath);
  }
  const promptPath = harnessPromptFor(manifest, cwd);
  if (promptPath) {
    args.push("--append-system-prompt-file", promptPath);
  }
  return args;
}

/**
 * Codex `-c key=value` overrides that layer ShellTeam's MCP + full shared prompt
 * (+ the OpenAI provider when configured) ON TOP of the user's own config.toml.
 * Returns [] in pure-core mode. The OpenAI-API provider block is NOT part of the
 * layer gate: it only routes Codex through the user's own key (credential
 * plumbing, not behavior injection) and is required for Codex to run on API auth.
 */
export function codexLayerArgs(cwd = HOME) {
  const manifest = readManifest();
  const overrides = [];
  const dynamicLinearOverrides = dynamicCodexLinearOverrides(manifest, cwd);
  if (artifactEnabled(manifest, "codex_overrides", CODEX_OVERRIDES, "ShellTeam Codex overrides")) {
    overrides.push(
      ...JSON.parse(readFileSync(CODEX_OVERRIDES, "utf8"))
        .filter((o) => !(dynamicLinearOverrides.length && isLinearCodexOverride(o)))
        // Old builds carried an environment-only prompt in this JSON. Always
        // replace it with the full current shared harness below.
        .filter((o) => !String(o).startsWith("developer_instructions=")),
    );
  }
  overrides.push(...dynamicLinearOverrides);
  const promptPath = harnessPromptFor(manifest, cwd);
  if (promptPath) {
    overrides.push(`developer_instructions=${JSON.stringify(readFileSync(promptPath, "utf8"))}`);
  }
  // OpenAI-API provider — only when the user routes Codex through their own OpenAI
  // key (else Codex uses its ChatGPT/OAuth login, which needs no provider block).
  // Decided here, not in the built layer, since it depends on runtime key state.
  if (existsSync(OPENAI_API_KEY_FILE)) {
    overrides.push(
      'model_provider="openai-api"',
      'model_providers.openai-api.name="OpenAI API"',
      'model_providers.openai-api.base_url="https://api.openai.com/v1"',
      'model_providers.openai-api.env_key="OPENAI_API_KEY"',
    );
  }
  return overrides.flatMap((o) => ["-c", o]);
}

/**
 * Codex discovers global skills from $HOME/.agents/skills. Keep its real
 * CODEX_HOME (auth/config) but switch only cockpit sessions to ShellTeam's
 * overlay, which mirrors the owner home and supplies the canonical skills.
 */
export function codexHarnessEnv(env = {}) {
  const manifest = readManifest();
  if (!artifactEnabled(manifest, "codex_session_home", CODEX_SESSION_HOME, "ShellTeam Codex skills")) {
    return env;
  }
  return {
    ...env,
    HOME: CODEX_SESSION_HOME,
    CODEX_HOME: env.CODEX_HOME || join(HOME, ".codex"),
  };
}

/**
 * Antigravity loads the shared prompt, skills, and MCP set from a workspace
 * plugin. --add-dir makes that plugin session-scoped: user ~/.gemini and the
 * active project remain untouched.
 */
export function antigravityLayerArgs(cwd = HOME) {
  const manifest = readManifest();
  if (!artifactEnabled(
    manifest, "antigravity_plugin", ANTIGRAVITY_WORKSPACE, "ShellTeam Antigravity plugin",
  )) {
    return [];
  }
  const promptPath = harnessPromptFor(manifest, cwd);
  return ["--add-dir", runtimeAntigravityWorkspace(manifest, cwd, promptPath)];
}

/**
 * Path to ShellTeam's OpenCode config. Set as OPENCODE_CONFIG so it MERGES with
 * the user's own OpenCode config. Built in EVERY mode (core included): it
 * carries the proxied Fireworks provider without which the OpenCode agent can't
 * run — in core mode it is provider-only (no MCP/skills/instructions; see
 * docs/decisions/20260704-purity-gate-modules.md). Returns null only when the
 * layer was never built.
 *
 * With the dreaming module and knowledge for `cwd`, returns a per-node runtime
 * copy whose canonical prompt is replaced by the shared composed prompt — no
 * agent gets a different knowledge payload. Dynamic Linear credentials are
 * also rendered consistently here, as they already are for Claude and Codex.
 */
export function opencodeConfigPath(cwd = HOME) {
  if (!existsSync(OPENCODE_CONFIG)) return null;
  const manifest = readManifest();
  const promptPath = harnessPromptFor(manifest, cwd);
  const linear = linearModuleEnabled(manifest) ? linearServerForCwd(cwd) : null;
  const dynamicPrompt = promptPath && promptPath !== CLAUDE_SYSTEM_PROMPT;
  if (!dynamicPrompt && !linear) return OPENCODE_CONFIG;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(OPENCODE_CONFIG, "utf8"));
  } catch (err) {
    // getCliEnv() calls this for EVERY agent family's spawn — a torn/corrupt
    // layer file must not brick Claude/Codex startup over an OpenCode-only
    // nicety. Fall back to the static path, loudly.
    console.error(`[agent-layer] Unreadable ${OPENCODE_CONFIG} (${err.message}) — ` +
      `spawning without knowledge instructions; re-run start_computer to rebuild.`);
    return OPENCODE_CONFIG;
  }
  if (dynamicPrompt) {
    cfg.instructions = uniq([
      ...(cfg.instructions || []).filter((path) => path !== CLAUDE_SYSTEM_PROMPT),
      promptPath,
    ]);
  }
  if (linear) {
    cfg.mcp = cfg.mcp || {};
    cfg.mcp.linear = openCodeMcpServer(linear);
  }
  const slug = (projectInfoForCwd(cwd || HOME).slug || "default").toLowerCase();
  return writeRuntimeFile(`opencode-${slug}.json`, JSON.stringify(cfg, null, 2));
}

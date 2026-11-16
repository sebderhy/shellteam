import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HOME } from "./constants.mjs";

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
const CODEX_ENV = join(LAYER_DIR, "codex", "env.json");
const CODEX_SESSION_HOME = join(LAYER_DIR, "codex-home");
const ANTIGRAVITY_WORKSPACE = join(LAYER_DIR, "antigravity-workspace");
const ANTIGRAVITY_PLUGIN = join(ANTIGRAVITY_WORKSPACE, ".agents", "plugins", "shellteam");
const ANTIGRAVITY_MCP_CONFIG = join(ANTIGRAVITY_PLUGIN, "mcp_config.json");
const PI_DIR = join(LAYER_DIR, "pi");
const PI_EXTENSION = join(PI_DIR, "shellteam.ts");
const PI_LAYER = join(PI_DIR, "layer.json");
const HARNESS_SKILLS = join(LAYER_DIR, "harness", "skills");
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
  for (const path of uniq([join(root, ".env"), join(root, "code", ".env")])) {
    const key = readEnvValue(path, "LINEAR_API_KEY");
    if (key) return key;
  }
  return process.env.LINEAR_API_KEY || null;
}

// The owner's box reaches Linear through ShellTeam's relay, which adds the
// project's key itself (SHE-203: no key in a file agents are given). The same
// lookup rules live in api/services/mcp_relay.py:linear_key. An employee box
// has no relay: its project's own key goes to its own agents.
function linearServerForCwd(cwd, manifest = readManifest()) {
  const key = linearKeyForCwd(cwd);
  if (!key) return null;
  const relay = manifest?.mcp_relay;
  if (relay) {
    const { root } = projectInfoForCwd(cwd || HOME);
    const project = root === HOME ? "" : `/${root.slice(HOME.length + 1)}`;
    return { type: "http", url: `${relay.base}/linear${project}`, headers: { Authorization: relay.authorization } };
  }
  return {
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: `Bearer ${key}` },
  };
}

function runtimeClaudeMcpPath(manifest, baseEnabled, cwd) {
  if (!linearModuleEnabled(manifest)) return baseEnabled ? CLAUDE_MCP_CONFIG : null;

  const linear = linearServerForCwd(cwd, manifest);
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
  const linear = linearServerForCwd(cwd, manifest);
  if (!linear) return [];
  return [
    `mcp_servers.linear.url=${JSON.stringify(linear.url)}`,
    `mcp_servers.linear.env_http_headers={ "Authorization" = ${JSON.stringify(headerEnvName("linear", "Authorization"))} }`,
  ];
}

// MCP header values are keys. Codex reads them from its environment
// (env_http_headers), never from argv, where `ps` shows them to every local
// user for the life of the process (SHE-165). Keep the name in sync with
// _codex_header_env_name in api/services/agent_layer.py.
function headerEnvName(server, header) {
  return `SHELLTEAM_MCP_${server}_${header}_SECRET`.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The environment that goes with codexLayerArgs(cwd): the header values. */
export function codexSecretEnv(cwd = HOME) {
  const manifest = readManifest();
  const env = {};
  if (artifactEnabled(manifest, "codex_overrides", CODEX_OVERRIDES, "ShellTeam Codex overrides") && existsSync(CODEX_ENV)) {
    Object.assign(env, JSON.parse(readFileSync(CODEX_ENV, "utf8")));
  }
  if (linearModuleEnabled(manifest)) {
    const linear = linearServerForCwd(cwd, manifest);
    if (linear) env[headerEnvName("linear", "Authorization")] = linear.headers.Authorization;
  }
  return env;
}

function isLinearCodexOverride(o) {
  return typeof o === "string" && o.startsWith("mcp_servers.linear.");
}

// --- memory (dreaming module) ---------------------------------------------------------
//
// The "AI employee" mechanic: an agent spawned in a folder gets that folder's
// card (+ the owner's essentials), never a sibling's. The nightly job
// (api/services/memory/nightly.py) prints the views; this composes them at spawn.

function knowledgeModuleEnabled(manifest) {
  // dreaming = the owner box (the nightly sweep fills the tree). employee = a
  // sandbox whose HOME the host seeds with ONLY that folder's knowledge node
  // on every ensure (employees.py:_sync_project_knowledge) — composition is a
  // no-op until files exist, so enabling it here grants nothing by itself.
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  return modules.includes("dreaming") || modules.includes("employee");
}

// A view over its allowance keeps its first and last halves (SHE-134): never
// only the head. Always visible in the text: one line says what is missing
// and where it is.
function keepBothEnds(text, path, allowance) {
  if (text.length <= allowance) return text;
  const half = Math.floor(allowance / 2);
  const head = text.slice(0, text.lastIndexOf("\n", half) + 1 || half);
  const tailFrom = text.indexOf("\n", text.length - half) + 1 || text.length - half;
  const left = (text.length - head.length - (text.length - tailFrom)).toLocaleString("en-US");
  console.warn(`[agent-layer] ${path} is over its launch allowance: ${left} characters left out of the middle`);
  return `${head.trimEnd()}\n\n*(${left} characters left out here: this file is over its launch allowance. Full file: ${path})*\n\n${text.slice(tailFrom)}`;
}

// --- memory as a knowledge tree (docs/plans/active/knowledge) -------------------------
//
// The folder a chat starts in is the level of the tree the agent stands at. It
// receives that level's card, the essentials of every level above, and nothing
// else. The views are printed at night within their limits
// (api/services/memory/views.py); this only puts files together, so the same
// text reaches every agent.

// A printed view is inside its limit by construction. This is the visible
// safety net for one that is not (a hand edit, a bug): far above any limit.
const MAX_VIEW_CHARS = 24000;
const TOP_VIEWS = "_top";
const OUTSIDE = "/";      // the launch key of chats outside home, or in a hidden folder of it

function memoryRoot() {
  return process.env.SHELLTEAM_MEMORY_ROOT || join(HOME, ".shellteam", "memory");
}

/**
 * Whether cockpit chats switch off each agent's own built-in memory (K15):
 * the owner's memory setting "agents_own_memory": "off", memory module on.
 * Nothing changes without the module, or in chats started outside the cockpit.
 */
function agentsOwnMemoryOff(manifest) {
  if (!knowledgeModuleEnabled(manifest)) return false;
  const path = join(memoryRoot(), "settings.json");
  if (!existsSync(path)) return false;
  try {
    return JSON.parse(readFileSync(path, "utf8")).agents_own_memory === "off";
  } catch (err) {
    console.error(`[agent-layer] Unreadable ${path} (${err.message}); agents keep their own memory`);
    return false;
  }
}

/** Environment a cockpit agent gets on top of the box's: Claude Code's own memory off when the setting says so. */
export function ownMemoryEnv() {
  return agentsOwnMemoryOff(readManifest()) ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {};
}

/** Whether a launch carries memory. The recall exam turns it off per process with SHELLTEAM_MEMORY=off. */
function memoryOff() {
  const asked = process.env.SHELLTEAM_MEMORY;
  if (asked && asked !== "off") console.error(`[agent-layer] SHELLTEAM_MEMORY=${asked} is not "off"; ignored`);
  return asked === "off";
}

function readMemoryFile(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text ? keepBothEnds(text, path, MAX_VIEW_CHARS) : null;
}

function readView(...parts) {
  return readMemoryFile(join(memoryRoot(), "views", ...parts));
}

/** Today's notes for a level, filed by agents since the last night (K14). */
function readToday(level) {
  return readMemoryFile(join(memoryRoot(), "today", `${level}.md`));
}

/** The launch text for a chat started in `cwd`, as {knowledge, slug}, or null when there is none. */
/**
 * The launch text for a chat started in `cwd`, as {knowledge, key, slug}, or
 * null when there is none. `key` names whose text it is: "" for ~, "/" for
 * outside home (or a hidden folder of it), else the level, or the top folder
 * of a project that has no card yet. Mirrored by
 * api/services/memory/told.py:launch_key.
 */
function composeTree(cwd) {
  const c = (cwd || HOME).replace(/\/+$/, "") || "/";
  const parts = c.startsWith(`${HOME}/`) ? c.slice(HOME.length + 1).split("/").filter(Boolean) : [];
  const sections = [];
  let key = OUTSIDE;
  if (c === HOME) {
    key = "";
    sections.push(readView(TOP_VIEWS, "card.md"), readToday(TOP_VIEWS));
  } else {
    sections.push(readView(TOP_VIEWS, "essentials.md"));
    // Outside home, or a hidden folder directly under it: the owner's
    // essentials only. Inside a project, hidden or not: the project's view.
    if (parts.length && !parts[0].startsWith(".")) {
      let depth = parts.length;
      while (depth > 0 && !existsSync(join(memoryRoot(), "views", ...parts.slice(0, depth), "card.md"))) depth--;
      if (depth === 0) {
        key = parts[0];
        sections.push(`No notes yet for ~/${parts[0]}.`);
      } else {
        for (let above = 1; above < depth; above++) {
          sections.push(readView(...parts.slice(0, above), "essentials.md"));
        }
        key = parts.slice(0, depth).join("/");
        sections.push(readView(key, "card.md"), readToday(key));
      }
    }
  }
  const body = sections.filter(Boolean);
  if (!body.some((s) => !s.startsWith("No notes yet"))) return null;
  const header = readView("header.md") ||
    "Memory. Reference notes. The owner's message and the actual code win over anything written here.";
  // The footer names the memory command with its path on this box; a box
  // without it (an employee sandbox) points at the record pages instead.
  const footer = readView("footer.md") || ("To look further, open a record page listed above. " +
    "Do not edit these files: tell the owner, or the nightly job, what should change.");
  return {
    knowledge: [`# ${header}`, ...body, footer].join("\n\n"),
    key,
    slug: key === OUTSIDE ? "tree-outside" : `tree-${knowledgeSlug(key)}`,
  };
}

/**
 * K16: keep every distinct launch text a folder's chats were given, with the
 * time it was first given, so the Knowledge tab can show any chat exactly
 * what it started with. A text is stored once (told/<hash>.md); a line in
 * told/launches.jsonl marks each change of text for a key.
 */
function recordLaunchText(key, knowledge) {
  const told = join(memoryRoot(), "told");
  const sha = createHash("sha1").update(knowledge).digest("hex").slice(0, 16);
  const current = join(told, "current", `${createHash("sha1").update(key).digest("hex").slice(0, 12)}.txt`);
  if (existsSync(current) && readFileSync(current, "utf8") === sha) return;
  mkdirSync(join(told, "current"), { recursive: true });
  const text = join(told, `${sha}.md`);
  if (!existsSync(text)) writeFileSync(text, knowledge);
  appendFileSync(join(told, "launches.jsonl"), `${JSON.stringify({ at: Date.now() / 1000, key, sha })}\n`);
  writeFileSync(current, sha);
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
  if (!knowledgeModuleEnabled(manifest) || memoryOff()) return null;
  const composed = composeTree(cwd);
  if (!composed) return null;
  recordLaunchText(composed.key, composed.knowledge);
  // A process pointed at another memory (the exam) must not write over the
  // runtime file live chats read.
  const other = process.env.SHELLTEAM_MEMORY_ROOT
    ? `-${createHash("sha1").update(memoryRoot()).digest("hex").slice(0, 6)}` : "";
  return { knowledge: composed.knowledge, slug: composed.slug + other };
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
  const linear = linearModuleEnabled(manifest) ? linearServerForCwd(cwd, manifest) : null;
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

// Codex's OpenAI-API provider block (as `-c` values), shared by every Codex
// spawn and the Settings connection test so both reach the same endpoint.
// Only when Codex runs on a key (else it uses its ChatGPT login, which needs no
// provider block). Decided from the SPAWN env, the one place that already
// encodes the auth decision: getCliEnv() puts OPENAI_API_KEY there in apikey or
// gateway mode (from Settings OR the box's .env) and strips it in subscription
// mode. Gating on the key file alone left a `.env`-keyed box (every provisioned
// box, the live demo) in "apikey" mode with Codex still on its default
// provider: every turn died with 401 "Missing bearer" (2026-09-09). A company
// gateway (getCliEnv sets OPENAI_BASE_URL only then) replaces the public
// endpoint; the same key variable carries its token.
export function codexProviderOverrides(env = process.env) {
  if (!env?.OPENAI_API_KEY) return [];
  return [
    'model_provider="openai-api"',
    'model_providers.openai-api.name="OpenAI API"',
    `model_providers.openai-api.base_url=${JSON.stringify(env.OPENAI_BASE_URL || "https://api.openai.com/v1")}`,
    'model_providers.openai-api.env_key="OPENAI_API_KEY"',
  ];
}

/**
 * Codex `-c key=value` overrides that layer ShellTeam's MCP + full shared prompt
 * (+ the OpenAI provider when configured) ON TOP of the user's own config.toml.
 * Returns [] in pure-core mode. The OpenAI-API provider block is NOT part of the
 * layer gate: it only routes Codex through the user's own key (credential
 * plumbing, not behavior injection) and is required for Codex to run on API auth.
 */
export function codexLayerArgs(cwd = HOME, env = process.env) {
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
  if (agentsOwnMemoryOff(manifest)) overrides.push("features.memories=false");
  overrides.push(...codexProviderOverrides(env));
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
 * Pi's ShellTeam layer, as flags and env for one spawn (cockpit chat and the
 * managed terminal alike). Built in EVERY mode, core included: the extension
 * registers the relay provider, the credential plumbing without which Pi can't
 * reach the included models. In core mode `pi/layer.json` carries the provider
 * only (no MCP), and no prompt or skills flag is added (see
 * docs/decisions/20260704-purity-gate-modules.md).
 *
 * - `-e <extension>`: registers the `shellteam` provider and the MCP servers it
 *   reads from SHELLTEAM_PI_LAYER (a per-project runtime copy when the project
 *   has its own Linear server).
 * - `--append-system-prompt <file>`: the same shared prompt every agent gets,
 *   composed with the folder's knowledge when the dreaming module has some.
 * - `--skill <dir>`: the canonical harness skills.
 *
 * Additive: the user's own ~/.pi settings, AGENTS.md and MCP servers still
 * apply; nothing is written there. Returns { args: [], env: {} } when the layer
 * was never built (Pi then has no way to reach the relay: loud).
 */
export function piLayer(cwd = HOME) {
  const manifest = readManifest();
  if (!artifactEnabled(manifest, "pi_layer", PI_EXTENSION, "ShellTeam Pi layer")) {
    console.error(`[agent-layer] No Pi layer at ${PI_DIR}: Pi can't reach the included ` +
      `models. Trigger start_computer or re-run install.sh to rebuild the layer.`);
    return { args: [], env: {} };
  }
  const args = ["-e", PI_EXTENSION];
  const env = {
    SHELLTEAM_PI_LAYER: piLayerJsonFor(manifest, cwd),
    // No update check or install telemetry from cockpit spawns: ShellTeam
    // updates Pi itself (scripts/self-update.sh).
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const promptPath = harnessPromptFor(manifest, cwd);
  if (promptPath) args.push("--append-system-prompt", promptPath);
  if (artifactEnabled(manifest, "harness_skills", HARNESS_SKILLS, "ShellTeam skills")) {
    args.push("--skill", HARNESS_SKILLS);
  }
  return { args, env };
}

// The layer JSON this spawn's extension reads: the built one, or a 0600
// per-project copy that adds the project's own Linear server.
function piLayerJsonFor(manifest, cwd) {
  const linear = linearModuleEnabled(manifest) ? linearServerForCwd(cwd, manifest) : null;
  if (!linear) return PI_LAYER;
  let layer;
  try {
    layer = JSON.parse(readFileSync(PI_LAYER, "utf8"));
  } catch (err) {
    // A torn layer file must not crash the spawn: Pi's own extension then
    // reports it to the chat. Loud here too.
    console.error(`[agent-layer] Unreadable ${PI_LAYER} (${err.message}): Pi starts ` +
      `without this project's Linear server; re-run start_computer to rebuild.`);
    return PI_LAYER;
  }
  layer.mcpServers = { ...(layer.mcpServers || {}), linear };
  const slug = (projectInfoForCwd(cwd || HOME).slug || "default").toLowerCase();
  const path = join(RUNTIME_DIR, `pi-${slug}.json`);
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(layer, null, 2), { mode: 0o600 });
  return path;
}

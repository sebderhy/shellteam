// The Node half of the additive launch-layer: the flags the cockpit and the
// managed terminal actually pass to each CLI. This seam carries the
// zero-footprint guarantee (agents get ShellTeam's layer ONLY via flags, never
// dotfile writes) — a regression here silently drops skills/MCP/persona or,
// worse, tempts a dotfile-write workaround.
//
// HOME is read once by lib/constants.mjs at import, so the temp HOME must be
// set before the module is first imported (dynamic import below).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "shellteam-layer-test-"));
process.env.HOME = FAKE_HOME;

const LAYER = join(FAKE_HOME, ".shellteam", "agent-layer");

let agentLaunchEnv, antigravityLayerArgs, claudeLayerArgs, codexHarnessEnv, codexLayerArgs, harnessPromptPath, opencodeConfigPath, terminalSpawn;

before(async () => {
  ({
    antigravityLayerArgs,
    claudeLayerArgs,
    codexHarnessEnv,
    codexLayerArgs,
    harnessPromptPath,
    opencodeConfigPath,
  } = await import("../lib/agent-layer.mjs"));
  ({ agentLaunchEnv, terminalSpawn } = await import("../lib/agents/registry.mjs"));
});

after(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

test("missing layer: claude gets NO layer flags (bare agent, loud warning only)", () => {
  assert.deepEqual(claudeLayerArgs(), []);
});

test("missing layer: codex gets NO -c overrides", () => {
  assert.deepEqual(codexLayerArgs(), []);
});

test("missing layer: opencode gets no OPENCODE_CONFIG override", () => {
  assert.equal(opencodeConfigPath(), null);
});

test("missing layer: Antigravity gets no session plugin and Codex keeps its original HOME", () => {
  assert.deepEqual(antigravityLayerArgs(), []);
  const env = { HOME: "/original", CODEX_HOME: "/custom-codex" };
  assert.deepEqual(codexHarnessEnv(env), env);
});

test("built layer: claude flags reference only ~/.shellteam paths", () => {
  mkdirSync(join(LAYER, "claude"), { recursive: true });
  writeFileSync(join(LAYER, "claude-mcp.json"), "{}");
  writeFileSync(join(LAYER, "system-prompt.md"), "# persona");

  const args = claudeLayerArgs();
  assert.deepEqual(args, [
    "--plugin-dir", join(LAYER, "claude"),
    "--mcp-config", join(LAYER, "claude-mcp.json"),
    "--append-system-prompt-file", join(LAYER, "system-prompt.md"),
  ]);
  // The guarantee: everything the layer loads lives under ~/.shellteam —
  // never ~/.claude or any other user dotfile.
  for (const a of args.filter((x) => x.startsWith("/"))) {
    assert.ok(a.startsWith(join(FAKE_HOME, ".shellteam")), `${a} escapes ~/.shellteam`);
  }
});

test("built layer: codex overrides splice as additive -c pairs", () => {
  mkdirSync(join(LAYER, "codex"), { recursive: true });
  writeFileSync(join(LAYER, "codex", "overrides.json"), JSON.stringify([
    'mcp_servers.browser.command="npx"',
    'model_reasoning_effort="high"',
  ]));

  const args = codexLayerArgs();
  assert.deepEqual(args.slice(0, 4), [
    "-c", 'mcp_servers.browser.command="npx"',
    "-c", 'model_reasoning_effort="high"',
  ]);
  const prompt = args.find((value) => String(value).startsWith("developer_instructions="));
  assert.equal(JSON.parse(prompt.split("=", 2)[1]), "# persona");
});

test("codex overrides add the OpenAI provider only when the user's key file exists", () => {
  const args = codexLayerArgs();
  assert.ok(!args.some((a) => a.includes("openai-api")), "no provider without a key file");

  mkdirSync(join(FAKE_HOME, ".config", "shellteam"), { recursive: true });
  writeFileSync(join(FAKE_HOME, ".config", "shellteam", "openai-api-key"), "sk-test");
  const withKey = codexLayerArgs();
  assert.ok(withKey.includes('model_provider="openai-api"'));
  rmSync(join(FAKE_HOME, ".config", "shellteam", "openai-api-key"));
});

test("built layer: opencode config path is returned once the file exists", () => {
  writeFileSync(join(LAYER, "opencode.json"), "{}");
  assert.equal(opencodeConfigPath(), join(LAYER, "opencode.json"));
});

// --- Purity-gate manifest (layer.json) ---
// With a manifest present, IT decides what loads — artifact files alone no
// longer do. The tests above (no manifest) covered the legacy path.

test("core manifest: nothing loads even though artifact files exist on disk", () => {
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: [],
    artifacts: {
      claude_plugin: false, claude_mcp: false, claude_system_prompt: false,
      codex_overrides: false, codex_session_home: false, harness_skills: false,
      antigravity_plugin: false, opencode_config: true,
    },
  }));
  assert.deepEqual(claudeLayerArgs(), []);
  assert.deepEqual(codexLayerArgs(), []);
  // OpenCode keeps its provider-only config (credential plumbing, documented).
  assert.equal(opencodeConfigPath(), join(LAYER, "opencode.json"));
});

test("full manifest: everything loads again", () => {
  mkdirSync(join(LAYER, "codex-home"), { recursive: true });
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam"), { recursive: true });
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: ["persona", "browser"],
    artifacts: {
      claude_plugin: true, claude_mcp: true, claude_system_prompt: true,
      codex_overrides: true, codex_session_home: true, harness_skills: true,
      antigravity_plugin: true, opencode_config: true,
    },
  }));
  assert.deepEqual(claudeLayerArgs(), [
    "--plugin-dir", join(LAYER, "claude"),
    "--mcp-config", join(LAYER, "claude-mcp.json"),
    "--append-system-prompt-file", join(LAYER, "system-prompt.md"),
  ]);
  assert.ok(codexLayerArgs().length > 0);
  assert.deepEqual(antigravityLayerArgs(), ["--add-dir", join(LAYER, "antigravity-workspace")]);
  assert.deepEqual(codexHarnessEnv({ HOME: "/original" }), {
    HOME: join(LAYER, "codex-home"),
    CODEX_HOME: join(FAKE_HOME, ".codex"),
  });
  // The managed terminal uses this registry adapter too, so it must receive
  // the exact Codex skills overlay and Antigravity workspace plugin—not only
  // the per-turn chat adapters.
  assert.deepEqual(agentLaunchEnv("gpt-5.6-sol", { HOME: "/original" }), {
    HOME: join(LAYER, "codex-home"),
    CODEX_HOME: join(FAKE_HOME, ".codex"),
  });
  assert.ok(terminalSpawn("gemini-3.1-pro").args.includes(join(LAYER, "antigravity-workspace")));
});

test("linear MCP follows the active project cwd", () => {
  mkdirSync(join(LAYER, "codex"), { recursive: true });
  writeFileSync(join(LAYER, "claude-mcp.json"), JSON.stringify({
    mcpServers: {
      context7: { command: "context7-mcp" },
      linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_api_global" },
      },
    },
  }));
  writeFileSync(join(LAYER, "codex", "overrides.json"), JSON.stringify([
    'mcp_servers.context7.command="context7-mcp"',
    'mcp_servers.linear.url="https://mcp.linear.app/mcp"',
    'mcp_servers.linear.http_headers={ "Authorization" = "Bearer lin_api_global" }',
  ]));
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam"), { recursive: true });
  writeFileSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam", "mcp_config.json"), JSON.stringify({
    mcpServers: {
      linear: { serverUrl: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_global" } },
    },
  }));
  writeFileSync(join(LAYER, "opencode.json"), JSON.stringify({ mcp: {} }));
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: ["linear"],
    artifacts: {
      claude_plugin: false,
      claude_mcp: true,
      claude_system_prompt: false,
      codex_overrides: true,
      codex_session_home: false,
      harness_skills: false,
      antigravity_plugin: true,
      opencode_config: true,
    },
  }));
  mkdirSync(join(FAKE_HOME, "acmeproj", "code"), { recursive: true });
  writeFileSync(join(FAKE_HOME, "acmeproj", "code", ".env"), "LINEAR_API_KEY=lin_api_acmeproj\n");

  const claudeArgs = claudeLayerArgs(join(FAKE_HOME, "acmeproj"));
  const mcpPath = claudeArgs[claudeArgs.indexOf("--mcp-config") + 1];
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  assert.equal(mcp.mcpServers.linear.headers.Authorization, "Bearer lin_api_acmeproj");
  assert.equal(mcp.mcpServers.context7.command, "context7-mcp");

  const codexArgs = codexLayerArgs(join(FAKE_HOME, "acmeproj"));
  assert.ok(codexArgs.includes('mcp_servers.linear.http_headers={ "Authorization" = "Bearer lin_api_acmeproj" }'));
  assert.ok(!codexArgs.some((a) => a.includes("lin_api_global")));

  const ocPath = opencodeConfigPath(join(FAKE_HOME, "acmeproj"));
  const oc = JSON.parse(readFileSync(ocPath, "utf8"));
  assert.equal(oc.mcp.linear.headers.Authorization, "Bearer lin_api_acmeproj");

  const agArgs = antigravityLayerArgs(join(FAKE_HOME, "acmeproj"));
  const agMcp = JSON.parse(readFileSync(
    join(agArgs[1], ".agents", "plugins", "shellteam", "mcp_config.json"), "utf8",
  ));
  assert.equal(agMcp.mcpServers.linear.headers.Authorization, "Bearer lin_api_acmeproj");
});

test("codex keeps baked linear overrides when no runtime key is available", () => {
  const saved = {
    LINEAR_API_KEY: process.env.LINEAR_API_KEY,
    QUIET_REPO_LINEAR_API_KEY: process.env.QUIET_REPO_LINEAR_API_KEY,
    LINEAR_API_KEY_QUIET_REPO: process.env.LINEAR_API_KEY_QUIET_REPO,
  };
  delete process.env.LINEAR_API_KEY;
  delete process.env.QUIET_REPO_LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY_QUIET_REPO;

  try {
    const codexArgs = codexLayerArgs(join(FAKE_HOME, "quiet-repo"));
    assert.ok(codexArgs.includes(
      'mcp_servers.linear.http_headers={ "Authorization" = "Bearer lin_api_global" }',
    ));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("manifest/disk mismatch: promised-but-missing artifact is skipped loudly, not crashed on", () => {
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: ["persona"],
    artifacts: {
      claude_plugin: true, claude_mcp: false, claude_system_prompt: true,
      codex_overrides: false, codex_session_home: false, harness_skills: false,
      antigravity_plugin: false, opencode_config: true,
    },
  }));
  rmSync(join(LAYER, "system-prompt.md"));
  const args = claudeLayerArgs();
  assert.deepEqual(args, ["--plugin-dir", join(LAYER, "claude")]);
});

// --- knowledge composition (dreaming module) -----------------------------------------

const KNOWLEDGE = join(FAKE_HOME, ".shellteam", "knowledge");

function writeManifest(modules, artifacts = {}) {
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules,
    artifacts: {
      claude_plugin: false, claude_mcp: false, claude_system_prompt: false,
      codex_overrides: false, codex_session_home: false, harness_skills: false,
      antigravity_plugin: false, opencode_config: true, ...artifacts,
    },
  }));
}

function seedKnowledge() {
  mkdirSync(join(KNOWLEDGE, "tree", "acmeproj"), { recursive: true });
  mkdirSync(join(KNOWLEDGE, "tree", "otherproj"), { recursive: true });
  writeFileSync(join(KNOWLEDGE, "identity.md"), "# identity\n- The owner is Seb.\n");
  writeFileSync(join(KNOWLEDGE, "projects.md"), "# projects\n- acmeproj: client project\n");
  writeFileSync(join(KNOWLEDGE, "tree", "acmeproj", "index.md"),
    "# acmeproj\n- Deploys via deploy-all.sh\n");
  writeFileSync(join(KNOWLEDGE, "tree", "otherproj", "index.md"),
    "# otherproj\n- SIBLING-SECRET fact\n");
}

test("dreaming ON: claude spawn in a project folder composes persona + that node's knowledge", () => {
  writeFileSync(join(LAYER, "system-prompt.md"), "PERSONA-CONTENT");
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  seedKnowledge();

  const args = claudeLayerArgs(join(FAKE_HOME, "acmeproj"));
  const i = args.indexOf("--append-system-prompt-file");
  assert.notEqual(i, -1);
  const path = args[i + 1];
  assert.match(path, /runtime\/harness-prompt-acmeproj-[0-9a-f]{6}\.md$/);
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("PERSONA-CONTENT"), "persona kept");
  assert.ok(content.includes("The owner is Seb"), "user layer injected");
  assert.ok(content.includes("Deploys via deploy-all.sh"), "own node injected");
  assert.ok(!content.includes("SIBLING-SECRET"), "sibling node NOT injected");
  assert.ok(!content.includes("acmeproj: client project"),
    "cross-project map only at root scope");
});

test("dreaming ON: Claude, Codex, Antigravity, and OpenCode receive the same composed prompt", () => {
  const cwd = join(FAKE_HOME, "acmeproj");
  writeFileSync(join(LAYER, "system-prompt.md"), "PERSONA-CONTENT");
  mkdirSync(join(LAYER, "codex"), { recursive: true });
  writeFileSync(join(LAYER, "codex", "overrides.json"), "[]");
  mkdirSync(join(LAYER, "codex-home"), { recursive: true });
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam", "rules"), { recursive: true });
  writeFileSync(
    join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam", "rules", "shellteam.md"),
    "PERSONA-CONTENT",
  );
  writeFileSync(join(LAYER, "opencode.json"), JSON.stringify({
    instructions: [join(LAYER, "system-prompt.md")],
  }));
  writeManifest(["persona", "dreaming"], {
    claude_system_prompt: true,
    codex_overrides: true,
    codex_session_home: true,
    harness_skills: true,
    antigravity_plugin: true,
  });

  const sharedPath = harnessPromptPath(cwd);
  const shared = readFileSync(sharedPath, "utf8");
  const claudeArgs = claudeLayerArgs(cwd);
  assert.equal(claudeArgs[claudeArgs.indexOf("--append-system-prompt-file") + 1], sharedPath);

  const codexDeveloper = codexLayerArgs(cwd).find((value) => String(value).startsWith("developer_instructions="));
  assert.equal(JSON.parse(codexDeveloper.slice("developer_instructions=".length)), shared);

  const oc = JSON.parse(readFileSync(opencodeConfigPath(cwd), "utf8"));
  assert.ok(oc.instructions.includes(sharedPath));

  const agArgs = antigravityLayerArgs(cwd);
  const agRule = readFileSync(join(
    agArgs[1], ".agents", "plugins", "shellteam", "rules", "shellteam.md",
  ), "utf8");
  assert.equal(agRule, shared);
});

test("dreaming ON: root-scope spawn (~) gets the cross-project map, not node internals", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  const args = claudeLayerArgs(FAKE_HOME);
  const path = args[args.indexOf("--append-system-prompt-file") + 1];
  assert.match(path, /runtime\/harness-prompt-root\.md$/);
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("acmeproj: client project"), "projects.md at root");
  assert.ok(!content.includes("SIBLING-SECRET"), "no node internals at root");
});

test("dreaming ON: dot-dir cwd is an excluded scope — persona file only", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  const args = claudeLayerArgs(join(FAKE_HOME, ".shellteam", "dream", "runs"));
  assert.deepEqual(args, ["--append-system-prompt-file", join(LAYER, "system-prompt.md")]);
});

test("dreaming OFF: the system-prompt flag is byte-identical to the static persona path", () => {
  writeManifest(["persona"], { claude_system_prompt: true });
  const args = claudeLayerArgs(join(FAKE_HOME, "acmeproj"));
  assert.deepEqual(args, ["--append-system-prompt-file", join(LAYER, "system-prompt.md")]);
});

test("employee module: the synced knowledge node composes without 'dreaming' in the manifest", () => {
  // An employee sandbox: manifest carries employee+linear, and the host synced
  // ONLY tree/<folder>/ into this HOME (no user layer, no siblings) — the
  // teammate's agents must still receive their project's knowledge.
  writeFileSync(join(LAYER, "system-prompt.md"), "EMPLOYEE-HARNESS");
  writeManifest(["employee", "linear"], { claude_system_prompt: true });
  mkdirSync(join(KNOWLEDGE, "tree", "acmeproj"), { recursive: true });
  writeFileSync(join(KNOWLEDGE, "tree", "acmeproj", "index.md"),
    "# acmeproj\n- Deploys via deploy-all.sh\n");

  const args = claudeLayerArgs(join(FAKE_HOME, "acmeproj"));
  const path = args[args.indexOf("--append-system-prompt-file") + 1];
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("EMPLOYEE-HARNESS"), "harness kept");
  assert.ok(content.includes("Deploys via deploy-all.sh"), "project node injected");
});

test("dreaming ON without persona: knowledge still reaches the agent alone", () => {
  writeManifest(["dreaming"]);
  const args = claudeLayerArgs(join(FAKE_HOME, "acmeproj"));
  const path = args[args.indexOf("--append-system-prompt-file") + 1];
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("Deploys via deploy-all.sh"));
  assert.ok(!content.includes("PERSONA-CONTENT"));
});

test("dreaming ON without persona: all four agents receive the same knowledge-only prompt", () => {
  const cwd = join(FAKE_HOME, "acmeproj");
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam"), { recursive: true });
  writeFileSync(join(LAYER, "opencode.json"), JSON.stringify({ provider: { fireworks: {} } }));
  writeManifest(["dreaming"], { antigravity_plugin: true });

  const sharedPath = harnessPromptPath(cwd);
  const shared = readFileSync(sharedPath, "utf8");
  assert.ok(shared.includes("Deploys via deploy-all.sh"));
  assert.ok(!shared.includes("PERSONA-CONTENT"));

  const claudeArgs = claudeLayerArgs(cwd);
  assert.equal(claudeArgs[claudeArgs.indexOf("--append-system-prompt-file") + 1], sharedPath);

  const codexDeveloper = codexLayerArgs(cwd).find((value) => String(value).startsWith("developer_instructions="));
  assert.equal(JSON.parse(codexDeveloper.slice("developer_instructions=".length)), shared);

  const oc = JSON.parse(readFileSync(opencodeConfigPath(cwd), "utf8"));
  assert.deepEqual(oc.instructions, [sharedPath]);

  const agArgs = antigravityLayerArgs(cwd);
  const agRule = readFileSync(join(
    agArgs[1], ".agents", "plugins", "shellteam", "rules", "shellteam.md",
  ), "utf8");
  assert.equal(agRule, shared);
});

test("pure core: dreaming absent → no knowledge, no flags beyond core", () => {
  writeManifest([]);
  assert.deepEqual(claudeLayerArgs(join(FAKE_HOME, "acmeproj")), []);
});

test("opencode: dreaming ON adds the composed knowledge file to instructions", () => {
  writeFileSync(join(LAYER, "opencode.json"),
    JSON.stringify({ instructions: ["~/.claude/CLAUDE.md"] }));
  writeManifest(["dreaming"]);
  const path = opencodeConfigPath(join(FAKE_HOME, "acmeproj"));
  assert.match(path, /runtime\/opencode-acmeproj\.json$/);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(cfg.instructions.length, 2);
  assert.match(cfg.instructions[1], /runtime\/harness-prompt-acmeproj-[0-9a-f]{6}\.md$/);
  assert.ok(readFileSync(cfg.instructions[1], "utf8").includes("Deploys via deploy-all.sh"));
});

test("opencode: dreaming OFF returns exactly the static config path", () => {
  writeManifest([]);
  assert.equal(opencodeConfigPath(join(FAKE_HOME, "acmeproj")), join(LAYER, "opencode.json"));
});

test("dreaming ON: trailing-slash cwds resolve like their normalized form (no crash)", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  // HOME with a trailing slash is the root scope, not a crash.
  const rootArgs = claudeLayerArgs(FAKE_HOME + "/");
  const rootPath = rootArgs[rootArgs.indexOf("--append-system-prompt-file") + 1];
  assert.match(rootPath, /runtime\/harness-prompt-root\.md$/);
  // A project cwd with a trailing slash routes to the same node file.
  const a = claudeLayerArgs(join(FAKE_HOME, "acmeproj"));
  const b = claudeLayerArgs(join(FAKE_HOME, "acmeproj") + "/");
  assert.deepEqual(a, b);
});

test("dreaming ON: nodes whose names collide after slugging get distinct runtime files", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  mkdirSync(join(KNOWLEDGE, "tree", "My-App"), { recursive: true });
  mkdirSync(join(KNOWLEDGE, "tree", "my-app"), { recursive: true });
  writeFileSync(join(KNOWLEDGE, "tree", "My-App", "index.md"), "# My-App\n- UPPER fact\n");
  writeFileSync(join(KNOWLEDGE, "tree", "my-app", "index.md"), "# my-app\n- lower fact\n");
  const upper = claudeLayerArgs(join(FAKE_HOME, "My-App"));
  const lower = claudeLayerArgs(join(FAKE_HOME, "my-app"));
  const upperPath = upper[upper.indexOf("--append-system-prompt-file") + 1];
  const lowerPath = lower[lower.indexOf("--append-system-prompt-file") + 1];
  assert.notEqual(upperPath, lowerPath);
  assert.ok(readFileSync(upperPath, "utf8").includes("UPPER fact"));
  assert.ok(!readFileSync(upperPath, "utf8").includes("lower fact"));
});

test("opencode: corrupt static opencode.json degrades loudly to the static path, not a spawn crash", () => {
  writeFileSync(join(LAYER, "opencode.json"), "{ this is not json");
  writeManifest(["dreaming"]);
  assert.equal(opencodeConfigPath(join(FAKE_HOME, "acmeproj")), join(LAYER, "opencode.json"));
});

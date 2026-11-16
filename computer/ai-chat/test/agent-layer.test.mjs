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
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "shellteam-layer-test-"));
process.env.HOME = FAKE_HOME;

const LAYER = join(FAKE_HOME, ".shellteam", "agent-layer");

let agentLaunchEnv, antigravityLayerArgs, claudeLayerArgs, codexHarnessEnv, codexLayerArgs, codexSecretEnv, harnessPromptPath, piLayer, ownMemoryEnv, terminalSpawn;

before(async () => {
  ({
    antigravityLayerArgs,
    claudeLayerArgs,
    codexHarnessEnv,
    codexLayerArgs,
    codexSecretEnv,
    harnessPromptPath,
    piLayer,
    ownMemoryEnv,
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

test("missing layer: Pi gets no layer flags", () => {
  assert.deepEqual(piLayer(), { args: [], env: {} });
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

test("codex overrides add the OpenAI provider exactly when the spawn env carries a key", () => {
  // The spawn env is the auth decision (getCliEnv): key present = apikey mode.
  assert.ok(!codexLayerArgs(FAKE_HOME, {}).some((a) => a.includes("openai-api")), "no provider without a key");
  assert.ok(codexLayerArgs(FAKE_HOME, { OPENAI_API_KEY: "sk-test" }).includes('model_provider="openai-api"'));

  // A key that lives only in the box's .env (every provisioned box) must route
  // Codex through the API provider too — the key FILE is not the criterion.
  // And a key file with the var stripped (subscription mode) must NOT force the
  // provider, or Codex would start with an env_key that is not set.
  mkdirSync(join(FAKE_HOME, ".config", "shellteam"), { recursive: true });
  writeFileSync(join(FAKE_HOME, ".config", "shellteam", "openai-api-key"), "sk-test");
  assert.ok(!codexLayerArgs(FAKE_HOME, {}).some((a) => a.includes("openai-api")), "key file alone is not the criterion");
  rmSync(join(FAKE_HOME, ".config", "shellteam", "openai-api-key"));
});

test("built layer: Pi loads ShellTeam's extension once it exists", () => {
  mkdirSync(join(LAYER, "pi"), { recursive: true });
  writeFileSync(join(LAYER, "pi", "shellteam.ts"), "// extension");
  writeFileSync(join(LAYER, "pi", "layer.json"), JSON.stringify({ provider: {}, mcpServers: {} }));
  assert.deepEqual(piLayer().args.slice(0, 2), ["-e", join(LAYER, "pi", "shellteam.ts")]);
  assert.equal(piLayer().env.SHELLTEAM_PI_LAYER, join(LAYER, "pi", "layer.json"));
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
      antigravity_plugin: false, pi_layer: true,
    },
  }));
  assert.deepEqual(claudeLayerArgs(), []);
  assert.deepEqual(codexLayerArgs(), []);
  // Pi keeps its provider-only layer (credential plumbing, documented): the
  // extension and nothing else, no prompt, no skills.
  assert.deepEqual(piLayer().args, ["-e", join(LAYER, "pi", "shellteam.ts")]);
  assert.equal(piLayer().env.SHELLTEAM_PI_LAYER, join(LAYER, "pi", "layer.json"));
});

test("full manifest: everything loads again", () => {
  mkdirSync(join(LAYER, "codex-home"), { recursive: true });
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam"), { recursive: true });
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: ["persona", "browser"],
    artifacts: {
      claude_plugin: true, claude_mcp: true, claude_system_prompt: true,
      codex_overrides: true, codex_session_home: true, harness_skills: true,
      antigravity_plugin: true, pi_layer: true,
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
  assert.ok(terminalSpawn("gemini-4-argon-high").args.includes(join(LAYER, "antigravity-workspace")));
});

const RELAY = { base: "http://127.0.0.1:8001/internal/mcp", authorization: "Bearer relay-capability" };

function linearLayer(manifestExtra) {
  mkdirSync(join(LAYER, "codex"), { recursive: true });
  writeFileSync(join(LAYER, "claude-mcp.json"), JSON.stringify({
    mcpServers: {
      context7: { command: "context7-mcp" },
      linear: { type: "http", url: `${RELAY.base}/linear`, headers: { Authorization: RELAY.authorization } },
    },
  }));
  writeFileSync(join(LAYER, "codex", "overrides.json"), JSON.stringify([
    'mcp_servers.context7.command="context7-mcp"',
    `mcp_servers.linear.url="${RELAY.base}/linear"`,
    'mcp_servers.linear.env_http_headers={ "Authorization" = "SHELLTEAM_MCP_LINEAR_AUTHORIZATION_SECRET" }',
  ]));
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam"), { recursive: true });
  writeFileSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam", "mcp_config.json"),
    JSON.stringify({ mcpServers: {} }));
  mkdirSync(join(LAYER, "pi"), { recursive: true });
  writeFileSync(join(LAYER, "pi", "layer.json"), JSON.stringify({ provider: {}, mcpServers: {} }));
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules: ["linear"],
    artifacts: {
      claude_plugin: false, claude_mcp: true, claude_system_prompt: false, codex_overrides: true,
      codex_session_home: false, harness_skills: false, antigravity_plugin: true, pi_layer: true,
    },
    ...manifestExtra,
  }));
  mkdirSync(join(FAKE_HOME, "acmeproj", "code"), { recursive: true });
  writeFileSync(join(FAKE_HOME, "acmeproj", "code", ".env"), "LINEAR_API_KEY=lin_api_acmeproj\n");
}

function linearServersFor(cwd) {
  const claudeArgs = claudeLayerArgs(cwd);
  const claude = JSON.parse(readFileSync(claudeArgs[claudeArgs.indexOf("--mcp-config") + 1], "utf8"));
  const piJson = piLayer(cwd).env.SHELLTEAM_PI_LAYER;
  const pi = JSON.parse(readFileSync(piJson, "utf8"));
  const agArgs = antigravityLayerArgs(cwd);
  const ag = JSON.parse(readFileSync(join(agArgs[1], ".agents", "plugins", "shellteam", "mcp_config.json"), "utf8"));
  const written = [claudeArgs[claudeArgs.indexOf("--mcp-config") + 1], piJson,
    join(agArgs[1], ".agents", "plugins", "shellteam", "mcp_config.json")].map((p) => readFileSync(p, "utf8"));
  return { claude: claude.mcpServers.linear, pi: pi.mcpServers.linear, ag: ag.mcpServers.linear,
    codexArgs: codexLayerArgs(cwd), codexEnv: codexSecretEnv(cwd), written, context7: claude.mcpServers.context7 };
}

test("linear MCP follows the active project, through the relay: no key in any file (SHE-203)", () => {
  linearLayer({ mcp_relay: RELAY });
  const s = linearServersFor(join(FAKE_HOME, "acmeproj", "web"));
  const url = `${RELAY.base}/linear/acmeproj`;
  assert.equal(s.claude.url, url);
  assert.equal(s.claude.headers.Authorization, RELAY.authorization);
  assert.equal(s.context7.command, "context7-mcp");
  assert.equal(s.pi.url, url);
  assert.equal(s.ag.serverUrl, url);
  assert.ok(s.codexArgs.includes(`mcp_servers.linear.url=${JSON.stringify(url)}`));
  // The relay token travels in Codex's environment, never in argv (SHE-165).
  assert.ok(s.codexArgs.includes('mcp_servers.linear.env_http_headers={ "Authorization" = "SHELLTEAM_MCP_LINEAR_AUTHORIZATION_SECRET" }'));
  assert.equal(s.codexEnv.SHELLTEAM_MCP_LINEAR_AUTHORIZATION_SECRET, RELAY.authorization);
  for (const text of [...s.written, JSON.stringify(s.codexArgs), JSON.stringify(s.codexEnv)]) {
    assert.ok(!text.includes("lin_api_"), "no Linear key leaves the project's .env");
  }
});

test("an employee box has no relay: its project's own key goes to its own agents", () => {
  linearLayer({});
  const s = linearServersFor(join(FAKE_HOME, "acmeproj"));
  assert.equal(s.claude.url, "https://mcp.linear.app/mcp");
  assert.equal(s.claude.headers.Authorization, "Bearer lin_api_acmeproj");
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
    assert.ok(codexArgs.includes(`mcp_servers.linear.url="${RELAY.base}/linear"`), "the layer's own server stays");
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
      antigravity_plugin: false, pi_layer: true,
    },
  }));
  rmSync(join(LAYER, "system-prompt.md"));
  const args = claudeLayerArgs();
  assert.deepEqual(args, ["--plugin-dir", join(LAYER, "claude")]);
});

// --- memory: the knowledge tree (dreaming module; K3, K4, K12, K20) ------------------

const MEMORY = join(FAKE_HOME, ".shellteam", "memory");

function writeManifest(modules, artifacts = {}) {
  writeFileSync(join(LAYER, "layer.json"), JSON.stringify({
    modules,
    artifacts: {
      claude_plugin: false, claude_mcp: false, claude_system_prompt: false,
      codex_overrides: false, codex_session_home: false, harness_skills: false,
      antigravity_plugin: false, pi_layer: true, ...artifacts,
    },
  }));
}

function view(rel, text) {
  mkdirSync(join(MEMORY, "views", rel, ".."), { recursive: true });
  writeFileSync(join(MEMORY, "views", rel), text);
}

function seedTree() {
  rmSync(MEMORY, { recursive: true, force: true });
  view("header.md", "Memory. Reference notes compiled on 14 Nov 2026. The owner's message and the actual code win over anything written here.\n");
  view("_top/card.md", "THE OWNER  100 of 10,000\n- TOP-CARD career fact\n- ~/acmeproj  client project\n");
  view("_top/essentials.md", "ABOUT THE OWNER (essentials)  50 of 3,000\n- TOP-ESSENTIAL plain words\n");
  view("acmeproj/card.md", "PROJECT: acmeproj   ~/acmeproj  80 of 8,000\n- ACME-CARD deploys via deploy-all.sh\n");
  view("acmeproj/essentials.md", "ABOUT ~/acmeproj (essentials)\n- ACME-ESSENTIAL rule\n");
  view("acmeproj/web/card.md", "PROJECT: web   ~/acmeproj/web\n- WEB-CARD fact\n");
  view("otherproj/card.md", "PROJECT: otherproj   ~/otherproj\n- OTHER-CARD secret\n");
}

function launchText(cwd) {
  const path = harnessPromptPath(cwd);
  return path ? readFileSync(path, "utf8") : null;
}

function promptFileOf(args) {
  return args[args.indexOf("--append-system-prompt-file") + 1];
}

test("dreaming ON: claude spawn in a project folder composes persona + that level's card", () => {
  writeFileSync(join(LAYER, "system-prompt.md"), "PERSONA-CONTENT");
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  seedTree();
  const path = promptFileOf(claudeLayerArgs(join(FAKE_HOME, "acmeproj")));
  assert.match(path, /runtime\/harness-prompt-tree-acmeproj-[0-9a-f]{6}\.md$/);
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("PERSONA-CONTENT"), "persona kept");
  assert.ok(content.includes("TOP-ESSENTIAL"), "the owner's essentials");
  assert.ok(content.includes("ACME-CARD"), "own card");
  assert.ok(!content.includes("OTHER-CARD"), "another project's card NOT injected");
  assert.ok(!content.includes("TOP-CARD"), "the owner's card only at home");
});

test("dreaming ON: a chat in ~ gets the owner's card", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  seedTree();
  const path = promptFileOf(claudeLayerArgs(FAKE_HOME));
  assert.match(path, /runtime\/harness-prompt-tree-root\.md$/);
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("TOP-CARD"));
  assert.ok(!content.includes("ACME-CARD") && !content.includes("OTHER-CARD"));
});

test("dreaming ON: no memory printed yet means the static persona file", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  rmSync(MEMORY, { recursive: true, force: true });
  assert.deepEqual(claudeLayerArgs(join(FAKE_HOME, "acmeproj")),
    ["--append-system-prompt-file", join(LAYER, "system-prompt.md")]);
});

test("dreaming OFF: the system-prompt flag is byte-identical to the static persona path", () => {
  writeManifest(["persona"], { claude_system_prompt: true });
  seedTree();
  const args = claudeLayerArgs(join(FAKE_HOME, "acmeproj"));
  assert.deepEqual(args, ["--append-system-prompt-file", join(LAYER, "system-prompt.md")]);
});

test("SHE-134: an oversized view keeps both ends, so its last line still reaches the agent", () => {
  writeManifest(["dreaming"]);
  seedTree();
  const filler = Array.from({ length: 600 }, (_, i) => `- old fact number ${i} padded to a realistic line length`).join("\n");
  view("acmeproj/card.md", `PROJECT: acmeproj\n- FIRST-FACT\n${filler}\n- NEWEST-FACT learned last night\n`);

  const text = readFileSync(harnessPromptPath(join(FAKE_HOME, "acmeproj")), "utf8");
  assert.ok(text.includes("FIRST-FACT"), "the start of the view is kept");
  assert.ok(text.includes("NEWEST-FACT learned last night"), "the end of the view is kept");
  const full = join(MEMORY, "views", "acmeproj", "card.md");
  const note = text.split("\n").find((l) => l.includes("left out"));
  assert.ok(note, "one line says something was left out");
  assert.ok(note.includes(full), "it names the full file");
  assert.match(note, /[\d,]+ characters/, "and how many characters are missing");
  assert.ok(text.length < 24000 + 2000, "the view still fits its allowance");
});

test("SHELLTEAM_MEMORY=off: the launch carries no knowledge (the recall exam's memory-off arm)", () => {
  writeFileSync(join(LAYER, "system-prompt.md"), "PERSONA-CONTENT");
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  seedTree();
  process.env.SHELLTEAM_MEMORY = "off";
  try {
    assert.equal(harnessPromptPath(join(FAKE_HOME, "acmeproj")), join(LAYER, "system-prompt.md"));
  } finally {
    delete process.env.SHELLTEAM_MEMORY;
  }
});

test("knowledge tree: the folder a chat starts in decides what it receives", () => {
  writeManifest(["dreaming"]);
  seedTree();
  const has = (text, ...marks) => marks.forEach((m) => assert.ok(text.includes(m), `expected ${m}`));
  const lacks = (text, ...marks) => marks.forEach((m) => assert.ok(!text.includes(m), `unexpected ${m}`));

  const home = launchText(FAKE_HOME);
  has(home, "TOP-CARD");
  lacks(home, "ACME-CARD", "OTHER-CARD", "TOP-ESSENTIAL");
  assert.ok(home.startsWith("# Memory. Reference notes compiled on 14 Nov 2026."), "the first line says what this is");
  has(home, "actual code win");

  const project = launchText(join(FAKE_HOME, "acmeproj"));
  has(project, "TOP-ESSENTIAL", "ACME-CARD");
  lacks(project, "TOP-CARD", "OTHER-CARD", "ACME-ESSENTIAL", "WEB-CARD");

  // A folder with no card of its own, hidden or not: its nearest level's card.
  assert.equal(launchText(join(FAKE_HOME, "acmeproj", "api", "v2")), project);
  assert.equal(launchText(join(FAKE_HOME, "acmeproj", ".git")), project);

  const sub = launchText(join(FAKE_HOME, "acmeproj", "web", "src"));
  has(sub, "TOP-ESSENTIAL", "ACME-ESSENTIAL", "WEB-CARD");
  lacks(sub, "ACME-CARD", "TOP-CARD", "OTHER-CARD");

  const fresh = launchText(join(FAKE_HOME, "brandnew"));
  has(fresh, "TOP-ESSENTIAL", "No notes yet for ~/brandnew.");
  lacks(fresh, "TOP-CARD", "ACME-CARD");

  for (const cwd of [join(FAKE_HOME, ".config", "x"), join(FAKE_HOME, ".shellteam", "dream", "runs"), "/", "/tmp/elsewhere"]) {
    const text = launchText(cwd);
    has(text, "TOP-ESSENTIAL");
    lacks(text, "TOP-CARD", "ACME-CARD", "OTHER-CARD", "No notes yet");
  }
});

test("K14: today's notes reach the next chats at their level only; the footer names the memory command", () => {
  writeManifest(["dreaming"]);
  seedTree();
  mkdirSync(join(MEMORY, "today"), { recursive: true });
  writeFileSync(join(MEMORY, "today", "acmeproj.md"), "TODAY, NOT YET FILED\n- [14:05] ACME-NOTE staging is heron\n");
  writeFileSync(join(MEMORY, "today", "_top.md"), "TODAY, NOT YET FILED\n- [09:00] HOME-NOTE travelling\n");
  view("footer.md", "To look further: `/opt/x/bin/shellteam-memory search <words>`.\n");

  const project = launchText(join(FAKE_HOME, "acmeproj", "api"));
  assert.ok(project.includes("ACME-NOTE") && !project.includes("HOME-NOTE"));
  assert.ok(project.trimEnd().endsWith("To look further: `/opt/x/bin/shellteam-memory search <words>`."));
  const home = launchText(FAKE_HOME);
  assert.ok(home.includes("HOME-NOTE") && !home.includes("ACME-NOTE"));
  for (const cwd of [join(FAKE_HOME, "otherproj"), join(FAKE_HOME, "brandnew"), "/tmp/elsewhere"]) {
    const text = launchText(cwd);
    assert.ok(!text.includes("ACME-NOTE") && !text.includes("HOME-NOTE"), cwd);
  }
});

test("K15: the owner's setting switches each agent's own memory off in cockpit chats, and only with the module", () => {
  seedTree();
  writeManifest(["dreaming"], { codex_overrides: true });
  mkdirSync(join(LAYER, "codex"), { recursive: true });
  writeFileSync(join(LAYER, "codex", "overrides.json"), "[]");
  assert.deepEqual(ownMemoryEnv(), {}, "on by default");
  assert.ok(!codexLayerArgs(FAKE_HOME, {}).includes("features.memories=false"));

  writeFileSync(join(MEMORY, "settings.json"), JSON.stringify({ agents_own_memory: "off" }));
  assert.deepEqual(ownMemoryEnv(), { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  assert.ok(codexLayerArgs(FAKE_HOME, {}).includes("features.memories=false"));

  writeManifest(["persona"], { codex_overrides: true });
  assert.deepEqual(ownMemoryEnv(), {}, "nothing changes without the memory module");
  assert.ok(!codexLayerArgs(FAKE_HOME, {}).includes("features.memories=false"));
  rmSync(join(MEMORY, "settings.json"));
});

test("K16: each distinct launch text of a folder is kept once, with when it was first given", () => {
  writeManifest(["dreaming"]);
  seedTree();
  const launches = () => readFileSync(join(MEMORY, "told", "launches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const first = launchText(join(FAKE_HOME, "acmeproj"));
  launchText(join(FAKE_HOME, "acmeproj", "api"));          // same text: nothing new
  assert.deepEqual(launches().map((l) => l.key), ["acmeproj"]);
  assert.ok(first.endsWith(readFileSync(join(MEMORY, "told", `${launches()[0].sha}.md`), "utf8") + "\n"));
  view("acmeproj/card.md", "PROJECT: acmeproj\n- ACME-CARD changed overnight\n");
  launchText(join(FAKE_HOME, "acmeproj"));
  launchText(FAKE_HOME);
  launchText("/tmp/elsewhere");
  assert.deepEqual(launches().map((l) => l.key), ["acmeproj", "acmeproj", "", "/"]);
  assert.ok(launches().every((l) => l.at > 1.7e9));

  // A project with no card yet and a chat outside home have different texts: their own files.
  const fresh = harnessPromptPath(join(FAKE_HOME, "brandnew"));
  const outside = harnessPromptPath("/tmp/elsewhere");
  assert.notEqual(fresh, outside);
  assert.ok(readFileSync(fresh, "utf8").includes("No notes yet for ~/brandnew."));
  assert.ok(!readFileSync(outside, "utf8").includes("No notes yet"));
});

test("knowledge tree: all four agents receive the same launch text", () => {
  writeFileSync(join(LAYER, "system-prompt.md"), "PERSONA-CONTENT\nPERSONA-END");
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true, codex_overrides: true, antigravity_plugin: true });
  mkdirSync(join(LAYER, "codex"), { recursive: true });
  writeFileSync(join(LAYER, "codex", "overrides.json"), "[]");
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam"), { recursive: true });
  seedTree();
  const cwd = join(FAKE_HOME, "acmeproj");
  const shared = launchText(cwd);
  assert.ok(shared.includes("PERSONA-CONTENT") && shared.includes("PERSONA-END") && shared.includes("ACME-CARD"));

  const claude = claudeLayerArgs(cwd);
  assert.equal(readFileSync(promptFileOf(claude), "utf8"), shared);
  const codex = codexLayerArgs(cwd, {}).find((a) => a.startsWith("developer_instructions="));
  assert.equal(JSON.parse(codex.slice("developer_instructions=".length)), shared);
  const antigravity = antigravityLayerArgs(cwd);
  assert.equal(readFileSync(join(antigravity[1], ".agents", "plugins", "shellteam", "rules", "shellteam.md"), "utf8"), shared);
  const pi = piLayer(cwd).args;
  assert.equal(readFileSync(pi[pi.indexOf("--append-system-prompt") + 1], "utf8"), shared);
});

test("knowledge tree: an exam run on another tree never writes the file live chats read", () => {
  writeManifest(["dreaming"]);
  seedTree();
  const live = harnessPromptPath(join(FAKE_HOME, "acmeproj"));
  process.env.SHELLTEAM_MEMORY_ROOT = join(FAKE_HOME, "elsewhere");
  try {
    cpSync(MEMORY, join(FAKE_HOME, "elsewhere"), { recursive: true });
    view("acmeproj/card.md", "PROJECT: acmeproj\n- LIVE-ONLY line\n");
    const exam = harnessPromptPath(join(FAKE_HOME, "acmeproj"));
    assert.notEqual(exam, live);
    assert.ok(readFileSync(exam, "utf8").includes("ACME-CARD"));
  } finally {
    delete process.env.SHELLTEAM_MEMORY_ROOT;
    rmSync(join(FAKE_HOME, "elsewhere"), { recursive: true, force: true });
  }
});

test("knowledge tree: an employee box has its project's card and nothing of the owner's", () => {
  // An employee sandbox: the manifest carries employee (no dreaming), and the
  // host synced ONLY its project's branch into this HOME.
  writeFileSync(join(LAYER, "system-prompt.md"), "EMPLOYEE-HARNESS");
  writeManifest(["employee", "linear"], { claude_system_prompt: true });
  seedTree();
  rmSync(join(MEMORY, "views", "_top"), { recursive: true });
  rmSync(join(MEMORY, "views", "otherproj"), { recursive: true });
  const text = launchText(join(FAKE_HOME, "acmeproj"));
  assert.ok(text.includes("EMPLOYEE-HARNESS") && text.includes("ACME-CARD"));
  assert.ok(!text.includes("TOP-") && !text.includes("OTHER-CARD"));
});

test("knowledge tree: module off means no memory, whatever is on disk", () => {
  writeManifest([]);
  seedTree();
  assert.equal(harnessPromptPath(join(FAKE_HOME, "acmeproj")), null);
});

test("dreaming ON without persona: all four agents receive the same memory-only prompt", () => {
  const cwd = join(FAKE_HOME, "acmeproj");
  mkdirSync(join(LAYER, "antigravity-workspace", ".agents", "plugins", "shellteam"), { recursive: true });
  writeManifest(["dreaming"], { antigravity_plugin: true });
  seedTree();

  const sharedPath = harnessPromptPath(cwd);
  const shared = readFileSync(sharedPath, "utf8");
  assert.ok(shared.includes("ACME-CARD"));
  assert.ok(!shared.includes("PERSONA-CONTENT"));
  assert.equal(promptFileOf(claudeLayerArgs(cwd)), sharedPath);
  const codexDeveloper = codexLayerArgs(cwd).find((value) => String(value).startsWith("developer_instructions="));
  assert.equal(JSON.parse(codexDeveloper.slice("developer_instructions=".length)), shared);
  const pi = piLayer(cwd).args;
  assert.equal(pi[pi.indexOf("--append-system-prompt") + 1], sharedPath);
  const agArgs = antigravityLayerArgs(cwd);
  assert.equal(readFileSync(join(agArgs[1], ".agents", "plugins", "shellteam", "rules", "shellteam.md"), "utf8"), shared);
});

test("pure core: dreaming absent → no knowledge, no flags beyond core", () => {
  writeManifest([]);
  assert.deepEqual(claudeLayerArgs(join(FAKE_HOME, "acmeproj")), []);
});

test("Pi: dreaming ON appends the composed memory file, dreaming OFF adds no prompt", () => {
  writeManifest(["dreaming"]);
  seedTree();
  const on = piLayer(join(FAKE_HOME, "acmeproj")).args;
  const prompt = on[on.indexOf("--append-system-prompt") + 1];
  assert.match(prompt, /runtime\/harness-prompt-tree-acmeproj-[0-9a-f]{6}\.md$/);
  assert.ok(readFileSync(prompt, "utf8").includes("ACME-CARD"));
  writeManifest([]);
  assert.ok(!piLayer(join(FAKE_HOME, "acmeproj")).args.includes("--append-system-prompt"));
});

test("dreaming ON: trailing-slash cwds resolve like their normalized form (no crash)", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  seedTree();
  assert.match(promptFileOf(claudeLayerArgs(FAKE_HOME + "/")), /runtime\/harness-prompt-tree-root\.md$/);
  assert.deepEqual(claudeLayerArgs(join(FAKE_HOME, "acmeproj")), claudeLayerArgs(join(FAKE_HOME, "acmeproj") + "/"));
});

test("dreaming ON: levels whose names collide after slugging get distinct runtime files", () => {
  writeManifest(["persona", "dreaming"], { claude_system_prompt: true });
  seedTree();
  view("My-App/card.md", "PROJECT: My-App\n- UPPER fact\n");
  view("my-app/card.md", "PROJECT: my-app\n- lower fact\n");
  const upperPath = promptFileOf(claudeLayerArgs(join(FAKE_HOME, "My-App")));
  const lowerPath = promptFileOf(claudeLayerArgs(join(FAKE_HOME, "my-app")));
  assert.notEqual(upperPath, lowerPath);
  assert.ok(readFileSync(upperPath, "utf8").includes("UPPER fact"));
  assert.ok(!readFileSync(upperPath, "utf8").includes("lower fact"));
});

test("Pi: a corrupt layer.json degrades loudly to the static path, not a spawn crash", () => {
  linearLayer({ mcp_relay: RELAY });
  writeFileSync(join(LAYER, "pi", "layer.json"), "{ this is not json");
  assert.equal(piLayer(join(FAKE_HOME, "acmeproj")).env.SHELLTEAM_PI_LAYER, join(LAYER, "pi", "layer.json"));
});

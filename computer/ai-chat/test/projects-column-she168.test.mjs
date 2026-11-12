/**
 * SHE-168 — the projects column. Seb's 16 tabs: 4 in a project folder, 12 in
 * the home folder, because changing a tab's folder wiped its conversation
 * (`set_cwd` resets the slot), so nobody ever moved a chat.
 *
 * What is pinned here, with mock agents (no CLI, no cost):
 *  - the project list: a folder an agent works in is a project, home never is,
 *    the owner's name is kept, the folder is never touched on removal;
 *  - moving a chat into a project KEEPS its history (the regression);
 *  - the "move in" request reaches the agent as a cockpit notice;
 *  - the page wiring that makes the column opt-in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-projects-"));
delete process.env.SHELLTEAM_WORKSPACE_LOCK;
const sm = await import("../lib/session-manager.mjs");
const projects = await import("../lib/projects.mjs");
const { moveInPrompt, recordSessionMove } = await import("../lib/project-move.mjs");
const { isInternalUserContent } = await import("../lib/history.mjs");
const { CODEX_HISTORY_DIR, HOME, PROJECTS_FILE, SESSION_MOVES_FILE } = await import("../lib/constants.mjs");

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const CODEX = "gpt-6-luna";

sm._testSetAgentFactory(() => ({ on() {}, start() {}, stop() {}, interrupt() {}, sendMessage() {} }));
sm.setBroadcast(() => {});

const shop = join(HOME, "webshop");
const blog = join(HOME, "blog");
mkdirSync(join(shop, "api"), { recursive: true });
mkdirSync(blog);

let nextSlot = 500;
/** A Codex chat in `cwd` with a real cockpit-owned history file. */
function chat(cwd, lines) {
  const id = nextSlot++;
  const sid = `codex-thread-${id}`;
  mkdirSync(CODEX_HISTORY_DIR, { recursive: true });
  writeFileSync(join(CODEX_HISTORY_DIR, `${sid}.jsonl`),
    [{ type: "session_meta", model: CODEX, cwd, timestamp: Date.now() }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  sm.createSlot(id, { model: CODEX, cwd });
  sm.setSessionId(id, sid);
  for (const l of lines) if (l.type === "user_message") sm.addUserMessage(id, l.content);
  return id;
}
const WORK = [
  { type: "user_message", content: "Study the magnets. PINEAPPLE-42", timestamp: Date.now() },
  { type: "text_done", text: "Ferrite lost, neodymium won." },
  { type: "turn_done" },
];

test("a folder an agent works in becomes a project; home and dot-folders never do", () => {
  assert.equal(projects.ensureProject(HOME), false, "home is not a project");
  assert.equal(projects.ensureProject(join(HOME, ".config")), false);
  assert.equal(projects.ensureProject("/etc"), false, "outside home");
  assert.equal(projects.ensureProject(shop), true);
  assert.equal(projects.ensureProject(shop), false, "already listed");
  assert.equal(projects.ensureProject(join(shop, "api")), false, "a subfolder belongs to its project");
  assert.equal(projects.projectFor(join(shop, "api")).path, shop);
  assert.equal(projects.projectFor(join(HOME, "webshop-2")), null, "a name that only starts the same is another folder");
  assert.deepEqual(projects.listProjects(), [{ path: shop, name: "webshop", label: "~/webshop" }]);
});

test("the owner's name is kept across a reload; the folder path is not editable", () => {
  assert.equal(projects.renameProject(shop, "  Web   Shop  "), true);
  assert.equal(projects.renameProject(join(HOME, "nope"), "x"), false);
  projects._resetForTests();
  assert.deepEqual(projects.listProjects(), [{ path: shop, name: "Web Shop", label: "~/webshop" }]);
  assert.equal(projects.renameProject(shop, ""), true);
  assert.equal(projects.listProjects()[0].name, "webshop", "an empty name falls back to the folder name");
});

test("a new project gets a safe folder name; a clash is refused, never overwritten", () => {
  assert.equal(projects.folderNameFor("  Magnet Lab! "), "magnet-lab");
  const made = projects.createProject("Magnet Lab");
  assert.deepEqual(made, { path: join(HOME, "magnet-lab"), name: "Magnet Lab" });
  assert.ok(existsSync(made.path));
  assert.match(projects.createProject("magnet lab").error, /already uses/);
  assert.match(projects.createProject("!!!").error, /name/);
  // A folder that exists but is not a project yet is adopted, not refused.
  assert.equal(projects.createProject("Blog").path, blog);
});

test("removing a project from the list leaves its folder alone", () => {
  assert.equal(projects.removeProject(blog), true);
  assert.ok(existsSync(blog), "the folder is still there");
  assert.equal(projects.listProjects().some((p) => p.path === blog), false);
  assert.equal(projects.openProject("~/blog").path, blog, "and can be opened again");
  assert.match(projects.openProject("/etc").error, /inside your home/);
  assert.match(projects.openProject("~/missing").error, /not a folder/);
});

test("only a GitHub repository address is accepted for cloning", () => {
  assert.deepEqual(projects.parseRepo("sebderhy/shellteam"), { url: "https://github.com/sebderhy/shellteam.git", folder: "shellteam" });
  assert.equal(projects.parseRepo("https://github.com/a/b.git").folder, "b");
  assert.equal(projects.parseRepo("git@github.com:a/b").url, "https://github.com/a/b.git");
  for (const bad of ["", "just-a-name", "https://evil.example/a/b", "a/b; rm -rf ~", "--upload-pack=x/y", "a/..", "file:///etc/passwd"]) {
    assert.equal(projects.parseRepo(bad), null, bad);
  }
});

test("moving a chat into a project keeps its history (set_cwd used to wipe it)", async () => {
  const id = chat(HOME, WORK);
  const before = sm.getSessionId(id);
  const historyBefore = sm.getHistory(id).length;

  const moved = await sm.moveSlot(id, shop);

  assert.ok(!moved.error, moved.error);
  assert.equal(moved.fromCwd, HOME);
  assert.equal(sm.getCwd(id), shop);
  assert.notEqual(sm.getSessionId(id), before, "a fresh session of the same agent, in the new folder");
  assert.equal(moved.fromSessionId, before);
  const history = sm.getHistory(id);
  assert.ok(history.some((m) => m.type === "user_message" && /PINEAPPLE-42/.test(m.content)), "the conversation came along");
  assert.equal(history.length, historyBefore + 1);
  assert.deepEqual({ ...history.at(-1), timestamp: 0 }, { type: "session_event", event: "moved", fromCwd: HOME, toCwd: shop, timestamp: 0 });
  // The cockpit-owned history of the NEW session says where it lives, so a
  // restart does not send the chat back to the old folder.
  const meta = JSON.parse(readFileSync(join(CODEX_HISTORY_DIR, `${sm.getSessionId(id)}.jsonl`), "utf8").split("\n")[0]);
  assert.equal(meta.cwd, shop);
});

test("a working agent is not moved; an empty chat just starts in the project", async () => {
  const busy = chat(HOME, WORK);
  await sm.startAgent(busy);
  await sm.sendMessage(busy, "keep going");
  const refused = await sm.moveSlot(busy, shop);
  assert.match(refused.error, /working/);
  assert.equal(sm.getCwd(busy), HOME, "untouched");

  const empty = nextSlot++;
  sm.createSlot(empty, { model: CODEX, cwd: HOME });
  const moved = await sm.moveSlot(empty, blog);
  assert.deepEqual(moved, { cwd: blog, fromCwd: HOME, fromSessionId: null, sessionId: null });
  assert.equal(sm.getCwd(empty), blog);
});

test("the column's status fields are in the slot list", async () => {
  const id = chat(HOME, WORK);
  const idle = sm.listSlots().find((s) => s.id === id);
  assert.equal(idle.turnStartedAt, 0);
  assert.equal(idle.asking, false);
  await sm.startAgent(id);
  await sm.sendMessage(id, "go");
  const working = sm.listSlots().find((s) => s.id === id);
  assert.ok(working.turnStartedAt > 0, "when the turn started, for 'Working 4 min'");
});

test("the move-in request is a cockpit notice that names the project and guards the repository step", () => {
  const project = { path: shop, name: "Web Shop" };
  const withRepo = moveInPrompt({ project, createRepo: true });
  const without = moveInPrompt({ project, createRepo: false });
  assert.ok(isInternalUserContent(withRepo), "shown folded in the chat, not as the owner's own bubble");
  for (const text of [withRepo, without]) {
    assert.match(text, /"Web Shop" \(~\/webshop\)/);
    assert.match(text, /AGENTS\.md/);
    assert.match(text, /Reports stay in ~\/reports/);
  }
  assert.match(withRepo, /PRIVATE GitHub repository/);
  assert.match(withRepo, /Never make it public/);
  assert.match(without, /Do not create a remote repository/);
  assert.doesNotMatch(without, /PRIVATE GitHub repository/);
});

test("a move is recorded for the Reports tab, one JSON line each", () => {
  recordSessionMove({ sessionId: "abc", fromCwd: HOME, toCwd: shop });
  recordSessionMove({ sessionId: "def", fromCwd: shop, toCwd: blog });
  const lines = readFileSync(SESSION_MOVES_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map(({ session, from, to }) => ({ session, from, to })),
    [{ session: "abc", from: HOME, to: shop }, { session: "def", from: shop, to: blog }]);
});

test("the project list lives next to the cockpit's other state, not in the agents' own config", () => {
  assert.equal(PROJECTS_FILE, join(HOME, ".config", "shellteam", "projects.json"));
  assert.equal(SESSION_MOVES_FILE, join(HOME, ".config", "shellteam", "moved-sessions.jsonl"));
});

test("the column is opt-in: without ?layout=projects the page is the tab row", () => {
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /<script src="\/layout\.js"><\/script>/, "the layout class is set before the first paint");
  assert.ok(html.indexOf('src="/projects.js"') > html.indexOf('src="/app.js"'), "projects.js reads app.js globals");
  assert.match(html, /<aside class="pj-side" id="pjSide"[^>]*\bhidden\b/, "the column starts hidden");
  const layout = readFileSync(join(PUBLIC, "layout.js"), "utf8");
  assert.match(layout, /get\('layout'\) === 'projects'/);
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  assert.match(js, /if \(!ON \|\|/, "render() does nothing when the column is off");
  const css = readFileSync(join(PUBLIC, "projects.css"), "utf8");
  assert.match(css, /^\.pj-side, \.pj-back, \.pj-crumb, \.pj-tools, \.pj-first \{ display: none; \}/m);
});

test("the agent and project menus are not stretched across the window", () => {
  // .actions-menu is declared later in styles.css and sets position/right; a
  // single-class rule lost to it and the menu ran to the right edge.
  const css = readFileSync(join(PUBLIC, "styles.css"), "utf8");
  assert.match(css, /\.actions-menu\.tab-context-menu \{ position: fixed; top: auto; right: auto;/);
});

test("SHE-169: the project's three views sit between the project's name and the agent's", () => {
  // They were on the right, next to the chat's own controls, and read as the chat's.
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  const [proj, tools, agent, right] = ['id="pjCrumb"', 'id="pjTools"', 'id="pjAgent"', 'class="status-right"'].map(s => html.indexOf(s));
  assert.ok(proj > 0 && proj < tools && tools < agent && agent < right);
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  assert.match(js, /getElementById\('pjAgent'\)\.addEventListener\('dblclick'/, "the agent's name is still renamed by double-click");
});

test("SHE-169: the chat's own report count says it is this chat's", () => {
  // Beside the project's "Reports" button, a bare page icon and a number looked like a second copy.
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  assert.match(html, /id="reportsCount">0<\/span><span class="btn-reports-scope">in this chat<\/span>/);
  const css = readFileSync(join(PUBLIC, "projects.css"), "utf8");
  assert.match(css, /^\.btn-reports-scope \{ display: none; \}/m, "the tab-row layout is unchanged");
  assert.match(css, /html\.layout-projects \.btn-reports-scope \{ display: inline;/);
});

test("SHE-169: home-folder chats are 'General ~', and feedback is a bug, not a chat bubble", () => {
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  assert.match(js, /const GENERAL = 'General';/);
  assert.match(js, /<span class="pj-name">\$\{GENERAL\}<\/span><span class="pj-path"[^>]*>~<\/span>/);
  assert.doesNotMatch(js, /not in a project<|'Not in a project'/i);
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  const feedback = html.slice(html.indexOf('id="pjFeedback"'), html.indexOf('id="pjCollapse"'));
  assert.match(feedback, /m8 2 1\.88 1\.88/, "the bug icon");
  assert.doesNotMatch(feedback, /M21 15a2 2 0 0 1-2 2H7l-4 4V5/, "not the chat bubble");
});

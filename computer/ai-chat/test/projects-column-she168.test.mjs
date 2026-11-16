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
 *  - the page wiring: the column is the only layout (SHE-188), and the
 *    cockpit map's rules (docs/plans/active/cockpit-map/prd.md).
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

test("SHE-188: the column is the only layout; the tab row, its drawer and the switch are gone", () => {
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  assert.ok(html.indexOf('src="/projects.js"') > html.indexOf('src="/app.js"'), "projects.js reads app.js globals");
  assert.match(html, /<aside class="pj-side" id="pjSide"[^>]*\bhidden\b/, "the column shows once projects.js has drawn it");
  assert.ok(!existsSync(join(PUBLIC, "layout.js")), "no layout switch script");
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  const app = readFileSync(join(PUBLIC, "app.js"), "utf8");
  const css = readFileSync(join(PUBLIC, "projects.css"), "utf8") + readFileSync(join(PUBLIC, "styles.css"), "utf8");
  for (const [name, src] of [["index.html", html], ["projects.js", js], ["app.js", app], ["css", css]]) {
    for (const relic of ["layout-projects", "layout=projects", "session-tab", "sessionTabs", "conv-switcher", "convSwitcher", "sessionDrawer", "session-drawer"]) {
      assert.ok(!src.includes(relic), `${name} still has "${relic}"`);
    }
  }
  assert.doesNotMatch(js, /\bON\b/, "no on/off switch left in projects.js");
});

test("the agent and project menus are not stretched across the window", () => {
  // .actions-menu is declared later in styles.css and sets position/right; a
  // single-class rule lost to it and the menu ran to the right edge.
  const css = readFileSync(join(PUBLIC, "styles.css"), "utf8");
  assert.match(css, /\.actions-menu\.tab-context-menu \{ position: fixed; top: auto; right: auto;/);
});

test("SHE-169: the project's three views sit with the project, left of the chat's own controls", () => {
  // They were on the right, next to the chat's own controls, and read as the chat's.
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  const [proj, agent, tools, right] = ['id="pjCrumb"', 'id="pjAgent"', 'id="pjTools"', 'class="status-right"'].map(s => html.indexOf(s));
  assert.ok(proj > 0 && proj < agent && agent < tools && tools < right);
  // The chat's name is renamed from the first row of its menu, and by double-click in the column.
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  assert.match(js, /row\('chat\.rename', 'e', 'pen', 'Rename', \(\) => beginRenameOn\(document\.getElementById\('pjAgent'\), activeSlotId\)\)/);
  assert.match(js, /const agName = e\.target\.closest\('\.pj-ag-name'\);\s*if \(agName\) beginRenameOn\(/);
});

test("SHE-169: the chat's own report count says it is this chat's", () => {
  // Beside the project's "Reports" button, a bare page icon and a number looked like a second copy.
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  assert.match(html, /id="reportsCount">0<\/span><span class="btn-reports-scope">in this chat<\/span>/);
  const css = readFileSync(join(PUBLIC, "projects.css"), "utf8");
  assert.match(css, /^\.btn-reports-scope \{ color: var\(--text-muted\);/m);
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

test("SHE-184: a folder with no agent yet is findable and one step from a chat", () => {
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  assert.match(js, /for \(const w of freeFolders\(\)\) items\.push\(\{[^}]*Start an agent in/, "Ctrl+K lists the free folders");
  assert.match(js, /openAddDialog\(startMode = projects\.length && freeFolders\(\)\.length \? 'open' : 'new'\)/,
    "past the first project the dialog opens on Existing folder");
  assert.match(js, /Open a folder or start a project/, "the button says it opens existing folders");
});

test("SHE-187: on a phone a tap on the title and a swipe open the list; a long press opens the chat menu", () => {
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  const wire = js.match(/\n    function wireTitle\(title\) \{[\s\S]*?\n    \}\n/)[0];
  assert.match(wire, /if \(!isPhone\(\)\) return openMenu\(\);\s*showList\(true\);/, "desktop: the menu; phone: back to the chats");
  assert.match(wire, /hold = setTimeout\(\(\) => \{ held = true;[^}]*openMenu\(\); \}, HOLD_MS\)/, "a long press opens the menu");
  // Lifting the finger makes a click on the menu's backdrop, which closed the
  // menu the moment it opened (caught in a real browser, 2026-11-15).
  assert.match(wire, /document\.addEventListener\('click', swallow, \{ capture: true, once: true \}\);/, "the click that ends a long press is swallowed");
  assert.match(wire, /pjHoldHintSeen/, "the long press is said once, the first time");
  assert.match(js, /onSwipe\(document\.querySelector\('\.chat-main'\), 'right'/);
  assert.match(js, /onSwipe\(side, 'left'/);
});

test("U3: the agent and the model are named in words at every width", () => {
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  assert.match(html, /<span class="btn-ai-agent" id="btnAIAgent"><\/span>\s*<span class="btn-ai-model" id="btnAIModel">/);
  const css = readFileSync(join(PUBLIC, "projects.css"), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 720px)"));
  assert.match(phone, /\.btn-ai-agent, html:not\(\.pj-side-shut\) \.btn-ai-agent \{ display: inline;/, "the agent's name comes back on a phone");
  assert.doesNotMatch(css, /\.btn-ai-model \{[^}]*display: none/, "the model's name is never hidden");
  assert.doesNotMatch(readFileSync(join(PUBLIC, "styles.css"), "utf8"), /\.btn-ai-model/, "one place styles the model button");
});

test("starting an agent is a visible line under each project, not a plus on hover", () => {
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  assert.match(js, /newLine\(p\.path, 'New agent'\)/);
  assert.match(js, /newLine\('', 'New chat'\)/);
  assert.match(js, /<button class="pj-new" type="button" data-new=/);
  const head = js.match(/<div class="pj-head"[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(head, /data-new=/, "no hover-only plus in the project's head");
});

test("every state has a word, and a question is never listed as done (U6, U10)", async () => {
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  const src = js.match(/\n    function spanText\(ms\) \{[\s\S]*?\n    \}\n/)[0] + js.match(/\n    function stateOf\(slot\) \{[\s\S]*?\n    \}\n/)[0]
    + js.match(/\n    function waitingLine\(slot\) \{[\s\S]*?\n    \}\n/)[0];
  const now = Date.now();
  const { stateOf, waitingLine } = new Function("slotUnread", `${src}; return { stateOf, waitingLine };`)((s) => !!s.unread);
  assert.deepEqual(stateOf({ isGenerating: true, asking: true }), { kind: "ask", text: "Needs you" });
  assert.deepEqual(stateOf({ isGenerating: true, turnStartedAt: now - 5 * 60000 }), { kind: "work", text: "Working 5 min" });
  // Its turn ended, but work it started is still running: never "Done", even with an unread answer.
  const waiting = { sessionId: "s", unread: true, waitingOn: 2, waitingSince: now - 4 * 60000, answeredAt: now };
  assert.deepEqual(stateOf(waiting), { kind: "wait", text: "Waiting 4 min" });
  assert.equal(waitingLine(waiting), "Waiting on 2 background tasks · 4 min");
  assert.equal(waitingLine({ ...waiting, waitingOn: 1 }), "Waiting on 1 background task · 4 min");
  assert.equal(waitingLine({ ...waiting, isGenerating: true }), "", "while it works, Working says it");
  assert.deepEqual(stateOf({ sessionId: "s", unread: true, answeredAt: now - 3600000 }), { kind: "new", text: "Done 1 h" });
  assert.deepEqual(stateOf({}), { kind: "", text: "New" });
});

test("SHE-115: the server says how much work an agent left running, to every agent type's chat", () => {
  const id = chat(shop, WORK);
  let row = sm.listSlots().find((s) => s.id === id);
  assert.equal(row.waitingOn, 0);
  assert.equal(row.waitingSince, 0);
  const src = readFileSync(join(dirname(PUBLIC), "lib", "session-manager.mjs"), "utf8");
  assert.match(src, /\.\.\.waitingOf\(s\),/, "the slot list carries it for every chat");
  assert.match(src, /slotBroadcast\(slotId, "waiting_on", waitingOf\(slot\)\);/, "and says so the moment it changes");
  const js = readFileSync(join(PUBLIC, "projects.js"), "utf8");
  assert.match(js, /if \(msg\.type === 'waiting_on'\) \{ slot\.waitingOn = msg\.waitingOn \|\| 0;/);
});

test("SHE-197: a dashboard message is judged only once the box settings are known", () => {
  // The cockpit learns the dashboard's address from /api/box. The dashboard's
  // first message (which says the Knowledge page exists) can arrive earlier;
  // judged against the placeholder address it was dropped, and the project
  // header lost its Knowledge button until something resent the state.
  const js = readFileSync(join(PUBLIC, "app.js"), "utf8");
  const listener = js.slice(js.indexOf("// From the dashboard itself"));
  const handler = listener.slice(0, listener.indexOf("});") + 3);
  assert.match(handler, /boxReady\.then\(/, "the origin check waits for /api/box");
  assert.ok(handler.indexOf("boxReady.then(") < handler.indexOf("fileBaseUrl()"),
    "nothing is compared with the dashboard address before it is known");
  assert.match(js, /const boxReady = loadBoxInfo\(\)/, "one load, shared by startup and the listener");
});

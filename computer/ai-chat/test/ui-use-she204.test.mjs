/**
 * SHE-204 — a private count of what the owner uses.
 *
 * For the cockpit map (Nov 2026) nobody could say how often the owner compacts,
 * switches chat or opens Settings: the cockpit recorded no clicks, so where each
 * control lives was a guess from server logs. Now every control used adds one to
 * its name, per day and per screen, in a file on the box.
 *
 * Pinned here: only names are kept (never what the owner wrote), junk is
 * refused, the file stays on the box, and one command ranks the controls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HOME = mkdtempSync(join(tmpdir(), "st-ui-use-"));
const { recordUse, readUse, ranking, shelf } = await import("../lib/ui-use.mjs");
const { UI_USE_FILE } = await import("../lib/constants.mjs");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const day = (s) => new Date(`${s}T10:00:00Z`);

test("counts add up per day and per screen", () => {
  assert.equal(recordUse("desktop", { "chat.compact": 2, "chat.open": 5 }, day("2026-11-14")), 2);
  recordUse("desktop", { "chat.compact": 1 }, day("2026-11-14"));
  recordUse("phone", { "chat.open": 4 }, day("2026-11-15"));
  assert.deepEqual(readUse(), {
    "2026-11-14": { desktop: { "chat.compact": 3, "chat.open": 5 } },
    "2026-11-15": { phone: { "chat.open": 4 } },
  });
});

test("only fixed control names are kept: nothing the owner could have written", () => {
  const before = readFileSync(UI_USE_FILE, "utf8");
  for (const bad of ["My secret project", "chat.open ", "../etc", "Chat.Open", "a".repeat(80), "chat/open", "x.y.z.a.b.c.d.e"]) {
    assert.equal(recordUse("desktop", { [bad]: 1 }, day("2026-11-15")), 0, `"${bad}" must be refused`);
  }
  assert.equal(recordUse("desktop", { "chat.open": "3" }, day("2026-11-15")), 0, "a count is a whole number");
  assert.equal(recordUse("desktop", { "chat.open": -1 }, day("2026-11-15")), 0);
  assert.equal(recordUse("tablet", { "chat.open": 1 }, day("2026-11-15")), 0, "two screens: desktop and phone");
  assert.equal(readFileSync(UI_USE_FILE, "utf8"), before, "a refused report writes nothing");
});

test("the file is the owner's alone and sits with the cockpit's other state", () => {
  assert.equal(UI_USE_FILE, join(process.env.HOME, ".config", "shellteam", "ui-use.json"));
  assert.equal(statSync(UI_USE_FILE).mode & 0o777, 0o600);
});

test("a runaway page cannot bloat it", () => {
  recordUse("desktop", { "chat.spam": 1_000_000 }, day("2026-11-15"));
  assert.equal(readUse()["2026-11-15"].desktop["chat.spam"], 500, "one report adds at most 500");
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`junk.n${i}`, 1]));
  recordUse("phone", many, day("2026-11-16"));
  assert.ok(Object.keys(readUse()["2026-11-16"].phone).length <= 400, "at most 400 names a day per screen");
  recordUse("desktop", { "chat.open": 1 }, day("2028-03-01"));
  assert.deepEqual(Object.keys(readUse()), ["2028-03-01"], "days older than 400 days are dropped");
});

test("the ranking says which shelf each control belongs on", () => {
  for (let d = 1; d <= 10; d++) {
    const when = day(`2028-04-${String(d).padStart(2, "0")}`);
    recordUse("desktop", { "message.sent": 30, "chat.compact": 2 }, when);
    if (d % 4 === 0) recordUse("phone", { "chat.fork": 1 }, when);
    if (d === 3) recordUse("desktop", { "chat.merge": 1 }, when);
  }
  const { activeDays, rows } = ranking({ days: 10, now: day("2028-04-10") });
  assert.equal(activeDays, 10);
  assert.deepEqual(rows.map((r) => r.name), ["message.sent", "chat.compact", "chat.fork", "chat.merge"]);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(shelf(byName["message.sent"], activeDays), "all the time");
  assert.equal(shelf(byName["chat.compact"], activeDays), "daily");
  assert.equal(shelf(byName["chat.fork"], activeDays), "weekly");
  assert.equal(shelf(byName["chat.merge"], activeDays), "rare");
  assert.deepEqual({ desktop: byName["chat.fork"].desktop, phone: byName["chat.fork"].phone }, { desktop: 0, phone: 2 });
});

test("one command prints it, for the agent asked for a UX change", () => {
  const out = execFileSync(join(ROOT, "..", "..", "bin", "shellteam-usage"), ["--days", "400"], { env: { ...process.env }, encoding: "utf8" });
  assert.match(out, /message\.sent\s+300\s+300\s+0/);
  assert.match(out, /shelf/);
  const json = JSON.parse(execFileSync(join(ROOT, "..", "..", "bin", "shellteam-usage"), ["--days", "400", "--json"], { env: { ...process.env }, encoding: "utf8" }));
  assert.equal(json.rows[0].name, "message.sent");
});

test("the page sends names only, and nothing leaves the box", () => {
  const use = readFileSync(join(ROOT, "public", "use.js"), "utf8");
  assert.match(use, /S\.ws\.send\(JSON\.stringify\(\{ type: 'ui_use', screen: where, counts \}\)\)/, "to this box's own cockpit server");
  assert.doesNotMatch(use, /fetch\(|XMLHttpRequest|sendBeacon|textContent|innerText|\.value\b/, "no network call of its own, and it reads no text");
  const server = readFileSync(join(ROOT, "server.mjs"), "utf8");
  assert.match(server, /case "ui_use": \{\s*recordUse\(msg\.screen, msg\.counts\);/);
  const lib = readFileSync(join(ROOT, "lib", "ui-use.mjs"), "utf8");
  assert.doesNotMatch(lib, /fetch\(|https?:\/\/|node:http|node:net/, "the store only writes its file");
  // The dashboard's controls are counted through the cockpit, under a dash. prefix only.
  const app = readFileSync(join(ROOT, "public", "app.js"), "utf8");
  assert.match(app, /d\.kind === 'use'\) \{ if \(\/\^dash\\\.\[a-z0-9\.-\]\+\$\/\.test\(d\.name \|\| ''\)\) Use\.count\(d\.name\); \}/);
});

test("every control of the page has a name: data-use, else its id, else its class", () => {
  const use = readFileSync(join(ROOT, "public", "use.js"), "utf8");
  const src = use.slice(use.indexOf("const kebab"), use.indexOf("function flush"));
  const nameOf = new Function(`const pending = {}; const screen = () => 'desktop'; ${src}; return nameOf;`)();
  const el = (attrs) => ({ closest: (sel) => sel === "[data-use]" ? (attrs.use ? { dataset: { use: attrs.use } } : null) : (attrs.control ? { id: attrs.id || "", classList: attrs.classes || [] } : null) });
  assert.equal(nameOf(el({ use: "chat.compact" })), "chat.compact");
  assert.equal(nameOf(el({ control: true, id: "btnCompactSend" })), "id.btn-compact-send");
  assert.equal(nameOf(el({ control: true, classes: ["empty-chip", "x"] })), "class.empty-chip");
  assert.equal(nameOf(el({})), null, "a click on plain text is not a control");
});

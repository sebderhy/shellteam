// SHE-177: a Codex agent built a report with a script; the project's Reports
// list stayed empty because only a Claude Write call counted as authorship.
// The cockpit now records, when a turn ends, the reports that turn named AND
// changed. A mention of an older report must still not attribute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurnReports, reportsWrittenInTurn } from "../lib/report-writes.mjs";

function box() {
  const dir = mkdtempSync(join(tmpdir(), "report-writes-"));
  const reportsDir = join(dir, "reports");
  mkdirSync(join(reportsDir, "sub"), { recursive: true });
  const put = (rel, ageMs) => {
    const f = join(reportsDir, rel);
    writeFileSync(f, "x");
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(f, at, at);
  };
  return { dir, reportsDir, put, file: join(dir, "report-writes.jsonl"), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const turnStartedAt = Date.now() - 60_000;
const turn = (...entries) => [{ type: "turn_done" }, { type: "user_message", content: "make the report" }, ...entries, { type: "turn_done" }];

test("a report built by a script and linked in the reply is recorded for the chat's folder", () => {
  const b = box();
  b.put("sales-week-45.html", 5_000);
  const history = turn(
    { type: "tool_input", id: "1", input: { command: "python3 build_report.py" } },
    { type: "text_done", text: "Open [your report](https://you.shellteam.sh/reports/sales-week-45.html)." },
  );
  const written = recordTurnReports({ history, turnStartedAt, cwd: "/home/owner/kahava", sessionId: "t1", reportsDir: b.reportsDir, file: b.file });
  assert.deepEqual(written, ["sales-week-45.html"]);
  const line = JSON.parse(readFileSync(b.file, "utf8").trim());
  assert.equal(line.report, "sales-week-45.html");
  assert.equal(line.cwd, "/home/owner/kahava");
  assert.equal(line.session, "t1");
  b.done();
});

test("a report named only in a tool call counts, keyed by its file name", () => {
  const b = box();
  b.put("sub/notes.md", 1_000);
  const history = turn({ type: "tool_input", id: "1", input: { command: "cat > ~/reports/sub/notes.md <<'X'\nhi\nX" } });
  assert.deepEqual(reportsWrittenInTurn({ history, turnStartedAt, reportsDir: b.reportsDir }), ["sub/notes.md"]);
  recordTurnReports({ history, turnStartedAt, cwd: "/p", sessionId: "t", reportsDir: b.reportsDir, file: b.file });
  assert.equal(JSON.parse(readFileSync(b.file, "utf8").trim()).report, "notes.md");
  b.done();
});

test("linking a report that did not change during the turn records nothing", () => {
  const b = box();
  b.put("old.html", 3_600_000);
  const history = turn({ type: "text_done", text: "Yesterday's is at /reports/old.html" });
  assert.deepEqual(recordTurnReports({ history, turnStartedAt, cwd: "/p", sessionId: "t", reportsDir: b.reportsDir, file: b.file }), []);
  assert.equal(existsSync(b.file), false);
  b.done();
});

test("a listing in tool output, or an earlier turn's reply, does not attribute", () => {
  const b = box();
  b.put("fresh.html", 1_000);
  const listing = [{ type: "tool_result", id: "1", content: "reports/fresh.html" }];
  assert.deepEqual(reportsWrittenInTurn({ history: turn(...listing), turnStartedAt, reportsDir: b.reportsDir }), []);
  const earlier = [{ type: "text_done", text: "see reports/fresh.html" }, ...turn({ type: "text_done", text: "done" })];
  assert.deepEqual(reportsWrittenInTurn({ history: earlier, turnStartedAt, reportsDir: b.reportsDir }), []);
  b.done();
});

test("a message sent while the agent works does not cut the turn short", () => {
  const b = box();
  b.put("fresh.html", 1_000);
  const history = turn(
    { type: "text_done", text: "Writing reports/fresh.html now." },
    { type: "user_message", content: "also add a chart" },
    { type: "text_done", text: "Chart added." },
  );
  assert.deepEqual(reportsWrittenInTurn({ history, turnStartedAt, reportsDir: b.reportsDir }), ["fresh.html"]);
  b.done();
});

test("a named file that does not exist, or a missing turn start, records nothing", () => {
  const b = box();
  const history = turn({ type: "text_done", text: "reports/ghost.html" });
  assert.deepEqual(reportsWrittenInTurn({ history, turnStartedAt, reportsDir: b.reportsDir }), []);
  b.put("fresh.html", 1_000);
  assert.deepEqual(reportsWrittenInTurn({ history: turn({ type: "text_done", text: "reports/fresh.html" }), turnStartedAt: 0, reportsDir: b.reportsDir }), []);
  b.done();
});

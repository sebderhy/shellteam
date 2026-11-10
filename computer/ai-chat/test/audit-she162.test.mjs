/**
 * SHE-162 (audit 2026-11-10): the cockpit could be framed by any page, one
 * GET ended the process, and the link filter and box-report match were loose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { frameAncestors } from "../lib/request-gate.mjs";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const app = read("../public/app.js");
const server = read("../server.mjs");

test("only the dashboard may frame the cockpit", () => {
  const saved = { ...process.env };
  try {
    process.env.APP_DOMAIN = "box.example.com";
    delete process.env.EXTRA_MAIN_HOSTS;
    // Behind the proxy the Host is loopback.
    const proxied = frameAncestors("127.0.0.1:3456", 8000);
    assert.ok(proxied.includes("https://box.example.com"));
    assert.ok(!proxied.some((s) => s.includes("*")), "no wildcard source");
    assert.ok(!proxied.some((s) => /owner-3000|:3000/.test(s)), "a sibling app is not listed");

    process.env.APP_DOMAIN = "localhost";
    const local = frameAncestors("localhost:3456", 8000);
    assert.ok(local.includes("http://localhost:8000"));
    assert.ok(!local.includes("http://localhost:3000"));
  } finally {
    process.env = saved;
  }
  assert.match(server, /"Content-Security-Policy": `frame-ancestors /);
});

test("a message from a page that framed the cockpit is ignored", () => {
  const m = app.match(/window\.addEventListener\('message', \(e\) => \{[\s\S]*?report-comment[\s\S]*?\}\);/);
  assert.ok(m, "the dashboard message handler must exist");
  assert.match(m[0], /e\.origin !== fileBaseUrl\(\)/);
});

test("agent links go to the web, mail, or a path: nothing else", () => {
  const m = app.match(/function isSafeLinkHref\(href\) \{[\s\S]*?\n\}/);
  assert.ok(m, "isSafeLinkHref must exist");
  const isSafe = vm.runInNewContext(`(${m[0]})`);
  for (const bad of ["javascript:alert(1)", "java\tscript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "jav\nascript:x"]) {
    assert.equal(isSafe(bad), false, JSON.stringify(bad));
  }
  for (const ok of ["https://example.com", "http://example.com/a?b=1", "mailto:a@example.com", "/reports/x.html", "./notes.md", "#top", "reports/a.html"]) {
    assert.equal(isSafe(ok), true, ok);
  }
});

test("another box under the same parent domain is not this box's report", () => {
  const start = app.indexOf("const ReportPanel = {");
  const end = app.indexOf("\n};", start);
  const hostname = "you-3456.you.shellteam.sh";
  const ctx = { URL, console, window: {}, location: { hostname, origin: `https://${hostname}`, href: `https://${hostname}/` } };
  vm.createContext(ctx);
  const rp = vm.runInContext(app.slice(start, end + 3) + "\nReportPanel;", ctx);
  assert.equal(rp.isBoxReport("https://you.shellteam.sh/reports/a.html"), true);
  assert.equal(rp.isBoxReport("https://other.shellteam.sh/reports/a.html"), false);
  assert.equal(rp.isBoxReport("https://shellteam.sh/evil.html"), false);
});

test("a request that throws answers 500 instead of ending the process", () => {
  assert.match(server, /createServer\(\(req, res\) => \{\s*try \{\s*handleRequest\(req, res\);/);
  // A directory under public/ (GET /vendor) is not a file to read.
  assert.match(server, /!existsSync\(fullPath\) \|\| !statSync\(fullPath\)\.isFile\(\)/);
  // Non-Latin-1 folder names in a header threw.
  assert.ok(!server.includes('filename="${name}.zip"'));
});

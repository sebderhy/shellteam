// The side panel opened only for links ending in .html. An agent that serves
// an app on a port and hands back `https://kahava.<APP_DOMAIN>` (a named
// route) or `https://owner-3000.<APP_DOMAIN>/` left the panel shut, although
// that page is exactly what the user wants to see next to the chat. The panel
// must open for apps on this box, and must still ignore assets, the cockpit
// itself, the dashboard, and the outside internet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const appSrc = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

function reportPanelAt(hostname) {
  const start = appSrc.indexOf("const ReportPanel = {");
  const end = appSrc.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "ReportPanel object must exist in app.js");
  const src = appSrc.slice(start, end + 3) + "\nReportPanel;";
  const context = { URL, console, window: {}, location: { hostname, origin: `https://${hostname}`, href: `https://${hostname}/` } };
  vm.createContext(context);
  return vm.runInContext(src, context);
}

test("app routes on this box open in the panel: named routes and owner-<port> hosts", () => {
  const rp = reportPanelAt("you-3456.you.shellteam.sh");
  for (const href of [
    "https://kahava.you.shellteam.sh",
    "https://kahava.you.shellteam.sh/",
    "https://kahava.you.shellteam.sh/menu",
    "https://you-3000.you.shellteam.sh/",
    "https://you-3000.you.shellteam.sh/index.html",
  ]) assert.equal(rp.isBoxReport(href), true, href);
});

test("assets, the cockpit, the dashboard and other sites stay out of the panel", () => {
  const rp = reportPanelAt("you-3456.you.shellteam.sh");
  for (const href of [
    "https://kahava.you.shellteam.sh/logo.png",
    "https://kahava.you.shellteam.sh/api/data.json",
    "https://you-3456.you.shellteam.sh/",
    "https://you.shellteam.sh/",
    "https://you.shellteam.sh/apps",
    "https://shellteam.sh/",
    "https://github.com/sebderhy/shellteam",
  ]) assert.equal(rp.isBoxReport(href), false, href);
});

test("HTML reports on the file host still open, unchanged", () => {
  const rp = reportPanelAt("you-3456.you.shellteam.sh");
  assert.equal(rp.isBoxReport("https://you.shellteam.sh/reports/landscape.html"), true);
  assert.equal(rp.isBoxReport("https://you.you.shellteam.sh/reports/landscape.html"), true);
  assert.equal(rp.isBoxReport("https://you.shellteam.sh/reports/notes.md"), false);
});

test("laptop install: <name>.localhost apps open, localhost:3456 itself does not", () => {
  const rp = reportPanelAt("localhost");
  const local = { hostname: "localhost", origin: "http://localhost:3456", href: "http://localhost:3456/" };
  const start = appSrc.indexOf("const ReportPanel = {");
  const end = appSrc.indexOf("\n};", start);
  const context = { URL, console, window: {}, location: local };
  vm.createContext(context);
  const lp = vm.runInContext(appSrc.slice(start, end + 3) + "\nReportPanel;", context);
  assert.equal(lp.isBoxReport("http://kahava.localhost/"), true);
  assert.equal(lp.isBoxReport("http://localhost:3456/"), false);
  assert.equal(rp.isBoxReport("http://localhost/reports/x.html"), true);
});

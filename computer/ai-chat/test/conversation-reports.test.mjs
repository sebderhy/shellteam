// The side panel is closed most of the time; it opens on its own only when a
// live reply links a report. A report linked earlier in the conversation was
// reachable only by scrolling back to find its link. The header now carries a
// count button (Alt+R) listing every report and app this tab linked, newest
// first; picking one opens it in the panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const appSrc = read("../public/app.js");
const html = read("../public/index.html");
const dropdownSrc = read("../public/dropdown.js");

function reportPanel() {
  const start = appSrc.indexOf("const ReportPanel = {");
  const end = appSrc.indexOf("\n};", start);
  const host = "you-3456.you.shellteam.sh";
  const context = { URL, console, window: {}, location: { hostname: host, host, origin: `https://${host}`, href: `https://${host}/` } };
  vm.createContext(context);
  return vm.runInContext(appSrc.slice(start, end + 3) + "\nReportPanel;", context);
}
const conversation = (...hrefs) => ({ querySelectorAll: () => hrefs.map((href) => ({ href, dataset: {} })) });

test("lists each report and app the conversation linked once, at its latest mention", () => {
  const rp = reportPanel();
  const list = rp.listIn(conversation(
    "https://you.shellteam.sh/reports/pricing.html",
    "https://github.com/sebderhy/shellteam",          // not on this box
    "https://you.shellteam.sh/tmp/chart.png",          // an asset, not a report
    "https://kahava.you.shellteam.sh/",
    "https://you.shellteam.sh/reports/competitors%20map.html",
    "https://you.shellteam.sh/reports/pricing.html",   // linked again
  ));
  assert.deepEqual(JSON.parse(JSON.stringify(list.map((r) => [r.name, r.where]))), [
    ["kahava.you.shellteam.sh", "kahava.you.shellteam.sh"],
    ["competitors map.html", "reports"],
    ["pricing.html", "reports"],
  ]);
});

test("a conversation without report links lists nothing", () => {
  assert.equal(reportPanel().listIn(conversation("https://example.com/a.html")).length, 0);
});

test("the header button starts hidden, opens its menu, and has a shortcut", () => {
  assert.match(html, /<div class="hdr-group" id="reportsGroup" hidden>/);
  assert.match(html, /onclick="Menus\.toggle\('reportsMenu'\)"/);
  assert.match(html, /id="reportsMenu" role="menu"/);
  assert.match(dropdownSrc, /id === 'reportsMenu' && typeof renderReportsMenu === 'function'\) renderReportsMenu\(\)/);
  assert.match(appSrc, /e\.code === 'KeyR' && !document\.getElementById\('reportsGroup'\)\.hidden/);
  assert.match(appSrc, /\['Alt\+R', /, "the ? cheat sheet lists it");
  assert.match(appSrc, /new MutationObserver\([\s\S]*?refreshReportsButton\(\)[\s\S]*?\.observe\(E\.messages, \{ childList: true, subtree: true \}\)/);
});

test("phones get the list from the AI menu: the header has no room for another button", () => {
  const css = read("../public/styles.css");
  assert.match(html, /id="aiMenuReportsItem" data-key="p" onclick="Menus\.toggle\('reportsMenu'\)" hidden>/);
  assert.match(appSrc, /getElementById\('aiMenuReportsItem'\)\.hidden = n === 0/);
  assert.match(css, /\.ai-menu-reports \{ display: none; \}/, "desktop shows the header button instead");
  const phone = css.slice(css.indexOf("@media (max-width: 480px)"));
  assert.match(phone, /#btnReports \{ display: none; \}/);
  assert.match(phone, /#reportsGroup \{ position: absolute; \}/, "a hidden button must not keep its flex gap");
  assert.match(phone, /\.ai-menu-reports:not\(\[hidden\]\) \{ display: flex; \}/);
});

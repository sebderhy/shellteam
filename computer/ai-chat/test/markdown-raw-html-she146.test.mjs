/**
 * SHE-146: raw HTML in agent markdown is shown as text. An agent echoing a
 * prompt-injected page (`<img onerror>`, `<details ontoggle>`) ran script in
 * the cockpit origin, which can open the shell socket.
 * Runs the renderer app.js installs against the real vendored marked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "public/app.js"), "utf8");

function loadHtmlRenderer() {
  const m = app.match(/\n        html\(\{ text \}\) \{\n([\s\S]*?)\n        \},\n/);
  assert.ok(m, "app.js must define the raw-HTML renderer html({ text })");
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return new Function("escHtml", `return function html({ text }) {${m[1]}\n}`)(escHtml);
}

test("inline and block HTML from an agent never becomes markup", async () => {
  await import("../public/vendor/marked-15.0.6.min.js");
  const marked = globalThis.marked;
  marked.use({ gfm: true, renderer: { html: loadHtmlRenderer() } });
  for (const evil of [
    'summary <img src=x onerror="alert(document.domain)">',
    "<details open ontoggle=alert(1)>x</details>",
    "<script>alert(1)</script>",
    '<iframe src="javascript:alert(1)"></iframe>',
  ]) {
    const html = marked.parse(evil);
    assert.doesNotMatch(html, /<(img|details|script|iframe)\b/i, evil);
  }
  assert.match(marked.parse("**bold** text"), /<strong>bold<\/strong>/);
});

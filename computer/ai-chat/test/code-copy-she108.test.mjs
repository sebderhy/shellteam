/**
 * SHE-108 — "text within triple backticks should be copy pastable".
 *
 * Agents hand back posts, commands and snippets in ``` fences, and selecting
 * a <pre> by hand on a phone is hopeless. The cockpit's marked renderer wraps
 * every fenced block with a Copy button; a delegated click handler on
 * #messages copies the block's text (clipboard API, with a selection fallback
 * for plain-http boxes where navigator.clipboard does not exist).
 *
 * The renderer runs against the real vendored marked so a marked upgrade that
 * changes the `code` token contract is caught; the rest are wiring pins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "public/app.js"), "utf8");
const css = readFileSync(join(root, "public/styles.css"), "utf8");

// The exact renderer app.js installs (app.js is a browser script; the test
// lifts the function body from source so it cannot drift silently).
function loadRenderer() {
  const m = app.match(/\n        code\(\{ text, lang \}\) \{\n([\s\S]*?)\n        \},\n/);
  assert.ok(m, "app.js must define the fenced-code renderer code({ text, lang })");
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return new Function("escHtml", `return function code({ text, lang }) {${m[1]}\n}`)(escHtml);
}

test("a fenced block renders as marked's <pre><code> plus a Copy button", async () => {
  await import("../public/vendor/marked-15.0.6.min.js");
  const marked = globalThis.marked;
  marked.use({ gfm: true, renderer: { code: loadRenderer() } });

  const html = marked.parse("```bash\nls -la ~/tmp\n```");
  assert.match(html, /<div class="code-block"><button type="button" class="code-copy"[^>]*>Copy<\/button><pre><code class="language-bash">ls -la ~\/tmp\n<\/code><\/pre><\/div>/);
});

test("code text is HTML-escaped and the language never injects markup", async () => {
  await import("../public/vendor/marked-15.0.6.min.js");
  const marked = globalThis.marked;
  marked.use({ gfm: true, renderer: { code: loadRenderer() } });

  const html = marked.parse('```js"><script>\n<img src=x onerror=alert(1)>\n```');
  assert.ok(!html.includes("<script>"), "language must be escaped");
  assert.ok(!html.includes("<img"), "code body must be escaped");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("a fence without a language gets a bare <code>", async () => {
  await import("../public/vendor/marked-15.0.6.min.js");
  const marked = globalThis.marked;
  marked.use({ gfm: true, renderer: { code: loadRenderer() } });
  assert.match(marked.parse("```\nplain\n```"), /<pre><code>plain\n<\/code><\/pre>/);
});

test("the copy click is delegated on #messages and strips marked's trailing newline", () => {
  const handler = app.match(/E\.messages\?\.addEventListener\('click', async \(e\) => \{\n([\s\S]*?)\n\}\);/);
  assert.ok(handler, "delegated .code-copy click handler missing");
  assert.match(handler[1], /closest\('\.code-copy'\)/);
  assert.match(handler[1], /querySelector\('pre'\)/, "copies the sibling <pre>'s text");
  assert.match(handler[1], /replace\(\/\\n\$\/, ''\)/, "drops the newline marked appends to a fence");
  assert.match(handler[1], /copyToClipboard\(/);
});

test("copyToClipboard falls back to execCommand when navigator.clipboard is absent", () => {
  const fn = app.match(/async function copyToClipboard\(text\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, "copyToClipboard missing");
  assert.match(fn[1], /navigator\.clipboard\?\.writeText/);
  assert.match(fn[1], /document\.execCommand\('copy'\)/);
});

test("the button is styled and always visible (no hover-only reveal — phones have no hover)", () => {
  assert.match(css, /\.code-block \{ position: relative; \}/);
  const rule = css.match(/\.code-copy \{[^}]*\}/);
  assert.ok(rule, ".code-copy rule missing");
  assert.match(rule[0], /position: absolute/);
  assert.ok(!/\.code-copy \{[^}]*opacity: 0/.test(css), "must not hide the button until hover");
});

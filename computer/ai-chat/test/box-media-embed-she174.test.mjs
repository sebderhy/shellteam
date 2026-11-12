/**
 * SHE-174: "I almost never see ST embedding images or an audio player within
 * its conversation, although it often writes URLs pointing to those files."
 * A link to a picture, sound or clip on the box shows the file under the link.
 * Runs the function app.js defines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "public/app.js"), "utf8");

function load() {
  const grab = (re, what) => { const m = app.match(re); assert.ok(m, `app.js must define ${what}`); return m[0]; };
  const src = [
    grab(/const AUDIO_EXT_RE = .*;/, "AUDIO_EXT_RE"),
    grab(/const IMAGE_EXT_RE = .*;/, "IMAGE_EXT_RE"),
    grab(/const VIDEO_EXT_RE = .*;/, "VIDEO_EXT_RE"),
    grab(/function boxMediaEmbed\(href\) \{[\s\S]*?\n\}/, "boxMediaEmbed"),
  ].join("\n");
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return new Function("escHtml", "fileBaseUrl", `${src}\nreturn boxMediaEmbed;`)(escHtml, () => "https://box.example.com");
}

test("a link to a file on the box shows the picture, the player or the clip", () => {
  const embed = load();
  assert.match(embed("https://box.example.com/tmp/chart.png"), /^<img class="agent-shot" src="https:\/\/box\.example\.com\/tmp\/chart\.png"/);
  assert.match(embed("https://box.example.com/reports/brief.mp3"), /^<audio controls/);
  assert.match(embed("https://box.example.com/tmp/demo.mp4?v=2"), /^<video class="agent-clip" controls/);
});

test("anything else stays a plain link", () => {
  const embed = load();
  assert.equal(embed("https://evil.example.org/pixel.png?secret=1"), "", "an outside image never loads on its own");
  assert.equal(embed("https://box.example.com.evil.org/a.png"), "");
  assert.equal(embed("https://box.example.com/reports/page.html"), "");
  assert.equal(embed("https://box.example.com/_editor/tmp/chart.png"), "");
  assert.equal(embed("not a url"), "");
});

test("the address cannot break out of the attribute", () => {
  const html = load()('https://box.example.com/a".png');
  assert.doesNotMatch(html, /src="[^"]*"[^ >]/);
});

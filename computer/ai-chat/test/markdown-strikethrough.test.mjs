// Regression test for SHE-51: single-tilde strikethrough mangled agent prose.
//
// marked's GFM default strikes a SINGLE ~…~, so text like "~80 lines … under
// ~/.shellteam/" rendered as one struck-out run. The cockpit overrides the `del`
// tokenizer to require ~~double~~ tildes. This test pins both that the override
// is still wired into app.js and that it behaves (against the real vendored
// marked, so a marked upgrade that changes the tokenizer contract is caught).
//
// Run: node --test computer/ai-chat/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appSrc = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

test("app.js wires a double-tilde-only del tokenizer (SHE-51)", () => {
  assert.match(appSrc, /tokenizer:\s*\{[\s\S]*del\(src\)/,
    "app.js must override the del tokenizer to require ~~double~~ tildes");
});

test("the del tokenizer strikes ~~double~~ but leaves single ~ prose intact", async () => {
  await import("../public/vendor/marked-15.0.6.min.js");
  const marked = globalThis.marked;
  // The exact override app.js installs.
  marked.use({ breaks: true, gfm: true, tokenizer: {
    del(src) {
      const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
      if (!m) return;
      return { type: "del", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
    },
  }});

  const prose = marked.parseInline("under ~80 lines, writes only under ~/.shellteam/ and ~/projects");
  assert.ok(!prose.includes("<del>"), "single tildes in prose must not strike");
  assert.ok(prose.includes("~80") && prose.includes("~/.shellteam/"), "the text is preserved verbatim");

  const struck = marked.parseInline("this ~~is struck~~ though");
  assert.match(struck, /<del>is struck<\/del>/, "double tildes still strike through");
});

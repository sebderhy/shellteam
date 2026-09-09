/**
 * The mechanical half of audio replies: what actually reaches the ear.
 *
 * These are contract tests for a money-spending transform. Every case is
 * something an agent really emits — the point is that a reply written for the
 * eye still becomes something worth hearing, and that nothing which reads as
 * noise ("backtick slash home slash seb…") survives into synthesis.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { speakable, MAX_SPOKEN_CHARS } from "../../shared/speakable.mjs";

test("plain prose passes through untouched", () => {
  const { text, truncated } = speakable("The API is healthy. I restarted it.");
  assert.equal(text, "The API is healthy. I restarted it.");
  assert.equal(truncated, false);
});

test("fenced code blocks are dropped, not read aloud", () => {
  const { text } = speakable("Run this:\n\n```bash\nsystemctl --user restart shellteam-api\n```\n\nThen check it.");
  assert.equal(text, "Run this: Then check it.");
});

test("an unterminated code fence does not leak into speech", () => {
  const { text } = speakable("Here it is:\n\n```python\ndef f():\n    return 1");
  assert.equal(text, "Here it is:");
});

test("markdown tables are dropped whole", () => {
  const { text } = speakable("Results:\n\n| Gate | State |\n|---|---|\n| CI | green |\n\nAll good.");
  assert.equal(text, "Results: All good.");
});

test("link text is spoken, the URL is not", () => {
  const { text } = speakable("See [the report](https://example.com/reports/x.html) for details.");
  assert.equal(text, "See the report for details.");
});

test("bare URLs are dropped so the ear never hears h-t-t-p-s", () => {
  const { text } = speakable("It is live at https://example.com/tmp/a.html now.");
  assert.ok(!text.includes("http"), text);
  assert.ok(text.startsWith("It is live at"), text);
});

test("inline code keeps a word but drops a path", () => {
  assert.equal(speakable("Run `pytest` first.").text, "Run pytest first.");
  assert.ok(!speakable("Edit `api/services/tts.py` now.").text.includes("api"));
});

test("headings and bullets become sentences instead of running together", () => {
  const { text } = speakable("## What I did\n\n- Merged the PR\n- Restarted the API\n");
  assert.equal(text, "What I did. Merged the PR. Restarted the API.");
});

test("emphasis markers are stripped without eating snake_case", () => {
  const { text } = speakable("This is **important** and touches OWNER_TOKEN.");
  assert.equal(text, "This is important and touches OWNER_TOKEN.");
});

test("a reply that is nothing but code yields no text, so nothing is synthesised", () => {
  const { text } = speakable("```js\nconst a = 1;\n```");
  assert.equal(text, "");
});

test("empty and nullish input are safe", () => {
  assert.equal(speakable("").text, "");
  assert.equal(speakable(null).text, "");
  assert.equal(speakable(undefined).text, "");
});

test("a long reply is trimmed at a sentence boundary and flagged", () => {
  const sentence = "This is a sentence about the deploy. ";
  const { text, truncated } = speakable(sentence.repeat(200));
  assert.equal(truncated, true);
  assert.ok(text.length <= MAX_SPOKEN_CHARS, `${text.length} > ${MAX_SPOKEN_CHARS}`);
  assert.ok(text.endsWith("."), text.slice(-40));
});

test("a reply just under the limit is not flagged", () => {
  const { truncated } = speakable("a".repeat(MAX_SPOKEN_CHARS - 1));
  assert.equal(truncated, false);
});

test("the whole markdown vocabulary of a real reply survives as prose", () => {
  const reply = [
    "# Done",
    "",
    "I merged [PR #68](https://github.com/sebderhy/shellteam/pull/68) and restarted the API.",
    "",
    "| Service | State |",
    "|---|---|",
    "| api | healthy |",
    "",
    "```bash",
    "systemctl --user restart shellteam-api",
    "```",
    "",
    "> Note: the cockpit is still stale.",
    "",
    "1. Check `journalctl`",
    "2. Reload the page",
    "",
    "---",
    "",
    "That is **everything**.",
  ].join("\n");
  const { text } = speakable(reply);
  assert.equal(
    text,
    "Done. I merged PR #68 and restarted the API. Note: the cockpit is still stale. " +
      "Check journalctl. Reload the page. That is everything.",
  );
});
